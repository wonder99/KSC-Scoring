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
    const header = rows.shift() || [];
    if (!header.length || header[0] !== 'Team Name') {
        throw new Error('team_lists.csv must begin with Team Name.');
    }
    return rows.map(row => ({
        teamName: row[0],
        firstName: row[1] || '',
        lastName: row[2] || '',
        email: row[3] || ''
    })).filter(row => row.teamName && row.firstName);
}

function extractWorkbookGenders(workbookPath) {
    if (!workbookPath || !fs.existsSync(workbookPath)) {
        throw new Error(`Workbook not found: ${workbookPath || '(missing)'}`);
    }
    const pythonCode = [
        'import json, sys',
        'import openpyxl',
        'p=sys.argv[1]',
        'w=openpyxl.load_workbook(p, data_only=True, read_only=True)',
        's=w["W1 - Team Master"]',
        'rows=[]',
        'for c in range(1, s.max_column + 1):',
        '    gender=s.cell(4,c).value',
        '    name=s.cell(5,c).value',
        '    if gender is not None and name is not None:',
        '        gender=str(gender).strip().upper()',
        '        name=str(name).strip()',
        '        if gender in ("M","F") and name:',
        '            rows.append({"gender":gender,"name":name})',
        'print(json.dumps(rows))'
    ].join('\n');
    const result = spawnSync('python', ['-c', pythonCode, workbookPath], {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
    });
    if (result.status !== 0) {
        throw new Error(result.stderr || 'Workbook gender extraction failed.');
    }
    return JSON.parse(result.stdout);
}

function workbookGenderForPlayer(genderRows, firstName) {
    const target = firstName.trim().toLowerCase();
    const matches = genderRows.filter(row =>
        String(row.name).trim().split(/\s+/)[0].toLowerCase() === target
    );
    if (!matches.length) return null;
    const genders = new Set(matches.map(row => row.gender));
    return genders.size === 1 ? [...genders][0] : null;
}

function genderForTeamListPlayer(genderRows, firstName) {
    const workbookGender = workbookGenderForPlayer(genderRows, firstName);
    if (workbookGender) return workbookGender;
    const maleCsvOnlyNames = new Set([
        'Terry',
        'Jermey',
        'Shawn',
        'Gerald',
        'Jerry',
        'Sylvain',
        'Scott',
        'Kurt'
    ]);
    if (maleCsvOnlyNames.has(firstName.trim())) return 'M';
    return null;
}

async function findOrCreateTeam(client, name) {
    const canonical = canonicalTeamName(name);
    const result = await client.query('SELECT id, name FROM team');
    const match = result.rows.find(row =>
        canonicalTeamName(row.name) === canonical
    );
    if (match) {
        if (match.name !== canonical) {
            const updated = await client.query(
                `UPDATE team SET name = $1
                 WHERE id = $2
                   AND NOT EXISTS (
                       SELECT 1 FROM team WHERE name = $1 AND id <> $2
                   )
                 RETURNING id, name`,
                [canonical, match.id]
            );
            if (updated.rows.length) return updated.rows[0];
        } else {
            return match;
        }
    }
    const created = await client.query(
        `INSERT INTO team (name)
         VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name`,
        [canonical]
    );
    return created.rows[0];
}

async function mergeTeamAlias(client, exactTeam) {
    const duplicates = await client.query(
        'SELECT id, name FROM team'
    );
    const sourceIds = duplicates.rows
        .filter(row => canonicalTeamName(row.name) === exactTeam.name)
        .map(row => row.id)
        .filter(id => id !== exactTeam.id);
    for (const sourceId of sourceIds) {
        await client.query(
            `UPDATE fixture SET home_team_id = $1
             WHERE home_team_id = $2`,
            [exactTeam.id, sourceId]
        );
        await client.query(
            `UPDATE fixture SET away_team_id = $1
             WHERE away_team_id = $2`,
            [exactTeam.id, sourceId]
        );
        await client.query(
            `UPDATE match_game SET starting_team_id = $1
             WHERE starting_team_id = $2`,
            [exactTeam.id, sourceId]
        );
        await client.query(
            `UPDATE match_game SET winner_team_id = $1
             WHERE winner_team_id = $2`,
            [exactTeam.id, sourceId]
        );
        await client.query(
            `DELETE FROM team_game source_row
             WHERE source_row.team_id = $1
               AND EXISTS (
                   SELECT 1 FROM team_game exact_row
                   WHERE exact_row.match_game_id = source_row.match_game_id
                     AND exact_row.team_id = $2
               )`,
            [sourceId, exactTeam.id]
        );
        await client.query(
            'UPDATE team_game SET team_id = $1 WHERE team_id = $2',
            [exactTeam.id, sourceId]
        );
        await client.query(
            `DELETE FROM game_player_score source_row
             WHERE source_row.team_id = $1
               AND EXISTS (
                   SELECT 1 FROM game_player_score exact_row
                   WHERE exact_row.match_game_id = source_row.match_game_id
                     AND exact_row.player_id = source_row.player_id
                     AND exact_row.team_id = $2
               )`,
            [sourceId, exactTeam.id]
        );
        await client.query(
            'UPDATE game_player_score SET team_id = $1 WHERE team_id = $2',
            [exactTeam.id, sourceId]
        );
        await client.query(
            `DELETE FROM turn_score source_row
             WHERE source_row.team_id = $1
               AND EXISTS (
                   SELECT 1 FROM turn_score exact_row
                   WHERE exact_row.match_game_id = source_row.match_game_id
                     AND exact_row.player_id = source_row.player_id
                     AND exact_row.turn_number = source_row.turn_number
                     AND exact_row.team_id = $2
               )`,
            [sourceId, exactTeam.id]
        );
        await client.query(
            'UPDATE turn_score SET team_id = $1 WHERE team_id = $2',
            [exactTeam.id, sourceId]
        );
        await client.query(
            'DELETE FROM team_roster WHERE team_id = $1',
            [sourceId]
        );
        await client.query(
            'DELETE FROM team WHERE id = $1',
            [sourceId]
        );
    }
}

async function findOrCreatePlayer(client, firstName, lastName, gender) {
    const result = await client.query(
        `SELECT id FROM player
         WHERE lower(first_name) = lower($1)
           AND lower(COALESCE(last_name, '')) = lower($2)
         ORDER BY id
         LIMIT 1`,
        [firstName, lastName]
    );
    if (result.rows.length) {
        await client.query(
            'UPDATE player SET gender = $2 WHERE id = $1',
            [result.rows[0].id, gender]
        );
        return result.rows[0];
    }
    const created = await client.query(
        `INSERT INTO player (first_name, last_name, gender)
         VALUES ($1, $2, $3)
         ON CONFLICT (first_name, last_name) DO UPDATE SET gender = EXCLUDED.gender
         RETURNING id`,
        [firstName, lastName, gender]
    );
    return created.rows[0];
}

async function backfillTeamListRosters(pool, csvPath, workbookPath) {
    if (!pool || typeof pool.connect !== 'function') {
        throw new TypeError('A PostgreSQL pool with transactions is required.');
    }
    const rosterRows = parseTeamListCsv(fs.readFileSync(csvPath, 'utf8'));
    const genderRows = extractWorkbookGenders(workbookPath);

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
            'DELETE FROM team_roster WHERE season_id = $1',
            [season.id]
        );

        const teams = new Map();
        let imported = 0;
        const missingGenders = [];
        for (const row of rosterRows) {
            const teamName = canonicalTeamName(row.teamName);
            let team = teams.get(teamName);
            if (!team) {
                team = await findOrCreateTeam(client, teamName);
                await mergeTeamAlias(client, team);
                teams.set(teamName, team);
            }

            const gender = genderForTeamListPlayer(genderRows, row.firstName);
            if (!gender) {
                missingGenders.push(`${row.firstName} ${row.lastName}`.trim());
                continue;
            }
            const player = await findOrCreatePlayer(
                client, row.firstName, row.lastName, gender
            );
            await client.query(
                `INSERT INTO team_roster (
                    season_id, team_id, player_id, gender
                 )
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (season_id, team_id, player_id)
                 DO UPDATE SET gender = EXCLUDED.gender`,
                [season.id, team.id, player.id, gender]
            );
            imported++;
        }
        await client.query('COMMIT');
        return {
            season: season.name,
            teams: teams.size,
            imported,
            missingGenders
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
    if (!workbookPath) {
        console.error('Provide a workbook path as the third argument or set WORKBOOK_PATH.');
        process.exitCode = 1;
    } else {
        const pool = createPool();
        backfillTeamListRosters(pool, csvPath, workbookPath)
            .then(async result => {
                await pool.end();
                console.log(
                    `Imported ${result.imported} CSV roster entries across ${result.teams} teams for ${result.season}.`
                );
                if (result.missingGenders.length) {
                    console.error(`Missing workbook genders: ${result.missingGenders.join(', ')}`);
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
    backfillTeamListRosters,
    parseTeamListCsv,
    workbookGenderForPlayer,
    genderForTeamListPlayer,
    extractWorkbookGenders
};
