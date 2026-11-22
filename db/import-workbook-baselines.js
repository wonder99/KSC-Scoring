'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { createPool } = require('./connection');
const { canonicalTeamName } = require('./import-score-csv');

function parseTeamListCsv(csvText) {
    const rows = String(csvText).replace(/^\uFEFF/, '').trimEnd()
        .split(/\r?\n/)
        .map(row => row.split(',').map(value => value.trim()))
        .filter(row => row.some(value => value));
    rows.shift();
    return rows.map(row => ({
        teamName: canonicalTeamName(row[0]),
        firstName: row[1] || '',
        lastName: row[2] || '',
        email: row[3] || ''
    })).filter(row => row.teamName && row.firstName);
}

function extractWorkbookBaselines(workbookPath) {
    if (!workbookPath || !fs.existsSync(workbookPath)) {
        throw new Error(`Workbook not found: ${workbookPath || '(missing)'}`);
    }
    const pythonCode = [
        'import json, sys',
        'import openpyxl',
        'p=sys.argv[1]',
        'w=openpyxl.load_workbook(p, data_only=True, read_only=True)',
        'teams=[]',
        'for i in range(1,13):',
        '    s=w[f"T{i}"]',
        '    team=s["M1"].value',
        '    if team is None:',
        '        continue',
        '    players=[]',
        '    for r in range(183,189):',
        '        name=s.cell(r,13).value',
        '        if name is None or str(name).strip() in ("", "0"):',
        '            continue',
        '        vals=[s.cell(r,c).value for c in range(14,23)]',
        '        if not any(v not in (None,0,"") for v in vals):',
        '            continue',
        '        players.append({"name":str(name).strip(),"row":r,"games":vals[0],"shots":vals[1],"score":vals[2],"ninetyfive":vals[4],"outs":vals[5],"score171":vals[6],"score180":vals[7],"fiftyPlus":vals[8]})',
        '    wins=s["S181"].value',
        '    losses=s["U181"].value',
        '    team_shots=s["O189"].value',
        '    team_score=s["P189"].value',
        '    teams.append({"sheet":f"T{i}","team":str(team).strip(),"players":players,"wins":wins,"losses":losses,"shots":team_shots,"score":team_score})',
        'print(json.dumps(teams))'
    ].join('\n');
    const result = spawnSync('python', ['-c', pythonCode, workbookPath], {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
    });
    if (result.status !== 0) {
        throw new Error(result.stderr || 'Workbook baseline extraction failed.');
    }
    return JSON.parse(result.stdout);
}

function extractHonourableMentions(workbookPath) {
    if (!workbookPath || !fs.existsSync(workbookPath)) {
        throw new Error(`Workbook not found: ${workbookPath || '(missing)'}`);
    }
    const pythonCode = [
        'import json, sys',
        'import openpyxl',
        'p=sys.argv[1]',
        'w=openpyxl.load_workbook(p, data_only=True, read_only=True)',
        'if "Leaders" not in w.sheetnames:',
        '    print("[]");',
        '    raise SystemExit',
        's=w["Leaders"]',
        'mentions=[]',
        'for r in range(52,57):',
        '    name=s.cell(r,1).value',
        '    team=s.cell(r,2).value',
        '    score=s.cell(r,3).value',
        '    if name and team and isinstance(score,(int,float)):',
        '        mentions.append({"gender":"M","name":str(name).strip(),"team":str(team).strip(),"score":int(score),"row":r})',
        '    name=s.cell(r,5).value',
        '    team=s.cell(r,6).value',
        '    score=s.cell(r,7).value',
        '    if name and team and isinstance(score,(int,float)):',
        '        mentions.append({"gender":"F","name":str(name).strip(),"team":str(team).strip(),"score":int(score),"row":r})',
        'print(json.dumps(mentions))'
    ].join('\n');
    const result = spawnSync('python', ['-c', pythonCode, workbookPath], {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
    });
    if (result.status !== 0) {
        throw new Error(result.stderr || 'Workbook Honourable Mentions extraction failed.');
    }
    return JSON.parse(result.stdout);
}

function normalizedName(value) {
    return String(value)
        .trim()
        .replace(/[.,]+$/g, '')
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function matchWorkbookPlayer(teamName, workbookName, roster) {
    const normalizedTeam = canonicalTeamName(teamName);
    const teamRoster = roster.filter(row =>
        canonicalTeamName(row.teamName) === normalizedTeam
    );
    if (!teamRoster.length) return null;

    let workbookText = String(workbookName).trim();
    let parts = workbookText.split(/\s+/).filter(Boolean);
    let firstName = parts[0].replace(/[.,]+$/g, '');
    let lastInitial = parts[1] ? parts[1].replace(/[.,]+$/g, '') : '';

    const aliases = {
        'The Snipers': { Richard: 'Rick', Sly: 'Sylvain' },
        'Killer Bees': { Gerry: 'Jerry' },
        'Aimless Wonders': { Gerry: 'Gerald' },
        'The Avengers': { Ginger: 'Terry' },
        'Just The Tip': { Joey: 'Joe' },
        'Flight Risk': { Jeremy: 'Jermey' },
        'The Keepers': { Kurtis: 'Kurt' }
    };
    if (aliases[normalizedTeam] && aliases[normalizedTeam][firstName]) {
        firstName = aliases[normalizedTeam][firstName];
    }

    const exact = teamRoster.find(row =>
        normalizedName(row.firstName) === normalizedName(firstName)
    );
    if (exact) {
        if (lastInitial) {
            const initial = normalizedName(rowLastNameInitial(exact));
            if (!initial || initial === normalizedName(lastInitial)) return exact;
        } else {
            return exact;
        }
    }

    return teamRoster.find(row =>
        normalizedName(row.firstName) === normalizedName(firstName) &&
        (!lastInitial || rowLastNameInitial(row) === normalizedName(lastInitial))
    ) || null;
}

function rowLastNameInitial(row) {
    if (!row.lastName) return '';
    return String(row.lastName).trim()[0].toLowerCase();
}

async function findTeam(client, name) {
    const canonical = canonicalTeamName(name);
    const result = await client.query('SELECT id, name FROM team');
    const match = result.rows.find(row =>
        canonicalTeamName(row.name) === canonical
    );
    if (!match) return null;
    return match;
}

async function findPlayer(client, rosterRow) {
    const firstNames = [rosterRow.firstName];
    if (rosterRow.teamName === 'Flight Risk' && rosterRow.firstName === 'Jermey') {
        firstNames.push('Jeremy');
    }

    for (const firstName of firstNames) {
        const result = await client.query(
          `SELECT id FROM player
             WHERE lower(first_name) = lower($1)
               AND lower(COALESCE(last_name, '')) = lower($2)
           ORDER BY id
           LIMIT 1`,
          [firstName, rosterRow.lastName]
        );
        if (result.rows.length) return result.rows[0];
    }
    return null;
}

async function importHonourableMentionsWithClient(client, seasonId, csvPath, workbookPath) {
    const roster = parseTeamListCsv(fs.readFileSync(csvPath, 'utf8'));
    const mentions = extractHonourableMentions(workbookPath);
    const unmatched = [];
    let mentionRows = 0;

    await client.query(
        'DELETE FROM honourable_mention WHERE season_id = $1',
        [seasonId]
    );

    for (const mention of mentions) {
        if (
          (mention.gender === 'M' && mention.score < 171) ||
          (mention.gender === 'F' && mention.score < 130) ||
          mention.score > 180
        ) {
          unmatched.push({
              team: mention.team,
              player: mention.name,
              score: mention.score,
              reason: 'score is outside the Honourable Mention threshold'
          });
          continue;
        }

        const team = await findTeam(client, mention.team);
        if (!team) {
          unmatched.push({
              team: mention.team,
              player: mention.name,
              score: mention.score,
              reason: 'team not found'
          });
          continue;
        }

        const rosterRow = matchWorkbookPlayer(
          mention.team,
          mention.name,
          roster
        );
        if (!rosterRow) {
          unmatched.push({
              team: mention.team,
              player: mention.name,
              score: mention.score,
              reason: 'no authoritative roster match'
          });
          continue;
        }

        const player = await findPlayer(client, rosterRow);
        if (!player) {
          unmatched.push({
              team: mention.team,
              player: mention.name,
              score: mention.score,
              reason: 'player not found'
          });
          continue;
        }

        await client.query(
          `INSERT INTO honourable_mention (
              season_id, team_id, player_id, score,
              source_sheet, source_row, source_reference
           )
           VALUES ($1, $2, $3, $4, 'Leaders', $5, $6)
           ON CONFLICT (season_id, team_id, player_id, score)
           DO UPDATE SET
              source_sheet = EXCLUDED.source_sheet,
              source_row = EXCLUDED.source_row,
              source_reference = EXCLUDED.source_reference,
              imported_at = CURRENT_TIMESTAMP`,
          [
              seasonId,
              team.id,
              player.id,
              mention.score,
              mention.row,
              `Leaders!${mention.gender === 'M' ? 'A' : 'E'}${mention.row}:${mention.gender === 'M' ? 'C' : 'G'}${mention.row}`
          ]
        );
        mentionRows++;
    }

    return { mentionRows, unmatched };
}

async function importHonourableMentions(pool, csvPath, workbookPath) {
    if (!pool || typeof pool.connect !== 'function') {
        throw new TypeError('A PostgreSQL pool with transactions is required.');
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const seasonResult = await client.query(
          'SELECT id, name FROM season WHERE active = TRUE LIMIT 1'
        );
        if (!seasonResult.rows.length) {
          throw new Error('No active season exists.');
        }
        const season = seasonResult.rows[0];
        const result = await importHonourableMentionsWithClient(
          client,
          season.id,
          csvPath,
          workbookPath
        );
        await client.query('COMMIT');
        return {
          season: season.name,
          mentionRows: result.mentionRows,
          unmatched: result.unmatched
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function importWorkbookBaselines(pool, csvPath, workbookPath, baselineWeek = 10) {
    if (!pool || typeof pool.connect !== 'function') {
        throw new TypeError('A PostgreSQL pool with transactions is required.');
    }
    const roster = parseTeamListCsv(fs.readFileSync(csvPath, 'utf8'));
    const workbookTeams = extractWorkbookBaselines(workbookPath);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const seasonResult = await client.query(
            'SELECT id, name FROM season WHERE active = TRUE LIMIT 1'
        );
        if (!seasonResult.rows.length) {
            throw new Error('No active season exists.');
        }
        const season = seasonResult.rows[0];
        await client.query(
            'UPDATE season SET baseline_through_week = $1 WHERE id = $2',
            [baselineWeek, season.id]
        );
        await client.query(
            'DELETE FROM player_season_baseline WHERE season_id = $1',
            [season.id]
        );
        await client.query(
            'DELETE FROM team_season_baseline WHERE season_id = $1',
            [season.id]
        );

        let playerRows = 0;
        let teamRows = 0;
        const unmatched = [];
        for (const workbookTeam of workbookTeams) {
            const team = await findTeam(client, workbookTeam.team);
            if (!team) {
                unmatched.push({
                    team: workbookTeam.team,
                    reason: 'team not found'
                });
                continue;
            }
            await client.query(
                `INSERT INTO team_season_baseline (
                    season_id, team_id, baseline_wins, baseline_losses,
                    baseline_shots, baseline_score, source_sheet, source_reference
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (season_id, team_id)
                 DO UPDATE SET
                    baseline_wins = EXCLUDED.baseline_wins,
                    baseline_losses = EXCLUDED.baseline_losses,
                    baseline_shots = EXCLUDED.baseline_shots,
                    baseline_score = EXCLUDED.baseline_score,
                    source_sheet = EXCLUDED.source_sheet,
                    source_reference = EXCLUDED.source_reference,
                    imported_at = CURRENT_TIMESTAMP`,
                [
                    season.id,
                    team.id,
                    Number(workbookTeam.wins || 0),
                    Number(workbookTeam.losses || 0),
                    Number(workbookTeam.shots || 0),
                    Number(workbookTeam.score || 0),
                    workbookTeam.sheet,
                    `${workbookTeam.sheet}!S181/U181/O189/P189`
                ]
            );
            teamRows++;

            for (const playerStat of workbookTeam.players) {
                const rosterRow = matchWorkbookPlayer(
                    workbookTeam.team,
                    playerStat.name,
                    roster
                );
                if (!rosterRow) {
                    unmatched.push({
                        team: workbookTeam.team,
                        player: playerStat.name,
                        reason: 'no authoritative roster match'
                    });
                    continue;
                }
                const player = await findPlayer(client, rosterRow);
                if (!player) {
                    unmatched.push({
                        team: workbookTeam.team,
                        player: playerStat.name,
                        reason: 'player not found'
                    });
                    continue;
                }
                await client.query(
                    `INSERT INTO player_season_baseline (
                        season_id, team_id, player_id,
                        baseline_games, baseline_shots, baseline_score,
                        baseline_ninetyfive_plus, baseline_outs,
                        baseline_score_171, baseline_score_180,
                        baseline_fifty_plus_finishes,
                        source_sheet, source_row, source_reference
                     )
                     VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                        $12, $13, $14
                     )
                     ON CONFLICT (season_id, team_id, player_id)
                     DO UPDATE SET
                        baseline_games = EXCLUDED.baseline_games,
                        baseline_shots = EXCLUDED.baseline_shots,
                        baseline_score = EXCLUDED.baseline_score,
                        baseline_ninetyfive_plus = EXCLUDED.baseline_ninetyfive_plus,
                        baseline_outs = EXCLUDED.baseline_outs,
                        baseline_score_171 = EXCLUDED.baseline_score_171,
                        baseline_score_180 = EXCLUDED.baseline_score_180,
                        baseline_fifty_plus_finishes = EXCLUDED.baseline_fifty_plus_finishes,
                        source_sheet = EXCLUDED.source_sheet,
                        source_row = EXCLUDED.source_row,
                        source_reference = EXCLUDED.source_reference,
                        imported_at = CURRENT_TIMESTAMP`,
                    [
                        season.id,
                        team.id,
                        player.id,
                        Number(playerStat.games || 0),
                        Number(playerStat.shots || 0),
                        Number(playerStat.score || 0),
                        Number(playerStat.ninetyfive || 0),
                        Number(playerStat.outs || 0),
                        Number(playerStat.score171 || 0),
                        Number(playerStat.score180 || 0),
                        Number(playerStat.fiftyPlus || 0),
                        workbookTeam.sheet,
                        playerStat.row,
                        `${workbookTeam.sheet}!M${playerStat.row}:V${playerStat.row}`
                    ]
                );
                playerRows++;
            }
        }
        const honourableResult = await importHonourableMentionsWithClient(
            client,
            season.id,
            csvPath,
            workbookPath
        );
        await client.query('COMMIT');
        return {
            season: season.name,
            baselineThroughWeek: baselineWeek,
            teamRows,
            playerRows,
            mentionRows: honourableResult.mentionRows,
            unmatched: unmatched.concat(honourableResult.unmatched)
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

if (require.main === module) {
    const csvPath = process.argv[2] || 'team_lists.csv';
    const workbookPath = process.argv[3] || process.env.WORKBOOK_PATH;
    const baselineWeek = Number(process.argv[4] || 10);
    if (!workbookPath) {
        console.error('Provide a workbook path as the third argument or set WORKBOOK_PATH.');
        process.exitCode = 1;
    } else {
        const pool = createPool();
        importWorkbookBaselines(pool, csvPath, workbookPath, baselineWeek)
            .then(async result => {
                await pool.end();
                console.log(
                    `Imported ${result.playerRows} player baselines, ${result.teamRows} team baselines, and ${result.mentionRows} Honourable Mentions through week ${result.baselineThroughWeek} for ${result.season}.`
                );
                if (result.unmatched.length) {
                    console.error(JSON.stringify(result.unmatched, null, 2));
                }
            })
            .catch(async error => {
                await pool.end().catch(() => {});
                console.error(error);
                process.exitCode = 1;
            });
    }
}

module.exports = {
    extractWorkbookBaselines,
    extractHonourableMentions,
    importWorkbookBaselines,
    importHonourableMentions,
    matchWorkbookPlayer,
    parseTeamListCsv
};
