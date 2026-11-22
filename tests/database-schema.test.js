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
