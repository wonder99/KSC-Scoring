'use strict';

const fs = require('node:fs');
const { createPool } = require('./connection');
const { canonicalTeamName } = require('./import-score-csv');

function parseScheduleCsv(csvText) {
    const rows = String(csvText).replace(/^\uFEFF/, '').trimEnd()
        .split(/\r?\n/)
        .filter(row => row.trim());
    if (!rows.length) return [];

    const header = rows.shift().split(',').map(value => value.trim());
    const dateIndex = header.indexOf('date');
    const boardIndex = header.indexOf('board');
    const team1Index = header.indexOf('team_1');
    const team2Index = header.indexOf('team_2');
    if ([dateIndex, boardIndex, team1Index, team2Index].some(index => index < 0)) {
        throw new Error('Schedule CSV must contain date, board, team_1, and team_2 headers.');
    }
    return rows.map(row => {
        const values = row.split(',').map(value => value.trim());
        return {
            date: values[dateIndex],
            board: values[boardIndex],
            team1: values[team1Index],
            team2: values[team2Index]
        };
    });
}

async function findOrCreateTeam(client, name) {
    const canonical = canonicalTeamName(name);
    const result = await client.query('SELECT id, name FROM team');
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

async function backfillSchedule(pool, csvPath) {
    if (!pool || typeof pool.connect !== 'function') {
        throw new TypeError('A PostgreSQL pool with transactions is required.');
    }
    const csvText = fs.readFileSync(csvPath, 'utf8');
    const schedule = parseScheduleCsv(csvText);
    if (!schedule.length) throw new Error('Schedule CSV contains no fixture rows.');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const seasonResult = await client.query(
            'SELECT id, name FROM season WHERE active = TRUE LIMIT 1'
        );
        if (!seasonResult.rows.length) {
            throw new Error('No active season exists. Create it before importing the schedule.');
        }
        const season = seasonResult.rows[0];

        const dates = [...new Set(schedule.map(row => row.date))]
            .sort((left, right) => left.localeCompare(right));
        const weekByDate = new Map(
            dates.map((date, index) => [date, index + 1])
        );

        let imported = 0;
        for (const row of schedule) {
            if (!row.date || !row.board || !row.team1 || !row.team2) {
                throw new Error(`Schedule row is incomplete: ${JSON.stringify(row)}`);
            }
            const team1 = await findOrCreateTeam(client, row.team1);
            const team2 = await findOrCreateTeam(client, row.team2);
            if (team1.id === team2.id) {
                throw new Error(`Fixture contains the same team twice: ${row.team1}`);
            }
            const result = await client.query(
                `INSERT INTO fixture (
                    season_id, week_number, match_date, board_number,
                    home_team_id, away_team_id
                 )
                 VALUES ($1, $2, $3::DATE, $4, $5, $6)
                 ON CONFLICT DO NOTHING
                 RETURNING id`,
                [
                    season.id, weekByDate.get(row.date), row.date,
                    row.board, team1.id, team2.id
                ]
            );
            if (result.rows.length) imported++;
        }
        await client.query('COMMIT');
        return { season: season.name, imported, weeks: dates.length };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

if (require.main === module) {
    const csvPath = process.argv[2] || 'dart_league_schedule.csv';
    const pool = createPool();
    backfillSchedule(pool, csvPath)
        .then(async result => {
            await pool.end();
            console.log(
                `Imported ${result.imported} fixtures across ${result.weeks} weeks for ${result.season}.`
            );
        })
        .catch(async error => {
            await pool.end().catch(() => {});
            console.error(error);
            process.exitCode = 1;
        });
}

module.exports = { backfillSchedule, parseScheduleCsv };
