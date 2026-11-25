'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
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
const {
    formatRestoreFailure,
    isExpectedExtensionOwnershipWarning,
    parseRestoreArguments
} = require('../db/restore');
const { normalizeUploadedBackupFilename } = require('../db/backup');
const { createPool } = require('../db/connection');
const { normalizeBrowserSubmission } = require('../db/import-browser-submission');
const { setSubmissionStatus } = require('../db/review-submission');
const { createServer } = require('../server');
const { mergePlayerRecords } = require('../db/merge-player-records');

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

test('honourable mention reports show player scores and overall reports include the count', () => {
    const fs = require('node:fs');
    const server = fs.readFileSync(
        path.join(__dirname, '../server.js'),
        'utf8'
    );
    const reportsScript = fs.readFileSync(
        path.join(__dirname, '../reports/reports.js'),
        'utf8'
    );
    const reportsHtml = fs.readFileSync(
        path.join(__dirname, '../reports/index.html'),
        'utf8'
    );

    assert.match(server, /COALESCE\(tr\.gender, p\.gender\) = 'M' AND ts\.score >= 171/);
    assert.match(server, /COALESCE\(tr\.gender, p\.gender\) = 'F' AND ts\.score >= 130/);
    assert.match(server, /ts\.score >= 171/);
    assert.match(server, /ts\.score >= 130/);
    assert.match(server, /gs\.status = 'accepted'/);
    assert.match(server, /mens-honourable/);
    assert.match(server, /lady-honourable/);
    assert.match(server, /SELECT player, team, score/);
    assert.match(reportsScript, /key: 'score', label: 'Score'/);
    assert.match(reportsScript, /key: 'HM', label: 'Hon\. Mentions'/);
    assert.match(reportsScript, /column\.numeric \? ' class="numeric"' : ''/);
    assert.match(reportsHtml, /data-category="honourable">Honourable Mentions/);
});

test('high finish reports list individual 50+ finishes', () => {
    const fs = require('node:fs');
    const server = fs.readFileSync(
        path.join(__dirname, '../server.js'),
        'utf8'
    );
    const reportsScript = fs.readFileSync(
        path.join(__dirname, '../reports/reports.js'),
        'utf8'
    );
    const reportsHtml = fs.readFileSync(
        path.join(__dirname, '../reports/index.html'),
        'utf8'
    );

    assert.match(server, /mens-finishes/);
    assert.match(server, /lady-finishes/);
    assert.match(server, /ts\.checkout_remaining = 0[\s\S]*?ts\.score >= 50/);
    assert.match(reportsScript, /key: 'score', label: 'Finish', numeric: true/);
    assert.match(reportsHtml, /data-category="finishes">High Finish \(50\+\)/);
});

test('Leaders page includes mens and ladies Honourable Mentions and High Finishes', () => {
    const fs = require('node:fs');
    const reportsScript = fs.readFileSync(
        path.join(__dirname, '../reports/reports.js'),
        'utf8'
    );

    assert.match(reportsScript, /\/api\/reports\/mens-honourable/);
    assert.match(reportsScript, /\/api\/reports\/lady-honourable/);
    assert.match(reportsScript, /\/api\/reports\/mens-finishes/);
    assert.match(reportsScript, /\/api\/reports\/lady-finishes/);
    assert.match(reportsScript, /title: 'Honourable Mentions'/);
    assert.match(reportsScript, /title: 'High Finish \(50\+\)'/);
    assert.match(reportsScript, /title: 'Most 95s or higher'/);
    assert.match(reportsScript, /slice\(0, 10\)/);
});

test('weekly high-finish imports read W1-W10 and rows 51-53', () => {
    const fs = require('node:fs');
    const importer = fs.readFileSync(
        path.join(__dirname, '../db/import-workbook-baselines.js'),
        'utf8'
    );
    assert.match(importer, /W1 - Team Master/);
    assert.match(importer, /for c in range\(1,s\.max_column\+1\)/);
    assert.match(importer, /count=s\.cell\(51,c\)\.value/);
    assert.match(importer, /score_count=int\(count\)/);
});

test('report loading ignores stale tab responses', () => {
    const fs = require('node:fs');
    const reportsScript = fs.readFileSync(
        path.join(__dirname, '../reports/reports.js'),
        'utf8'
    );
    assert.match(reportsScript, /reportLoadSequence/);
    assert.match(reportsScript, /loadSequence !== reportLoadSequence/);
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

    const warning = [
        'pg_restore: error: could not execute query: ERROR: must be owner of extension pg_stat_statements',
        'pg_restore: warning: errors ignored on restore: 2'
    ].join('\n');
    assert.equal(isExpectedExtensionOwnershipWarning(warning), true);
    assert.equal(formatRestoreFailure({
        status: 1,
        stderr: warning,
        stdout: ''
    }), null);
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

test('Ginger maps to Terry on the Avengers workbook roster', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const importer = fs.readFileSync(
        path.join(__dirname, '../db/import-workbook-baselines.js'),
        'utf8'
    );
    assert.match(importer, /'The Avengers': \{ Ginger: 'Terry' \}/);
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

test('match upload migration preserves existing accepted turns and permits competing turns', {
    skip: !process.env.TEST_DATABASE_URL
}, async () => {
    const testHost = new URL(process.env.TEST_DATABASE_URL).hostname;
    if (testHost.endsWith('.neon.tech') && testHost.includes('-pooler.')) {
        throw new Error('TEST_DATABASE_URL must use a direct, unpooled Neon connection.');
    }
    const databasePool = createPool(process.env.TEST_DATABASE_URL);
    const schema = `test_701_${randomUUID().replace(/-/g, '')}`;
    let client;
    let schemaCreated = false;
    try {
        client = await databasePool.connect();
        await client.query(`CREATE SCHEMA "${schema}"`);
        schemaCreated = true;
        await client.query(`SET search_path TO "${schema}"`);
        const files = fs.readdirSync(path.join(__dirname, '../migrations'))
            .filter(name => /^00[1-6]_.*\.sql$/.test(name))
            .sort();
        for (const file of files) {
            await client.query(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
        }
        await client.query(`
            INSERT INTO season (name, active) VALUES ('Test', TRUE);
            INSERT INTO team (name) VALUES ('Alpha'), ('Beta');
            INSERT INTO player (first_name, last_name) VALUES ('Test', 'Player');
            INSERT INTO fixture (season_id, match_date, board_number, home_team_id, away_team_id)
            SELECT s.id, '2026-11-25', '1', a.id, b.id
            FROM season s, team a, team b WHERE a.name = 'Alpha' AND b.name = 'Beta';
            INSERT INTO match_game (fixture_id, game_number, winner_team_id, status)
            SELECT f.id, 1, t.id, 'finished' FROM fixture f, team t WHERE t.name = 'Alpha';
            INSERT INTO game_submission (fixture_id, match_game_id, source, source_key, status, accepted_at)
            SELECT f.id, mg.id, 'browser', '2026-11-25|1|Alpha|1', 'accepted', CURRENT_TIMESTAMP
            FROM fixture f JOIN match_game mg ON mg.fixture_id = f.id;
            INSERT INTO turn_score (submission_id, match_game_id, team_id, player_id, turn_number, score)
            SELECT gs.id, mg.id, t.id, p.id, 1, 95
            FROM game_submission gs JOIN match_game mg ON mg.id = gs.match_game_id, team t, player p
            WHERE t.name = 'Alpha';
            INSERT INTO game_player_score (match_game_id, team_id, player_id)
            SELECT mg.id, t.id, p.id FROM match_game mg, team t, player p WHERE t.name = 'Alpha';
        `);
        await client.query(fs.readFileSync(
            path.join(__dirname, '../migrations/007_review_match_uploads.sql'), 'utf8'
        ));
        const legacy = await client.query(`
            SELECT gs.id, gs.submitted_team_id, gs.winner_team_id, ts.score, sp.player_id
            FROM game_submission gs JOIN turn_score ts ON ts.submission_id = gs.id
            JOIN submission_player sp ON sp.submission_id = gs.id
        `);
        assert.equal(legacy.rows[0].submitted_team_id, legacy.rows[0].winner_team_id);
        assert.equal(legacy.rows[0].score, 95);
        await client.query(`
            INSERT INTO game_submission (fixture_id, match_game_id, source, source_key, status)
            SELECT fixture_id, match_game_id, 'browser', 'competing', 'pending'
            FROM game_submission WHERE id = $1
        `, [legacy.rows[0].id]);
        await client.query(`
            INSERT INTO turn_score (submission_id, match_game_id, team_id, player_id, turn_number, score)
            SELECT new.id, ts.match_game_id, ts.team_id, ts.player_id, ts.turn_number, 60
            FROM game_submission new, turn_score ts
            WHERE new.source_key = 'competing' AND ts.submission_id = $1
        `, [legacy.rows[0].id]);
        const scores = await client.query('SELECT score FROM turn_score ORDER BY score');
        assert.deepEqual(scores.rows.map(row => row.score), [60, 95]);
    } finally {
        try {
            if (schemaCreated) {
                await client.query('RESET search_path');
                await client.query(`DROP SCHEMA "${schema}" CASCADE`);
            }
        } finally {
            if (client) client.release();
            await databasePool.end();
        }
    }
});

test('post-week-10 browser submission updates baseline-plus-future stats in an isolated schema', {
    skip: !process.env.TEST_DATABASE_URL
}, async () => {
    const testHost = new URL(process.env.TEST_DATABASE_URL).hostname;
    if (testHost.endsWith('.neon.tech') && testHost.includes('-pooler.')) {
        throw new Error('TEST_DATABASE_URL must use a direct, unpooled Neon connection.');
    }
    const databasePool = createPool(process.env.TEST_DATABASE_URL);
    let client;
    let schemaCreated = false;
    const schema = `test_701_${randomUUID().replace(/-/g, '')}`;
    const sourceKey = '2026-11-25|1|The Keepers|7';

    try {
        client = await databasePool.connect();
        const query = client.query.bind(client);
        const pool = {
            query,
            async connect() {
                return { query, release() {} };
            }
        };
        await query(`CREATE SCHEMA "${schema}"`);
        schemaCreated = true;
        await query(`SET search_path TO "${schema}"`);
        await runMigrations(pool);
        await pool.query(`
            CREATE TABLE score_csv_uploads (
                match_date DATE NOT NULL, board TEXT NOT NULL, team TEXT NOT NULL,
                opponent TEXT NOT NULL, csv_data TEXT NOT NULL, row_count INTEGER NOT NULL,
                uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (match_date, board, team)
            );
            INSERT INTO season (name, active, baseline_through_week)
            VALUES ('Integration test season', TRUE, 10);
            INSERT INTO team (name) VALUES ('The Keepers'), ('Killer Bees');
            INSERT INTO player (first_name, last_name) VALUES ('Paul', 'McMahon');
            INSERT INTO team_roster (season_id, team_id, player_id)
            SELECT s.id, t.id, p.id FROM season s, team t, player p
            WHERE t.name = 'The Keepers';
            INSERT INTO fixture (season_id, week_number, match_date, board_number, home_team_id, away_team_id)
            SELECT s.id, 11, '2026-11-25', '1', home.id, away.id
            FROM season s, team home, team away
            WHERE home.name = 'Killer Bees' AND away.name = 'The Keepers';
            INSERT INTO player_season_baseline (
                season_id, team_id, player_id, baseline_games, baseline_shots, baseline_score, baseline_ninetyfive_plus
            )
            SELECT s.id, t.id, p.id, 5, 20, 500, 2
            FROM season s, team t, player p WHERE t.name = 'The Keepers';
            INSERT INTO team_season_baseline (season_id, team_id, baseline_wins, baseline_shots, baseline_score)
            SELECT s.id, t.id, 2, 20, 500 FROM season s, team t WHERE t.name = 'The Keepers';
        `);
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

        const pendingStatus = await pool.query(
            `SELECT id, status
             FROM game_submission
             WHERE source = 'browser'
               AND source_key LIKE $1`,
            [`${sourceKey}|%`]
        );
        assert.equal(pendingStatus.rows[0]?.status, 'pending');

        const submittedGame = await pool.query(
            `SELECT mg.id
             FROM game_submission gs
             JOIN match_game mg ON mg.id = gs.match_game_id
             WHERE gs.source = 'browser'
               AND gs.source_key LIKE $1`,
            [`${sourceKey}|%`]
        );
        assert.equal(submittedGame.rows.length, 1);

        await setSubmissionStatus(pool, pendingStatus.rows[0].id, 'accepted');

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

        const replacement = structuredClone(payload);
        replacement.games[0].winner = 'Killer Bees';
        replacement.games[0].turns[0].score = 60;
        replacement.games[0].turns[0].remainingAfter = 641;
        replacement.games.unshift({ ...structuredClone(replacement.games[0]), game: 6 });
        await normalizeBrowserSubmission(pool, replacement, 'replacement csv', 2);
        const thirdUpload = structuredClone(replacement);
        thirdUpload.games.unshift({ ...structuredClone(replacement.games[0]), game: 5, turns: [] });
        await normalizeBrowserSubmission(pool, thirdUpload, 'another csv', 3);
        const uploads = await pool.query(
            `SELECT upload_id, MIN(id) AS id, COUNT(*)::int AS games
             FROM game_submission WHERE upload_id IS NOT NULL
             GROUP BY upload_id ORDER BY MIN(id)`
        );
        assert.deepEqual(uploads.rows.map(row => row.games), [1, 2, 3]);
        const beforeReview = await pool.query(
            `SELECT gs.status, mg.winner_team_id, ts.score
             FROM game_submission gs JOIN match_game mg ON mg.id = gs.match_game_id
             JOIN turn_score ts ON ts.submission_id = gs.id
             WHERE gs.id = $1`,
            [pendingStatus.rows[0].id]
        );
        assert.equal(beforeReview.rows[0].status, 'accepted');
        assert.equal(beforeReview.rows[0].score, 95);
        assert.equal(beforeReview.rows[0].winner_team_id, teamId);

        const server = createServer({ pool, adminApiKey: 'test-admin-key', uploadApiKey: 'test-key' });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
            const base = `http://127.0.0.1:${server.address().port}`;
            const headers = { Authorization: 'Bearer test-admin-key' };
            const list = await (await fetch(`${base}/api/admin/submissions`, { headers })).json();
            assert.equal(list.submissions.length, 3);
            const detail = await (await fetch(`${base}/api/admin/submissions/${uploads.rows[1].id}`, { headers })).json();
            assert.deepEqual(detail.turns.map(turn => turn.game_number), [6, 7]);
            assert.ok(detail.turns.every(turn => turn.winner_team === 'Killer Bees'));
            const third = await (await fetch(`${base}/api/admin/submissions/${uploads.rows[2].id}`, { headers })).json();
            assert.deepEqual(third.games.map(game => game.game_number), [5, 6, 7]);
            assert.deepEqual(third.games[0].players, ['Paul McMahon']);
            assert.equal(third.games[0].winner_team, 'Killer Bees');
            const revision = await fetch(`${base}/api/admin/submissions`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ turnId: third.turns[1].id, score: 75, reason: 'Correct pending upload' })
            });
            assert.equal(revision.status, 200);
            const unchanged = await pool.query('SELECT score FROM turn_score WHERE submission_id = $1', [pendingStatus.rows[0].id]);
            assert.equal(unchanged.rows[0].score, 95);
            const accept = await fetch(`${base}/api/admin/submissions`, {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ submissionId: uploads.rows[1].id, status: 'accepted' })
            });
            assert.equal(accept.status, 200);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
        const states = await pool.query(
            `SELECT upload_id, status, COUNT(*)::int AS games
             FROM game_submission WHERE upload_id IS NOT NULL
             GROUP BY upload_id, status ORDER BY MIN(id)`
        );
        assert.deepEqual(states.rows.map(row => [row.status, row.games]), [
            ['superseded', 1], ['accepted', 2], ['pending', 3]
        ]);
        const acceptedScores = await pool.query(
            `SELECT ts.score, t.name AS winner
             FROM game_submission gs
             JOIN turn_score ts ON ts.submission_id = gs.id
             JOIN match_game mg ON mg.id = gs.match_game_id
             JOIN team t ON t.id = mg.winner_team_id
             WHERE gs.upload_id = $1 ORDER BY mg.game_number`,
            [uploads.rows[1].upload_id]
        );
        assert.deepEqual(acceptedScores.rows.map(row => [row.score, row.winner]), [
            [60, 'Killer Bees'], [60, 'Killer Bees']
        ]);

        await pool.query(`
            INSERT INTO player (first_name, last_name) VALUES ('Jane', 'Smith');
            INSERT INTO team_roster (season_id, team_id, player_id)
            SELECT s.id, t.id, p.id FROM season s, team t, player p
            WHERE t.name = 'Killer Bees' AND p.first_name = 'Jane';
        `);
        const otherTeam = structuredClone(replacement);
        otherTeam.team = 'Killer Bees';
        otherTeam.opponent = 'The Keepers';
        for (const game of otherTeam.games) {
            game.winner = 'The Keepers';
            game.players[0].name = 'Jane Smith';
            game.turns[0].player = 'Jane Smith';
        }
        await normalizeBrowserSubmission(pool, otherTeam, 'opponent csv', 2);
        const opponentUpload = await pool.query(
            `SELECT MIN(id) AS id FROM game_submission
             WHERE upload_id IS NOT NULL AND submitted_team_id <> $1`,
            [teamId]
        );
        await setSubmissionStatus(pool, opponentUpload.rows[0].id, 'accepted');
        const bothTeams = await pool.query(
            `SELECT mg.game_number, COUNT(*)::int AS accepted,
                    MIN(mg.winner_team_id) AS winner
             FROM game_submission gs JOIN match_game mg ON mg.id = gs.match_game_id
             WHERE gs.status = 'accepted' GROUP BY mg.game_number ORDER BY mg.game_number`
        );
        assert.deepEqual(bothTeams.rows.map(row => [row.accepted, row.winner]), [[2, teamId], [2, teamId]]);
        const reports = createServer({ pool, adminApiKey: 'test-admin-key', uploadApiKey: 'test-key' });
        await new Promise(resolve => reports.listen(0, '127.0.0.1', resolve));
        try {
            const base = `http://127.0.0.1:${reports.address().port}`;
            const standings = await (await fetch(`${base}/api/reports/standings`)).json();
            assert.equal(Number(standings.standings.find(row => row.team === 'The Keepers').wins), 4);
            const match = await (await fetch(`${base}/api/reports/match/${fixtureResult.rows[0].id}`)).json();
            assert.equal(match.games.length, 2);
            assert.equal(match.scores.length, 4);
        } finally {
            await new Promise(resolve => reports.close(resolve));
        }
        await setSubmissionStatus(pool, opponentUpload.rows[0].id, 'rejected');
        const restored = await pool.query(
            `SELECT mg.game_number, t.name AS winner
             FROM match_game mg JOIN team t ON t.id = mg.winner_team_id
             ORDER BY mg.game_number`
        );
        assert.deepEqual(restored.rows.map(row => row.winner), ['Killer Bees', 'Killer Bees']);

        const duplicate = await pool.query(
            `INSERT INTO player (first_name, last_name) VALUES ('Paul', 'Alias') RETURNING id`
        );
        await pool.query(
            `UPDATE turn_score SET player_id = $1 WHERE submission_id IN
             (SELECT id FROM game_submission WHERE upload_id = $2)`,
            [duplicate.rows[0].id, uploads.rows[2].upload_id]
        );
        await pool.query(
            `UPDATE submission_player SET player_id = $1 WHERE submission_id IN
             (SELECT id FROM game_submission WHERE upload_id = $2)`,
            [duplicate.rows[0].id, uploads.rows[2].upload_id]
        );
        await mergePlayerRecords(client, playerId, duplicate.rows[0].id);
        const merged = await pool.query(
            `SELECT COUNT(*)::int AS turns
             FROM turn_score ts JOIN game_submission gs ON gs.id = ts.submission_id
             WHERE gs.upload_id = $1 AND ts.player_id = $2`,
            [uploads.rows[2].upload_id, playerId]
        );
        assert.equal(merged.rows[0].turns, 2);
        await setSubmissionStatus(pool, uploads.rows[2].id, 'accepted');
        const lineups = await pool.query(
            `SELECT COUNT(*)::int AS players FROM game_player_score
             WHERE team_id = $1 AND player_id = $2`,
            [teamId, playerId]
        );
        assert.equal(lineups.rows[0].players, 3);
    } finally {
        try {
            if (schemaCreated) {
                await client.query('RESET search_path');
                await client.query(`DROP SCHEMA "${schema}" CASCADE`);
            }
        } finally {
            if (client) client.release();
            await databasePool.end();
        }
    }
});
