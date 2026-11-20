'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createServer, parseCsv, validateScoreCsv } = require('../server');
const formatMatchResultsCSV = require('../results-csv');

const csv = [
    '"match_date","board","game","team","opponent","winner","player","round_1","Checkout"',
    '"2026-11-18","3","1","Keepers, North","Snipers","Keepers, North","Player ""Ace""","180",""'
].join('\r\n');

async function withServer(pool, run) {
    const server = createServer({ pool, uploadApiKey: 'test-league-key' });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    try {
        await run(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

test('parses quoted CSV values and validates fixture rows', () => {
    const rows = parseCsv(csv);
    assert.equal(rows[1][3], 'Keepers, North');
    assert.equal(rows[1][6], 'Player "Ace"');
    assert.deepEqual(validateScoreCsv(csv), {
        key: '2026-11-18\u00003\u0000Keepers, North',
        matchDate: '2026-11-18',
        board: '3',
        team: 'Keepers, North',
        opponent: 'Snipers',
        rowCount: 1
    });
});

test('rejects a CSV containing more than one fixture', () => {
    const secondRow = '"2026-11-25","3","1","Keepers, North","Snipers","Keepers, North","Player B","100",""';
    assert.throws(() => validateScoreCsv(`${csv}\r\n${secondRow}`), /one match and team only/);
});

test('preserves the team score history when the opponent wins', () => {
    const lossCsv = formatMatchResultsCSV([{
        date: '2026-11-11',
        board: '3',
        game: 1,
        team: 'The Keepers (8)',
        opponent: 'Avengers (5)',
        winner: 'Avengers (5)',
        players: [
            { name: 'Paul', roundScores: [45, 60], checkout: '' },
            { name: 'John', roundScores: [81], checkout: '' }
        ]
    }]);
    const rows = parseCsv(lossCsv);
    assert.deepEqual(rows[1], [
        '2026-11-11', '3', '1', 'The Keepers (8)', 'Avengers (5)', 'Avengers (5)',
        'Paul', '45', '60', ''
    ]);
    assert.deepEqual(rows[2], [
        '2026-11-11', '3', '1', 'The Keepers (8)', 'Avengers (5)', 'Avengers (5)',
        'John', '81', '', ''
    ]);
});

test('requires a valid league key before storing an upload', async () => {
    let queryCount = 0;
    await withServer({ query: async () => { queryCount++; return { rows: [] }; } }, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/score-uploads`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: csv
        });
        assert.equal(response.status, 401);
        assert.match((await response.json()).error, /upload key/);
        assert.equal(queryCount, 0);
    });
});

test('stores a valid CSV with an idempotent fixture key', async () => {
    let queryText = '';
    let queryValues;
    await withServer({
        query: async (query, values) => {
            queryText = query;
            queryValues = values;
            return { rows: [{ uploaded_at: '2026-11-19T00:00:00.000Z' }] };
        }
    }, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/score-uploads`, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/csv',
                Authorization: 'Bearer test-league-key'
            },
            body: csv
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            saved: true,
            rowCount: 1,
            uploadedAt: '2026-11-19T00:00:00.000Z'
        });
    });
    assert.match(queryText, /ON CONFLICT \(match_date, board, team\)/);
    assert.equal(queryValues[4], csv);
    assert.deepEqual(queryValues.slice(0, 4), ['2026-11-18', '3', 'Keepers, North', 'Snipers']);
});

test('lists saved uploads only with the league key', async () => {
    let queryCount = 0;
    await withServer({
        query: async () => {
            queryCount++;
            return {
                rows: [{
                    match_date: new Date('2026-11-18T05:00:00.000Z'),
                    board: '3',
                    team: 'Keepers, North',
                    opponent: 'Snipers',
                    row_count: 1,
                    uploaded_at: '2026-11-19T00:00:00.000Z'
                }]
            };
        }
    }, async baseUrl => {
        const unauthorized = await fetch(`${baseUrl}/api/score-uploads/list`);
        assert.equal(unauthorized.status, 401);
        assert.equal(queryCount, 0);

        const response = await fetch(`${baseUrl}/api/score-uploads/list`, {
            headers: { Authorization: 'Bearer test-league-key' }
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            uploads: [{
                matchDate: '2026-11-18',
                board: '3',
                team: 'Keepers, North',
                opponent: 'Snipers',
                rowCount: 1,
                uploadedAt: '2026-11-19T00:00:00.000Z'
            }]
        });
    });
    assert.equal(queryCount, 1);
});

test('serves the upload browser at /uploads', async () => {
    await withServer({ query: async () => ({ rows: [] }) }, async baseUrl => {
        const response = await fetch(`${baseUrl}/uploads`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.match(await response.text(), /Download selected as CSV/);
    });
});

test('exports selected saved uploads as a combined CSV', async () => {
    let queryText = '';
    let queryValues;
    await withServer({
        query: async (query, values) => {
            queryText = query;
            queryValues = values;
            return {
                rows: [{
                    match_date: '2026-11-18',
                    board: '3',
                    team: 'Keepers, North',
                    csv_data: csv
                }]
            };
        }
    }, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/score-uploads/export`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer test-league-key',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                uploads: [{ matchDate: '2026-11-18', board: '3', team: 'Keepers, North' }]
            })
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8');
        assert.match(response.headers.get('content-disposition'), /701-score-uploads\.csv/);

        const exportedRows = parseCsv(await response.text());
        assert.equal(exportedRows[0][0], 'match_date');
        assert.equal(exportedRows[1][0], '2026-11-18');
        assert.equal(exportedRows[1][1], '3');
        assert.equal(exportedRows[1][3], 'Keepers, North');
        assert.equal(exportedRows[1][6], 'Player "Ace"');
        assert.equal(exportedRows[1][7], '180');
    });
    assert.match(queryText, /WHERE \(match_date = \$1 AND board = \$2 AND team = \$3\)/);
    assert.deepEqual(queryValues, ['2026-11-18', '3', 'Keepers, North']);
});
