'use strict';

const { spawnSync } = require('node:child_process');
const { createPool } = require('./connection');
const { canonicalTeamName, splitPlayerName } = require('./import-score-csv');

function cellText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number') return String(value);
    if (typeof value === 'object' && typeof value.text === 'string') return value.text.trim();
    return String(value).trim();
}

async function extractWorkbookRosters(workbookPath) {
    const pythonCode = [
        'import json, sys',
        'import openpyxl',
        'p=sys.argv[1]',
        'w=openpyxl.load_workbook(p, data_only=True, read_only=True)',
        's=w["W1 - Team Master"]',
        'rows=[]',
        'team=""',
        'for c in range(1, s.max_column + 1):',
        '    heading=s.cell(1,c).value',
        '    if heading is not None:',
        '        heading=str(heading).strip()',
        '        if heading and not heading.lower().startswith("week "):',
        '            team=heading',
        '    gender=s.cell(4,c).value',
        '    name=s.cell(5,c).value',
        '    if team and name is not None:',
        '        gender=str(gender).strip().upper() if gender is not None else ""',
        '        name=str(name).strip()',
        '        if gender in ("M","F") and name:',
        '            rows.append({"teamName":team,"gender":gender,"name":name})',
        'print(json.dumps(rows))'
    ].join('\n');
    const result = spawnSync('python', ['-c', pythonCode, workbookPath], {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
    });
    if (result.status !== 0) {
        throw new Error(result.stderr || 'Workbook roster extraction failed.');
    }
    const rosters = JSON.parse(result.stdout);
    return rosters.map(roster => ({
        ...roster,
        teamName: canonicalTeamName(roster.teamName)
    }));
}

async function findOrCreateTeam(client, name) {
    const result = await client.query('SELECT id, name FROM team');
    const canonical = canonicalTeamName(name);
    const match = result.rows.find(row =>
        canonicalTeamName(row.name) === canonical
    );
    if (match) return match;

    const created = await client.query(
        `INSERT INTO team (name)
         VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name`,
        [canonical]
    );
    return created.rows[0];
}

async function findOrCreatePlayer(client, name, gender) {
    const { firstName, lastName } = splitPlayerName(name);
    const existing = await client.query(
        `SELECT id FROM player
         WHERE first_name = $1 AND last_name IS NOT DISTINCT FROM $2
         LIMIT 1`,
        [firstName, lastName]
    );
    if (existing.rows.length) {
        await client.query(
            'UPDATE player SET gender = $2 WHERE id = $1',
            [existing.rows[0].id, gender]
        );
        return existing.rows[0];
    }
    const created = await client.query(
        `INSERT INTO player (first_name, last_name, gender)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [firstName, lastName, gender]
    );
    return created.rows[0];
}

async function backfillWorkbookRosters(pool, workbookPath) {
    if (!pool || typeof pool.connect !== 'function') {
        throw new TypeError('A PostgreSQL pool with transactions is required.');
    }
    const rosters = await extractWorkbookRosters(workbookPath);
    const season = await pool.query(
        'SELECT id, name FROM season WHERE active = TRUE LIMIT 1'
    );
    if (!season.rows.length) {
        throw new Error('No active season exists. Create it before importing workbook rosters.');
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let imported = 0;
        for (const roster of rosters) {
            const team = await findOrCreateTeam(client, roster.teamName);
            const player = await findOrCreatePlayer(client, roster.name, roster.gender);
            await client.query(
                `INSERT INTO team_roster (
                    season_id, team_id, player_id, gender
                 )
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (season_id, team_id, player_id)
                 DO UPDATE SET gender = EXCLUDED.gender`,
                [season.rows[0].id, team.id, player.id, roster.gender]
            );
            imported++;
        }
        await client.query('COMMIT');
        return { season: season.rows[0].name, imported };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

if (require.main === module) {
    const workbookPath = process.argv[2] || process.env.WORKBOOK_PATH;
    if (!workbookPath) {
        console.error('Provide a workbook path or set WORKBOOK_PATH.');
        process.exitCode = 1;
    } else {
        const pool = createPool();
        backfillWorkbookRosters(pool, workbookPath)
            .then(async result => {
                await pool.end();
                console.log(
                    `Imported ${result.imported} roster entries for ${result.season}.`
                );
            })
            .catch(async error => {
                await pool.end().catch(() => {});
                console.error(error);
                process.exitCode = 1;
            });
    }
}

module.exports = {
    backfillWorkbookRosters,
    extractWorkbookRosters,
    cellText
};
