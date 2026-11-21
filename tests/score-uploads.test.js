'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createServer, parseCsv, validateScoreCsv } = require('../server');
const formatMatchResultsCSV = require('../results-csv');

const csv = [
    '"match_date","board","game","team","opponent","winner","player","round_1","Checkout"',
    '"2026-11-18","3","1","Keepers, North","Snipers","Keepers, North","Player ""Ace""","180",""'
].join('\r\n');

async function withServer(pool, run, adminApiKey = 'test-admin-key') {
    const server = createServer({
        pool,
        uploadApiKey: 'test-league-key',
        adminApiKey
    });
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

test('serves public standings for the active season', async () => {
    await withServer({
        query: async sql => {
            if (/WHERE active = TRUE/.test(sql)) {
                return { rows: [{ id: 1, name: '2026-2027' }] };
            }
            return {
                rows: [{
                    team: 'Keepers',
                    wins: 6,
                    losses: 1,
                    games: 7,
                    average: '49.12'
                }]
            };
        }
    }, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/reports/standings`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
            season: '2026-2027',
            standings: [{
                team: 'Keepers',
                wins: 6,
                losses: 1,
                games: 7,
                average: '49.12'
            }]
        });

        test('lists seasons publicly', async () => {
            await withServer({
                query: async () => ({
                    rows: [{
                        id: 1,
                        name: '2026-2027',
                        start_date: new Date('2026-09-01T04:00:00.000Z'),
                        end_date: null,
                        active: true
                    }]
                })
            }, async baseUrl => {
                const response = await fetch(`${baseUrl}/api/seasons`);
                assert.equal(response.status, 200);
                assert.deepEqual(await response.json(), {
                    seasons: [{
                        id: 1,
                        name: '2026-2027',
                        startDate: '2026-09-01',
                        endDate: null,
                        active: true
                    }]
                });
            });
        });

        test('serves mens average and match report routes', async () => {
            await withServer({
                query: async sql => {
                    if (/WHERE active = TRUE/.test(sql)) {
                        return { rows: [{ id: 1, name: '2026-2027' }] };
                    }
                    if (/player_totals/.test(sql)) {
                        return { rows: [{ player: 'Test Player', team: 'Keepers', average: '52.50' }] };
                    }
                    if (/FROM fixture f/.test(sql)) {
                        return {
                            rows: [{
                                id: 1,
                                season: '2026-2027',
                                week_number: 1,
                                match_date: '2026-09-16',
                                board_number: '1',
                                home_team: 'Keepers',
                                away_team: 'Snipers'
                            }]
                        };
                    }
                    return { rows: [] };
                }
            }, async baseUrl => {
                const mens = await fetch(`${baseUrl}/api/reports/mens-avg`);
                assert.equal(mens.status, 200);
                assert.equal((await mens.json()).report, 'mens-avg');

                const match = await fetch(`${baseUrl}/api/reports/match/1`);
                assert.equal(match.status, 200);
                assert.equal((await match.json()).match.home_team, 'Keepers');
            });
        });

        test('serves the public reports page', async () => {
            await withServer({ query: async () => ({ rows: [] }) }, async baseUrl => {
                const response = await fetch(`${baseUrl}/reports`);
                assert.equal(response.status, 200);
                assert.match(response.headers.get('content-type'), /text\/html/);
                assert.match(await response.text(), /League Reports/);
            });
        });

        test('report styles keep the first player column sticky', () => {
            const fs = require('node:fs');
            const path = require('node:path');
            const styles = fs.readFileSync(
                path.join(__dirname, '../reports/styles.css'),
                'utf8'
            );
            assert.match(styles, /th:first-child,\s*td:first-child\s*\{[\s\S]*position:\s*sticky/);
            assert.match(styles, /left:\s*0/);
        });
    });
});

test('requires the league key for normalized browser submissions', async () => {
    let queryCount = 0;
    await withServer({
        query: async () => {
            queryCount++;
            return { rows: [] };
        }
    }, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/score-submissions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ matchDate: '2026-11-18' })
        });
        assert.equal(response.status, 401);
        assert.equal(queryCount, 0);
    });
});

test('rejects malformed normalized browser submissions', async () => {
    await withServer({
        query: async () => ({ rows: [] })
    }, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/score-submissions`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer test-league-key',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                matchDate: '2026-11-18',
                board: '3',
                team: 'The Keepers',
                opponent: 'The Snipers',
                games: []
            })
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /at least one completed game/i);
    });
});

test('requires the admin key for admin season management', async () => {
    let queryCount = 0;
    await withServer({
        query: async () => {
            queryCount++;
            return { rows: [] };
        }
    }, async baseUrl => {
        const unauthorized = await fetch(`${baseUrl}/api/admin/seasons`);
        assert.equal(unauthorized.status, 401);
        assert.equal(queryCount, 0);

        const authorized = await fetch(`${baseUrl}/api/admin/seasons`, {
            headers: { Authorization: 'Bearer test-admin-key' }
        });
        assert.equal(authorized.status, 200);
        assert.deepEqual(await authorized.json(), { seasons: [] });
    });
});

test('serves the admin dashboard at /admin', async () => {
    await withServer({ query: async () => ({ rows: [] }) }, async baseUrl => {
        const response = await fetch(`${baseUrl}/admin`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.match(await response.text(), /League Administration/);
    });
});

test('lists database backups through the authenticated admin API', async () => {
    await withServer({ query: async () => ({ rows: [] }) }, async baseUrl => {
        const unauthorized = await fetch(`${baseUrl}/api/admin/backups`);
        assert.equal(unauthorized.status, 401);

        const response = await fetch(`${baseUrl}/api/admin/backups`, {
            headers: { Authorization: 'Bearer test-admin-key' }
        });
        assert.equal(response.status, 200);
        assert.ok(Array.isArray((await response.json()).backups));
    });
});

test('backup creation requires PostgreSQL backup tools', async () => {
    await withServer({ query: async () => ({ rows: [] }) }, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/admin/backups/create`, {
            method: 'POST',
            headers: { Authorization: 'Bearer test-admin-key' }
        });
        assert.equal(response.status, 501);
        assert.match((await response.json()).error, /Database backup is unavailable/);
    });
});

test('rejects database restore without exact confirmation', async () => {
    await withServer({ query: async () => ({ rows: [] }) }, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/admin/backups/restore`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer test-admin-key',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filename: 'league-test.dump',
                confirmation: 'restore'
            })
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /RESTORE/);
    });
});

test('serves player and admin guides', async () => {
    await withServer({ query: async () => ({ rows: [] }) }, async baseUrl => {
        const playerGuide = await fetch(`${baseUrl}/user-guide.html`);
        assert.equal(playerGuide.status, 200);
        assert.match(await playerGuide.text(), /League reports/);

        const adminGuide = await fetch(`${baseUrl}/admin/admin-guide.html`);
        assert.equal(adminGuide.status, 200);
        assert.match(await adminGuide.text(), /League Administration Guide/);
    });
});

test('admin season rendering does not reference a fixture variable', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const script = fs.readFileSync(
        path.join(__dirname, '../admin/admin.js'),
        'utf8'
    );
    assert.doesNotMatch(script, /fixture\.season_id.*season-list|season-list.*fixture\.season_id/i);
});

test('admin exposes web backup controls', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = fs.readFileSync(
        path.join(__dirname, '../admin/index.html'),
        'utf8'
    );
    const script = fs.readFileSync(
        path.join(__dirname, '../admin/admin.js'),
        'utf8'
    );
    assert.match(html, /data-tab="backups">Backups/);
    assert.match(html, /id="create-backup"/);
    assert.match(html, /id="backup-restore-form"/);
    assert.match(script, /\/api\/admin\/backups\/create/);
    assert.match(script, /\/api\/admin\/backups\/restore/);
});

test('submission review uses a form instead of per-turn prompts', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = fs.readFileSync(
        path.join(__dirname, '../admin/index.html'),
        'utf8'
    );
    const script = fs.readFileSync(
        path.join(__dirname, '../admin/admin.js'),
        'utf8'
    );
    assert.match(html, /id="submission-review-form"/);
    assert.match(html, /id="submission-turn-editor"/);
    assert.match(script, /submission-review-form.*addEventListener/s);
    assert.doesNotMatch(script, /const scoreText = window\.prompt/);
});

test('admin uses Schedule and Match terminology for the schedule UI', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = fs.readFileSync(
        path.join(__dirname, '../admin/index.html'),
        'utf8'
    );
    const script = fs.readFileSync(
        path.join(__dirname, '../admin/admin.js'),
        'utf8'
    );
    assert.match(html, />Schedule<\//);
    assert.match(html, /<h2>Schedule<\/h2>/);
    assert.match(html, /Add Match/);
    assert.match(script, /match-card/);
    assert.doesNotMatch(script, />Fixtures<|Delete this fixture/);
});

test('admin teams and players use compact no-limit presentation', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = fs.readFileSync(
        path.join(__dirname, '../admin/index.html'),
        'utf8'
    );
    const script = fs.readFileSync(
        path.join(__dirname, '../admin/admin.js'),
        'utf8'
    );
    const styles = fs.readFileSync(
        path.join(__dirname, '../admin/styles.css'),
        'utf8'
    );
    assert.doesNotMatch(html, /Roster limit|rosterLimit/i);
    assert.doesNotMatch(script, /Roster limit|roster_limit|rosterLimit/i);
    assert.match(script, /Players: \${escapeHtml\(team\.roster_count\)}/);
    assert.match(script, /team-card/);
    assert.match(script, /player-card/);
    assert.match(styles, /\.team-card/);
    assert.match(styles, /\.player-card/);
});

test('player add form is hidden until Add Player is pressed', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = fs.readFileSync(
        path.join(__dirname, '../admin/index.html'),
        'utf8'
    );
    const script = fs.readFileSync(
        path.join(__dirname, '../admin/admin.js'),
        'utf8'
    );
    assert.match(html, /<button id="show-player-form"[^>]*>Add Player<\/button>/);
    assert.match(html, /<form id="player-form" class="inline-form hidden">/);
    assert.match(script, /show-player-form.*classList\.remove/s);
    assert.match(script, /cancel-player-add.*classList\.add/s);
});

test('match add form is hidden until Add Match is pressed', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = fs.readFileSync(
        path.join(__dirname, '../admin/index.html'),
        'utf8'
    );
    const script = fs.readFileSync(
        path.join(__dirname, '../admin/admin.js'),
        'utf8'
    );
    assert.match(html, /<button id="show-fixture-form"[^>]*>Add Match<\/button>/);
    assert.match(html, /<form id="fixture-form" class="inline-form hidden">/);
    assert.match(script, /show-fixture-form.*classList\.remove/s);
    assert.match(script, /cancel-fixture-add.*classList\.add/s);
});

test('admin player cards show team before player name', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const script = fs.readFileSync(
        path.join(__dirname, '../admin/admin.js'),
        'utf8'
    );
    const teamColumn = script.indexOf('<strong class="player-team">${escapeHtml(player.team)}</strong>');
    const nameColumn = script.indexOf('<span class="player-name">${escapeHtml([player.first_name, player.last_name]');
    assert.ok(teamColumn >= 0);
    assert.ok(nameColumn > teamColumn);
});

test('schedule board label and player remove-delete distinction are explicit', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const script = fs.readFileSync(
        path.join(__dirname, '../admin/admin.js'),
        'utf8'
    );
    assert.match(script, /Board \${escapeHtml\(fixture\.board_number/);
    assert.match(script, /Remove from roster/);
    assert.match(script, /Delete player/);
});

test('admin schedule labels weeks as Wk', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const script = fs.readFileSync(
        path.join(__dirname, '../admin/admin.js'),
        'utf8'
    );
    assert.match(script, /<strong>Wk\$\{escapeHtml\(fixture\.week_number \?\? '-'\)\}<\/strong>/);
    assert.doesNotMatch(script, /<strong>W\$\{escapeHtml\(fixture\.week_number/);
});

test('updates a player through the authenticated admin API', async () => {
    await withServer({
        query: async (sql, values) => {
            assert.match(sql, /UPDATE player/);
            assert.deepEqual(values, ['Kari', 'Burton', 'F', 3]);
            return {
                rows: [{
                    id: 3,
                    first_name: 'Kari',
                    last_name: 'Burton',
                    gender: 'F'
                }]
            };
        }
    }, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/admin/players/3`, {
            method: 'PUT',
            headers: {
                Authorization: 'Bearer test-admin-key',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                firstName: 'Kari',
                lastName: 'Burton',
                gender: 'F'
            })
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).player.id, 3);
    });
});

test('changes submission status through the authenticated admin API', async () => {
    await withServer({
        query: async (sql, values) => {
            assert.match(sql, /UPDATE game_submission/);
            assert.deepEqual(values, ['rejected', 42]);
            return {
                rows: [{
                    id: 42,
                    status: 'rejected',
                    accepted_at: null
                }]
            };
        }
    }, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/admin/submissions`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer test-admin-key',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                submissionId: 42,
                status: 'rejected'
            })
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).submission.status, 'rejected');
    });
});

test('creates a fixture through the authenticated admin API', async () => {
    await withServer({
        query: async (sql, values) => {
            assert.match(sql, /INSERT INTO fixture/);
            assert.deepEqual(values, [1, 2, '2026-12-16', '3', 4, 5]);
            return {
                rows: [{
                    id: 9,
                    season_id: 1,
                    week_number: 2,
                    match_date: '2026-12-16',
                    board_number: '3',
                    home_team_id: 4,
                    away_team_id: 5
                }]
            };
        }
    }, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/admin/fixtures`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer test-admin-key',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                seasonId: 1,
                weekNumber: 2,
                matchDate: '2026-12-16',
                boardNumber: '3',
                homeTeamId: 4,
                awayTeamId: 5
            })
        });
        assert.equal(response.status, 201);
        assert.equal((await response.json()).fixture.id, 9);
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
