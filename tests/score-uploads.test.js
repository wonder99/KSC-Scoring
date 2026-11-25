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

test('the game 7 winner dialog makes uploading the primary action', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
    const start = source.indexOf('function renderWinnerModal()');
    const end = source.indexOf('\nfunction navigateToGame(', start);
    assert.ok(start >= 0 && end > start);
    const elements = new Map();
    function element(id) {
        if (!elements.has(id)) {
            const classes = new Set(id === 'next-game-btn' ? ['btn-primary'] : []);
            elements.set(id, {
                id,
                classList: {
                    toggle(name, enabled) {
                        if (enabled) classes.add(name);
                        else classes.delete(name);
                    },
                    remove(name) { classes.delete(name); },
                    contains(name) { return classes.has(name); }
                },
                append(...children) { this.children = children.map(child => child.id); }
            });
        }
        return elements.get(id);
    }
    const state = {
        activeGameIndex: 0,
        teamName: 'Home',
        opponent: 'Away',
        matchResults: [{ game: 1, winner: 'Home' }]
    };
    const context = vm.createContext({
        state,
        $: element,
        displayTeamName: name => name,
        setServerUploadStatus() {}
    });
    vm.runInContext(source.slice(start, end), context);
    vm.runInContext('renderWinnerModal()', context);
    assert.equal(element('next-game-btn').classList.contains('btn-primary'), true);
    assert.equal(element('server-upload-btn').classList.contains('btn-primary'), false);
    assert.deepEqual(element('winner-actions').children, ['next-game-btn', 'winner-undo-btn', 'server-upload']);

    state.activeGameIndex = 6;
    state.matchResults.push({ game: 7, winner: 'Away' });
    vm.runInContext('renderWinnerModal()', context);
    assert.equal(element('server-upload-btn').textContent, 'Upload Results');
    assert.equal(element('server-upload-btn').classList.contains('btn-primary'), true);
    assert.equal(element('next-game-btn').classList.contains('btn-primary'), false);
    assert.equal(element('server-upload-key-prompt').hidden, true);
    assert.deepEqual(element('winner-actions').children, ['server-upload', 'next-game-btn', 'winner-undo-btn']);

    state.matchResults = Array.from({ length: 7 }, (_, index) => ({ game: index + 1, winner: 'Home' }));
    state.activeGameIndex = 0;
    vm.runInContext('renderWinnerModal()', context);
    assert.equal(element('server-upload-btn').classList.contains('btn-primary'), true);

    state.matchResults = [{ game: 1, winner: 'Home' }];
    state.activeGameIndex = 0;
    vm.runInContext('renderWinnerModal()', context);
    assert.equal(element('next-game-btn').classList.contains('btn-primary'), true);
    assert.equal(element('server-upload-btn').classList.contains('btn-primary'), false);
});

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

test('the removed uploads browser and APIs return 404', async () => {
    await withServer({ query: async () => ({ rows: [] }) }, async baseUrl => {
        for (const pathname of [
            '/uploads',
            '/api/score-uploads',
            '/api/score-uploads/list',
            '/api/score-uploads/export'
        ]) {
            const response = await fetch(`${baseUrl}${pathname}`);
            assert.equal(response.status, 404);
        }
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
                const response = await fetch(`${baseUrl}/stats`);
                assert.equal(response.status, 200);
                assert.match(response.headers.get('content-type'), /text\/html/);
                assert.match(await response.text(), /League Stats/);

                const redirected = await fetch(`${baseUrl}/reports`, { redirect: 'manual' });
                assert.equal(redirected.status, 302);
                assert.equal(redirected.headers.get('location'), '/stats');
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
            assert.match(styles, /th\s*\{[\s\S]*position:\s*sticky[\s\S]*top:\s*0/);
        });

        test('League Stats tabs put Leaders after Standings', () => {
            const fs = require('node:fs');
            const path = require('node:path');
            const html = fs.readFileSync(
                path.join(__dirname, '../reports/index.html'),
                'utf8'
            );
            const standingsIndex = html.indexOf('data-report="standings"');
            const leadersIndex = html.indexOf('data-report="leaders"');
            const mensIndex = html.indexOf('data-report="mens"');
            assert.ok(standingsIndex >= 0);
            assert.ok(leadersIndex > standingsIndex);
            assert.ok(mensIndex > leadersIndex);
        });

        test('Leaders report has a PDF print control and one-page portrait styles', () => {
            const fs = require('node:fs');
            const path = require('node:path');
            const html = fs.readFileSync(
                path.join(__dirname, '../reports/index.html'),
                'utf8'
            );
            const script = fs.readFileSync(
                path.join(__dirname, '../reports/reports.js'),
                'utf8'
            );
            const styles = fs.readFileSync(
                path.join(__dirname, '../reports/styles.css'),
                'utf8'
            );

            assert.match(html, /id="print-leaders"/);
            assert.match(script, /printLeadersButton\.addEventListener\('click', \(\) => window\.print\(\)\)/);
            assert.match(script, /Men's Side/);
            assert.match(script, /Ladies' Side/);
            assert.match(styles, /@media print/);
            assert.match(styles, /@page[\s\S]*size:\s*portrait/);
        });

        test('League Stats tables support sortable headers', () => {
            const fs = require('node:fs');
            const path = require('node:path');
            const script = fs.readFileSync(
                path.join(__dirname, '../reports/reports.js'),
                'utf8'
            );
            const styles = fs.readFileSync(
                path.join(__dirname, '../reports/styles.css'),
                'utf8'
            );
            assert.match(script, /function sortReportTable/);
            assert.match(script, /sort-header/);
            assert.match(script, /aria-sort/);
            assert.match(script, /reportContent\.addEventListener\('click'/);
            assert.match(styles, /\.sort-header/);
            assert.match(styles, /\.sort-indicator/);
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

test('creates and validates an HttpOnly admin session', async () => {
    await withServer({
        query: async sql => {
            if (/FROM season/.test(sql)) return { rows: [] };
            return { rows: [] };
        }
    }, async baseUrl => {
        const rejected = await fetch(`${baseUrl}/api/admin/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'wrong-key' })
        });
        assert.equal(rejected.status, 401);

        const login = await fetch(`${baseUrl}/api/admin/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'test-admin-key' })
        });
        assert.equal(login.status, 200);
        assert.match(login.headers.get('set-cookie'), /HttpOnly/);
        assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
        const cookie = login.headers.get('set-cookie').split(';')[0];

        const current = await fetch(`${baseUrl}/api/admin/session`, {
            headers: { Cookie: cookie }
        });
        assert.equal(current.status, 200);
        assert.deepEqual(await current.json(), { authenticated: true });

        const logout = await fetch(`${baseUrl}/api/admin/session`, {
            method: 'DELETE',
            headers: { Cookie: cookie }
        });
        assert.equal(logout.status, 200);
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

        test('requires admin authorization for backup upload', async () => {
            await withServer({ query: async () => ({ rows: [] }) }, async baseUrl => {
                const response = await fetch(`${baseUrl}/api/admin/backups/upload`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'X-Backup-Filename': 'league-test.dump'
                    },
                    body: Buffer.from('test dump')
                });
                assert.equal(response.status, 401);
            });
        });

        test('backup upload rejects invalid content type and filename', async () => {
            await withServer({ query: async () => ({ rows: [] }) }, async baseUrl => {
                const response = await fetch(`${baseUrl}/api/admin/backups/upload`, {
                    method: 'POST',
                    headers: {
                        Authorization: 'Bearer test-admin-key',
                        'Content-Type': 'text/plain',
                        'X-Backup-Filename': 'league-test.dump'
                    },
                    body: 'not a dump'
                });
                assert.equal(response.status, 415);
            });
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
        assert.match(await playerGuide.text(), /League Stats/);

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
    const styles = fs.readFileSync(
        path.join(__dirname, '../admin/styles.css'),
        'utf8'
    );
    assert.doesNotMatch(script, /fixture\.season_id.*season-list|season-list.*fixture\.season_id/i);
});

test('admin dashboard uses server sessions instead of sessionStorage keys', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const script = fs.readFileSync(
        path.join(__dirname, '../admin/admin.js'),
        'utf8'
    );
    assert.doesNotMatch(script, /sessionStorage/);
    assert.match(script, /\/api\/admin\/session/);
    assert.match(script, /JSON\.stringify\(\{ key: suppliedKey \}\)/);
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

test('admin HTML contains one backup upload form', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = fs.readFileSync(
        path.join(__dirname, '../admin/index.html'),
        'utf8'
    );
    const matches = html.match(/id="backup-upload-form"/g) || [];
    assert.equal(matches.length, 1);
});

test('admin form resets are guarded against missing DOM elements', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const script = fs.readFileSync(
        path.join(__dirname, '../admin/admin.js'),
        'utf8'
    );
    assert.match(script, /function resetForm\(formOrId\)/);
    assert.match(script, /resetForm\(restoreForm\)/);
    assert.doesNotMatch(script, /restoreForm\.reset\(\)/);
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

test('submission review renders one unified game table', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const script = fs.readFileSync(
        path.join(__dirname, '../admin/admin.js'),
        'utf8'
    );
    const styles = fs.readFileSync(
        path.join(__dirname, '../admin/styles.css'),
        'utf8'
    );
    assert.match(script, /formatShortDate\(detail\.submission\.match_date\)/);
    assert.match(script, /detail\.turns\.find\(turn => turn\.team\)/);
    assert.match(script, /submission-review-team/);
    assert.match(script, /<strong>\$\{escapeHtml\(player\.name\)\}<\/strong>/);
    assert.match(script, /<div class="submission-turn-list"/);
    assert.match(script, /<section class="submission-game"/);
    assert.match(script, /review-game-layout/);
    assert.match(script, /review-game-table/);
    assert.match(script, /review-table-separator/);
    assert.match(script, /<th scope="col">Player<\/th>/);
    assert.match(script, /After R\$\{index \+ 1\}/);
    assert.match(script, /review-turn-cell/);
    assert.match(script, /input type="text"/);
    assert.match(script, /inputmode="numeric"/);
    assert.match(script, /function recalculateSubmissionGame/);
    assert.match(script, /countdown-cell\[data-turn-id/);
    assert.match(script, /scoreInput\.addEventListener\('input'/);
    assert.match(script, /remainingAfter/);
    assert.match(script, /calculatedAfter/);
    assert.match(script, /won with a \${checkoutTurn\.score} checkout/);
    assert.match(script, /review-game-outcome/);
    assert.match(script, /review-game-win/);
    assert.match(script, /review-game-loss/);
    assert.match(script, /play_order/);
    assert.match(script, /left\.id - right\.id/);
    assert.match(styles, /\.submission-turn-list/);
    assert.match(styles, /\.review-game-layout/);
    assert.match(styles, /\.review-game-table/);
    assert.match(styles, /\.review-table-separator/);
    assert.match(styles, /font-size: 1rem/);
    assert.match(styles, /\.review-turn-cell input\[type="text"\]/);
    assert.match(styles, /height: 36px/);
    assert.match(styles, /@media \(max-width: 480px\)/);
    assert.match(styles, /\.review-game-outcome/);
    assert.match(styles, /\.review-game-win/);
    assert.match(styles, /\.review-game-loss/);
    assert.match(styles, /font-size: 1\.05rem/);
});

test('turn revisions recalculate the whole game countdown in the database', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const server = fs.readFileSync(
        path.join(__dirname, '../server.js'),
        'utf8'
    );
    assert.match(server, /ORDER BY COALESCE\(play_order, id\), id/);
    assert.match(server, /SET remaining_before = \$1/);
    assert.match(server, /remaining_after = \$2/);
    assert.match(server, /let remaining = 701/);
});

test('startup ensures turn play order is available', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const server = fs.readFileSync(
        path.join(__dirname, '../server.js'),
        'utf8'
    );
    assert.match(server, /ALTER TABLE turn_score[\s\S]*ADD COLUMN IF NOT EXISTS play_order INTEGER/);
});

test('browser roster preserves first and last names', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const app = fs.readFileSync(
        path.join(__dirname, '../app.js'),
        'utf8'
    );
    assert.match(app, /const firstName = row\[1\] \|\| ''/);
    assert.match(app, /const lastName = row\[2\] \|\| ''/);
    assert.match(app, /\[firstName, lastName\]\.filter\(Boolean\)\.join\(' '\)/);
});

test('scoring page displays only the active player first name', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const app = fs.readFileSync(
        path.join(__dirname, '../app.js'),
        'utf8'
    );
    assert.match(app, /function displayFirstName\(name\) \{/);
    assert.match(app, /String\(name \|\| ''\)\.trim\(\)\.split\(\/\\s\+\//);
    assert.match(app, /: displayFirstName\(state\.players\[state\.currentPlayer\]\.name\)/);
});

test('browser submissions resolve short names through the team roster', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const importer = fs.readFileSync(
        path.join(__dirname, '../db/import-browser-submission.js'),
        'utf8'
    );
    assert.match(importer, /resolveRosterPlayerName/);
    assert.match(importer, /FROM team_roster tr/);
    assert.match(importer, /tr\.team_id = \$2/);
    assert.match(importer, /is not on this team's active roster/);
    assert.match(importer, /VALUES \(\$1, \$2, 'browser', \$3, 'pending'/);
    assert.match(importer, /crypto\.randomUUID\(\)/);
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
    const styles = fs.readFileSync(
        path.join(__dirname, '../admin/styles.css'),
        'utf8'
    );
    assert.match(html, />Schedule<\//);
    assert.match(html, /<h2>Schedule<\/h2>/);
    assert.match(html, /Add Match/);
    assert.match(html, /download-schedule-xlsx/);
    assert.match(html, /schedule-xlsx-upload-form/);
    assert.match(script, /downloadScheduleWorkbook/);
    assert.match(script, /uploadScheduleWorkbook/);
    assert.match(script, /match-card/);
    assert.match(script, /getLocalDateKey/);
    assert.match(script, /is-past/);
    assert.match(script, /data-match-date/);
    assert.match(styles, /\.match-card\.is-past/);
    assert.match(styles, /opacity: 0\.55/);
    assert.doesNotMatch(script, />Fixtures<|Delete this fixture/);
});

test('schedule XLSX export fills missing week numbers from fixtures on the same date', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const server = fs.readFileSync(
        path.join(__dirname, '../server.js'),
        'utf8'
    );
    assert.match(server, /COALESCE\(\s*f\.week_number[\s\S]*SELECT MIN\(f2\.week_number\)/);
    assert.match(server, /Match ID/);
    assert.match(server, /Home Team/);
    assert.match(server, /Away Team/);
    assert.match(server, /A1:G1/);
    assert.match(server, /headerRowNumber/);
    assert.match(server, /KSC Darts League Schedule/);
    assert.match(server, /match rows below/);
    assert.match(server, /blank Match ID/);
    assert.match(server, /FFA8E6C1/);
    assert.match(server, /FF183425/);
    assert.match(server, /match rows below/);
    assert.match(server, /Removing a row deletes only matches/);
    assert.match(server, /sheet\.addRow\(\[\s*fixture\.id/);
});

test('admin schedule workbook routes use XLSX support', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const server = fs.readFileSync(
        path.join(__dirname, '../server.js'),
        'utf8'
    );
    const manifest = fs.readFileSync(
        path.join(__dirname, '../package.json'),
        'utf8'
    );
    assert.match(server, /handleAdminScheduleWorkbook/);
    assert.match(server, /download\.xlsx/);
    assert.match(server, /upload\.xlsx/);
    assert.match(server, /Match ID/);
    assert.match(server, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
    assert.match(manifest, /exceljs/);
});

test('admin labels score submissions as Score Uploads', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = fs.readFileSync(
        path.join(__dirname, '../admin/index.html'),
        'utf8'
    );
    assert.match(html, />Score Uploads<\//);
    assert.match(html, /<h2>Score Uploads<\/h2>/);
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

test('player edits show saving and success status feedback', () => {
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
    assert.match(html, /id="player-status"/);
    assert.match(script, /Saving player\.\.\./);
    assert.match(script, /Player updated successfully\./);
    assert.match(script, /resetForm\(editForm\)/);
    assert.match(script, /editForm\.classList\.add\('hidden'\)/);
    assert.match(script, /status\.className = 'admin-status error'/);
    assert.match(styles, /\.admin-status\.success/);
    assert.match(styles, /\.admin-status\.error/);
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
    const client = {
        async query(sql) {
            if (/SELECT fixture_id, upload_id/.test(sql)) {
                return { rows: [{ fixture_id: 1, upload_id: null }] };
            }
            if (/SELECT id, fixture_id, match_game_id, submitted_team_id/.test(sql)) {
                return { rows: [{ id: 42, fixture_id: 1, match_game_id: 7, submitted_team_id: 1 }] };
            }
            if (/UPDATE game_submission[\s\S]*RETURNING/.test(sql)) {
                return { rows: [{ id: 42, status: 'rejected', accepted_at: null }] };
            }
            return { rows: [] };
        },
        release() {}
    };
    await withServer({
        query: client.query,
        async connect() {
            return client;
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

test('upload list only offers deletion for rejected uploads', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const source = fs.readFileSync(path.join(__dirname, '../admin/admin.js'), 'utf8');
    const handlers = source.indexOf("\ndocument.getElementById('unlock-admin').addEventListener");
    assert.notEqual(handlers, -1);
    const elements = new Map();
    const document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '' });
            return elements.get(id);
        }
    };
    const submissions = ['pending', 'accepted', 'rejected', 'mixed'].map((status, index) => ({
        id: index + 1,
        status,
        source: 'browser',
        match_date: '2026-11-25',
        board_number: '1',
        home_team: '<Keepers>',
        away_team: 'Bees',
        submitted_team: 'Keepers',
        turn_count: 7
    }));
    const context = vm.createContext({
        document,
        fetch: async () => ({ ok: true, json: async () => ({ submissions }) })
    });
    vm.runInContext(source.slice(0, handlers), context);
    await vm.runInContext('loadSubmissions()', context);
    const html = elements.get('submission-list').innerHTML;
    assert.deepEqual([...html.matchAll(/data-delete-submission="(\d+)"/g)].map(match => match[1]), ['3']);
    assert.match(html, /data-reject-submission="1"/);
    assert.match(html, /data-reject-submission="4"/);
    assert.match(html, /&lt;Keepers&gt;/);
    assert.doesNotMatch(html, /<Keepers>/);
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
