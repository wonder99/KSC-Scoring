'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createServer, parseCsv, validateScoreCsv } = require('../server');

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
