'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runMigrations } = require('../db/migrate');
const {
    canonicalTeamName,
    inferSeasonName,
    splitPlayerName
} = require('../db/import-score-csv');
const { parseScheduleCsv } = require('../db/backfill-schedule');
const { validateBrowserSubmission } = require('../db/import-browser-submission');
const {
    parseTeamListCsv,
    workbookGenderForPlayer,
    genderForTeamListPlayer
} = require('../db/backfill-team-list-rosters');
const { buildBackupFilename } = require('../db/backup');
const { parseRestoreArguments } = require('../db/restore');
const { normalizeUploadedBackupFilename } = require('../db/backup');
const { createPool } = require('../db/connection');
const { normalizeBrowserSubmission } = require('../db/import-browser-submission');

test('core league migration contains no destructive table drops', () => {
    const migrationPath = path.join(__dirname, '../migrations/001_core_league_schema.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    assert.doesNotMatch(sql, /\bDROP\s+(TABLE|SCHEMA)\b/i);
    for (const table of [
        'season', 'team', 'player', 'team_roster', 'fixture',
        'match_game', 'team_game', 'game_player_score',
        'game_submission', 'turn_score', 'score_revision'
    ]) {
        assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
    }

    const baselinePath = path.join(__dirname, '../migrations/002_season_stat_baselines.sql');
    const baselineSql = fs.readFileSync(baselinePath, 'utf8');
    assert.doesNotMatch(baselineSql, /\bDROP\s+(TABLE|SCHEMA)\b/i);
    assert.match(baselineSql, /baseline_through_week/);
    assert.match(baselineSql, /CREATE TABLE IF NOT EXISTS player_season_baseline/);
    assert.match(baselineSql, /CREATE TABLE IF NOT EXISTS team_season_baseline/);
});

test('migration runner applies a new migration once in a transaction', async () => {
    const temporaryDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), '701-migrations-'));
    const migrationName = '001_test.sql';
    fs.writeFileSync(path.join(temporaryDir, migrationName), 'CREATE TABLE test_migration (id INTEGER);');

    const applied = new Set();
    const queries = [];
    const pool = {
        async query(sql, values) {
            queries.push({ sql: String(sql), values });
            if (/SELECT version FROM schema_migrations/.test(sql)) {
                return { rows: [...applied].map(version => ({ version })) };
            }
            if (/INSERT INTO schema_migrations/.test(sql)) {
                applied.add(values[0]);
            }
            return { rows: [] };
        }
    };

    try {
        const first = await runMigrations(pool, temporaryDir);
        const second = await runMigrations(pool, temporaryDir);

        assert.deepEqual(first, [migrationName]);
        assert.deepEqual(second, [migrationName]);
        assert.equal(queries.filter(query => query.sql === 'BEGIN').length, 1);
        assert.equal(queries.filter(query => query.sql === 'COMMIT').length, 1);
        assert.equal(
            queries.filter(query => query.sql.includes('CREATE TABLE test_migration')).length,
            1
        );
    } finally {
        fs.rmSync(temporaryDir, { recursive: true, force: true });
    }
});

test('normalizes team, player, and season names from score data', () => {
    assert.equal(canonicalTeamName('The Keepers (8)'), 'The Keepers');
    assert.equal(canonicalTeamName('Just the Tip!'), 'Just The Tip');
    assert.equal(canonicalTeamName('Jug  Zone (1)'), 'Jug Zone');
    assert.deepEqual(splitPlayerName('Paul Laprade'), {
        firstName: 'Paul',
        lastName: 'Laprade'
    });
    assert.deepEqual(splitPlayerName('Spare'), {
        firstName: 'Spare',
        lastName: ''
    });
    assert.equal(inferSeasonName('2026-11-18'), '2026-2027');
    assert.equal(inferSeasonName('2027-02-18'), '2026-2027');
});

test('parses the league schedule into fixture rows', () => {
    const schedule = parseScheduleCsv([
        'date,board,team_1,team_2',
        '2026-09-16,1,Unemployed Pornstars (7),Avengers (5)'
    ].join('\n'));
    assert.deepEqual(schedule, [{
        date: '2026-09-16',
        board: '1',
        team1: 'Unemployed Pornstars (7)',
        team2: 'Avengers (5)'
    }]);
});

test('uses team_lists names and workbook gender flags', () => {
    const csv = [
        'Team Name, First Name, Last Name, email',
        'The Marksmen, Sue, , sue@example.com',
        'The Keepers, Kari, Burton,'
    ].join('\n');
    assert.deepEqual(parseTeamListCsv(csv), [
        { teamName: 'The Marksmen', firstName: 'Sue', lastName: '', email: 'sue@example.com' },
        { teamName: 'The Keepers', firstName: 'Kari', lastName: 'Burton', email: '' }
    ]);
    assert.equal(workbookGenderForPlayer([
        { name: 'Sue', gender: 'F' },
        { name: 'Kari', gender: 'F' }
    ], 'Kari'), 'F');
    assert.equal(genderForTeamListPlayer([], 'Terry'), 'M');
});

test('validates normalized browser submission payloads', () => {
    const payload = {
        matchDate: '2026-11-18',
        board: '3',
        team: 'The Keepers',
        opponent: 'The Snipers',
        games: [{
            game: 1,
            winner: 'The Keepers',
            players: [{ name: 'Paul' }, { name: 'Kari' }],
            turns: [{
                player: 'Paul',
                score: 95,
                darts: [{ score: 95, label: '95' }],
                busted: false,
                remainingBefore: 701,
                remainingAfter: 606,
                checkoutRemaining: null
            }]
        }]
    };
    assert.deepEqual(validateBrowserSubmission(payload), payload);
    assert.throws(
        () => validateBrowserSubmission({
            ...payload,
            games: [{ ...payload.games[0], game: 8 }]
        }),
        /between 1 and 7/
    );
});

test('baseline cutoff logic protects all weeks through week 10', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const browserImporter = fs.readFileSync(
        path.join(__dirname, '../db/import-browser-submission.js'),
        'utf8'
    );
    const csvImporter = fs.readFileSync(
        path.join(__dirname, '../db/import-score-csv.js'),
        'utf8'
    );
    assert.match(browserImporter, /baseline_through_week/);
    assert.match(browserImporter, /preserved from the workbook/);
    assert.match(csvImporter, /baseline_through_week/);
    assert.match(csvImporter, /preserved from the workbook/);
    assert.match(browserImporter, /No scheduled match exists/);
    assert.match(csvImporter, /No scheduled match exists/);
});

test('Keepers duplicate merge is limited to Paul McMahon and Kari Burton', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const script = fs.readFileSync(
        path.join(__dirname, '../db/merge-keepers-player-duplicates.js'),
        'utf8'
    );
    assert.match(script, /canonicalLastName: 'McMahon'/);
    assert.match(script, /canonicalLastName: 'Burton'/);
    assert.doesNotMatch(script, /Laprade/);
});

test('accepted submissions only affect standings and match reports', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const server = fs.readFileSync(
        path.join(__dirname, '../server.js'),
        'utf8'
    );
    assert.match(server, /JOIN game_submission gs ON gs\.match_game_id = mg\.id[\s\S]*?gs\.status = 'accepted'/);
    assert.match(server, /WHERE pt\.gender = \$2[\s\S]*?reportFilter/);
});

test('stat leader reports do not apply a row limit', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const server = fs.readFileSync(
        path.join(__dirname, '../server.js'),
        'utf8'
    );
    assert.doesNotMatch(
        server,
        /const limit = \['mens-avg'[\s\S]*?LIMIT \$3/
    );
    assert.match(server, /ORDER BY \$\{orderBy\}/);
});

test('backup filenames are deterministic and restore confirmation is explicit', () => {
    const now = new Date('2026-11-21T17:30:00.000Z');
    const filename = buildBackupFilename(now, 'C:\\backups');
    assert.match(filename, /league-2026-11-21T17-30-00\.dump$/);

    assert.deepEqual(
        parseRestoreArguments(['--file=C:\\backups\\league.dump']),
        { backupFile: 'C:\\backups\\league.dump', confirmed: false }
    );
    assert.deepEqual(
        parseRestoreArguments([
            '--confirm=RESTORE',
            '--file=C:\\backups\\league.dump'
        ]),
        { backupFile: 'C:\\backups\\league.dump', confirmed: true }
    );

    const uploadedName = normalizeUploadedBackupFilename(
        'C:\\backups\\old database.dump',
        now
    );
    assert.match(uploadedName, /^league-upload-.*old-database\.dump$/);
});

test('restore implementation captures missing-tool and pg_restore stderr details', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const restoreSource = fs.readFileSync(
        path.join(__dirname, '../db/restore.js'),
        'utf8'
    );
    assert.match(restoreSource, /not available on PATH/);
    assert.match(restoreSource, /result\.stderr/);
    assert.match(restoreSource, /pg_restore failed with exit code/);
});

test('Gerald is the Aimless Wonders canonical player name', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const importer = fs.readFileSync(
        path.join(__dirname, '../db/import-workbook-baselines.js'),
        'utf8'
    );
    assert.match(importer, /'Aimless Wonders': \{ Gerry: 'Gerald' \}/);
});

test('general player merge requires two distinct IDs', async () => {
    const { mergePlayerRecords } = require('../db/merge-player-records');
    await assert.rejects(
        mergePlayerRecords({
            query: async () => ({ rows: [] })
        }, 99, 99),
        /must be different/
    );
});

test('post-week-10 browser submission updates baseline-plus-future stats and is reversible', {
    skip: !process.env.DATABASE_URL
}, async () => {
    const pool = createPool();
    const sourceKey = '2026-11-25|1|The Keepers|7';
    let submittedMatchGameId = null;

    try {
        const playerResult = await pool.query(
            `SELECT p.id, tr.team_id
             FROM player p
             JOIN team_roster tr ON tr.player_id = p.id
             JOIN team t ON t.id = tr.team_id
             WHERE tr.season_id = (SELECT id FROM season WHERE active = TRUE LIMIT 1)
               AND t.name = 'The Keepers'
               AND lower(p.first_name) = 'paul'
               AND lower(COALESCE(p.last_name, '')) = 'mcmahon'
             LIMIT 1`
        );
        assert.equal(playerResult.rows.length, 1, 'Paul McMahon on The Keepers must exist');
        const playerId = playerResult.rows[0].id;
        const teamId = playerResult.rows[0].team_id;

        const fixtureResult = await pool.query(
            `SELECT f.id, f.season_id, f.week_number,
                    ht.name AS home_team, at.name AS away_team
             FROM fixture f
             JOIN team ht ON ht.id = f.home_team_id
             JOIN team at ON at.id = f.away_team_id
             WHERE f.match_date = '2026-11-25'::DATE
               AND f.board_number = '1'
               AND f.season_id = (SELECT id FROM season WHERE active = TRUE LIMIT 1)
               AND (
                    (ht.name = 'The Keepers' AND at.name = 'Killer Bees')
                 OR (at.name = 'The Keepers' AND ht.name = 'Killer Bees')
               )
             LIMIT 1`
        );
        assert.equal(fixtureResult.rows.length, 1, 'Week 11 fixture must exist');
        assert.ok(fixtureResult.rows[0].week_number > 10);

        const existingGame = await pool.query(
            'SELECT id FROM match_game WHERE fixture_id = $1 AND game_number = 7',
            [fixtureResult.rows[0].id]
        );
        assert.equal(existingGame.rows.length, 0, 'Live test game 7 must be unused');

        const baseline = await pool.query(
            `SELECT baseline_games, baseline_shots, baseline_score,
                    baseline_ninetyfive_plus, baseline_outs
             FROM player_season_baseline
             WHERE season_id = $1
               AND team_id = $2
               AND player_id = $3`,
            [fixtureResult.rows[0].season_id, teamId, playerId]
        );
        assert.equal(baseline.rows.length, 1);

        const teamBaseline = await pool.query(
            `SELECT baseline_wins, baseline_losses,
                    baseline_shots, baseline_score
             FROM team_season_baseline
             WHERE season_id = $1
               AND team_id = $2`,
            [fixtureResult.rows[0].season_id, teamId]
        );
        assert.equal(teamBaseline.rows.length, 1);

        const beforeFuture = await pool.query(
            `SELECT
                COUNT(DISTINCT ts.match_game_id)::INT AS gp,
                COUNT(ts.id)::INT AS shots,
                COALESCE(SUM(ts.score), 0)::INT AS score,
                COUNT(*) FILTER (WHERE ts.score >= 95)::INT AS ninetyfive_plus
             FROM turn_score ts
             JOIN game_submission gs ON gs.id = ts.submission_id
             JOIN match_game mg ON mg.id = ts.match_game_id
             JOIN fixture f ON f.id = mg.fixture_id
             WHERE gs.status = 'accepted'
               AND f.season_id = $1
               AND COALESCE(f.week_number, 999) > 10
               AND ts.player_id = $2`,
            [fixtureResult.rows[0].season_id, playerId]
        );

        const beforeTeamFuture = await pool.query(
            `SELECT
                COUNT(*) FILTER (
                    WHERE mg.status = 'finished'
                      AND mg.winner_team_id = $2
                )::INT AS wins,
                COUNT(*) FILTER (
                    WHERE mg.status = 'finished'
                      AND mg.winner_team_id IS NOT NULL
                      AND mg.winner_team_id <> $2
                )::INT AS losses,
                COALESCE(SUM(ts.score), 0)::INT AS score,
                COUNT(ts.id)::INT AS shots
             FROM turn_score ts
             JOIN game_submission gs ON gs.id = ts.submission_id
             JOIN match_game mg ON mg.id = ts.match_game_id
             JOIN fixture f ON f.id = mg.fixture_id
             WHERE gs.status = 'accepted'
               AND f.season_id = $1
               AND COALESCE(f.week_number, 999) > 10
               AND ts.team_id = $2`,
            [fixtureResult.rows[0].season_id, teamId]
        );

        const payload = {
            matchDate: '2026-11-25',
            board: '1',
            team: 'The Keepers',
            opponent: 'Killer Bees',
            games: [{
                game: 7,
                winner: 'The Keepers',
                players: [{ name: 'Paul McMahon' }],
                turns: [{
                    player: 'Paul McMahon',
                    score: 95,
                    darts: [{ score: 95, label: '95' }],
                    busted: false,
                    remainingBefore: 701,
                    remainingAfter: 606,
                    checkoutRemaining: null
                }]
            }]
        };

        const submitted = await normalizeBrowserSubmission(
            pool,
            payload,
            '',
            1
        );
        assert.equal(submitted.gameCount, 1);
        assert.equal(submitted.rowCount, 1);

        const submittedGame = await pool.query(
            `SELECT mg.id
             FROM game_submission gs
             JOIN match_game mg ON mg.id = gs.match_game_id
             WHERE gs.source = 'browser'
               AND gs.source_key = $1`,
            [sourceKey]
        );
        assert.equal(submittedGame.rows.length, 1);
        submittedMatchGameId = submittedGame.rows[0].id;

        const afterFuture = await pool.query(
            `SELECT
                COUNT(DISTINCT ts.match_game_id)::INT AS gp,
                COUNT(ts.id)::INT AS shots,
                COALESCE(SUM(ts.score), 0)::INT AS score,
                COUNT(*) FILTER (WHERE ts.score >= 95)::INT AS ninetyfive_plus
             FROM turn_score ts
             JOIN game_submission gs ON gs.id = ts.submission_id
             JOIN match_game mg ON mg.id = ts.match_game_id
             JOIN fixture f ON f.id = mg.fixture_id
             WHERE gs.status = 'accepted'
               AND f.season_id = $1
               AND COALESCE(f.week_number, 999) > 10
               AND ts.player_id = $2`,
            [fixtureResult.rows[0].season_id, playerId]
        );

        const afterTeamFuture = await pool.query(
            `SELECT
                COUNT(*) FILTER (
                    WHERE mg.status = 'finished'
                      AND mg.winner_team_id = $2
                )::INT AS wins,
                COUNT(*) FILTER (
                    WHERE mg.status = 'finished'
                      AND mg.winner_team_id IS NOT NULL
                      AND mg.winner_team_id <> $2
                )::INT AS losses,
                COALESCE(SUM(ts.score), 0)::INT AS score,
                COUNT(ts.id)::INT AS shots
             FROM turn_score ts
             JOIN game_submission gs ON gs.id = ts.submission_id
             JOIN match_game mg ON mg.id = ts.match_game_id
             JOIN fixture f ON f.id = mg.fixture_id
             WHERE gs.status = 'accepted'
               AND f.season_id = $1
               AND COALESCE(f.week_number, 999) > 10
               AND ts.team_id = $2`,
            [fixtureResult.rows[0].season_id, teamId]
        );

        assert.equal(
            afterFuture.rows[0].shots,
            beforeFuture.rows[0].shots + 1
        );
        assert.equal(
            afterFuture.rows[0].score,
            beforeFuture.rows[0].score + 95
        );
        assert.equal(
            afterFuture.rows[0].ninetyfive_plus,
            beforeFuture.rows[0].ninetyfive_plus + 1
        );
        assert.equal(
            afterFuture.rows[0].gp,
            beforeFuture.rows[0].gp + 1
        );

        const baselineRow = baseline.rows[0];
        const combinedShots = Number(baselineRow.baseline_shots) + afterFuture.rows[0].shots;
        const combinedScore = Number(baselineRow.baseline_score) + afterFuture.rows[0].score;
        const combined95 = Number(baselineRow.baseline_ninetyfive_plus) + afterFuture.rows[0].ninetyfive_plus;
        assert.equal(combinedShots, Number(baselineRow.baseline_shots) + beforeFuture.rows[0].shots + 1);
        assert.equal(combinedScore, Number(baselineRow.baseline_score) + beforeFuture.rows[0].score + 95);
        assert.equal(combined95, Number(baselineRow.baseline_ninetyfive_plus) + beforeFuture.rows[0].ninetyfive_plus + 1);

        const teamBaselineRow = teamBaseline.rows[0];
        assert.equal(
            afterTeamFuture.rows[0].shots,
            beforeTeamFuture.rows[0].shots + 1
        );
        assert.equal(
            afterTeamFuture.rows[0].score,
            beforeTeamFuture.rows[0].score + 95
        );
        assert.equal(
            afterTeamFuture.rows[0].wins,
            beforeTeamFuture.rows[0].wins + 1
        );
        assert.equal(
            Number(teamBaselineRow.baseline_shots) + afterTeamFuture.rows[0].shots,
            Number(teamBaselineRow.baseline_shots) + beforeTeamFuture.rows[0].shots + 1
        );
        assert.equal(
            Number(teamBaselineRow.baseline_score) + afterTeamFuture.rows[0].score,
            Number(teamBaselineRow.baseline_score) + beforeTeamFuture.rows[0].score + 95
        );
    } finally {
        await pool.query(
            `DELETE FROM game_submission
             WHERE source = 'browser'
               AND source_key = $1`,
            [sourceKey]
        );
        if (submittedMatchGameId) {
            await pool.query(
                `DELETE FROM match_game mg
                 WHERE mg.id = $1
                   AND NOT EXISTS (
                       SELECT 1
                       FROM game_submission gs
                       WHERE gs.match_game_id = mg.id
                   )`,
                [submittedMatchGameId]
            );
        }
        await pool.query(
            `DELETE FROM score_csv_uploads
             WHERE match_date = '2026-11-25'::DATE
               AND board = '1'
               AND team = 'The Keepers'`,
            []
        );
        await pool.end();
    }
});
