'use strict';

const crypto = require('node:crypto');

function splitPlayerName(name) {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 1) return { firstName: parts[0], lastName: '' };
    return {
        firstName: parts.slice(0, -1).join(' '),
        lastName: parts[parts.length - 1]
    };
}

function canonicalTeamName(name) {
    const normalized = String(name)
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/^The\s+/i, '')
        .replace(/\s+\(\d+\)\s*$/, '')
        .replace(/!$/, '')
        .replace(/^Wine\s+Villans$/i, 'Wine Villains')
        .trim();
    const aliases = {
        'marksmen': 'The Marksmen',
        'marksman': 'The Marksmen',
        'avengers': 'The Avengers',
        'flight risk': 'Flight Risk',
        'bull moose': 'Bull Moose',
        'aimless wonders': 'Aimless Wonders',
        'killer bees': 'Killer Bees',
        'just the tip': 'Just The Tip',
        'snipers': 'The Snipers',
        'wine villains': 'Wine Villains',
        'unemployed pornstars': 'Unemployed Pornstars',
        'jug zone': 'Jug Zone',
        'keepers': 'The Keepers'
    };
    return aliases[normalized.toLowerCase()] || normalized;
}

function inferSeasonName(matchDate) {
    const date = new Date(`${matchDate}T00:00:00.000Z`);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const startYear = month >= 7 ? year : year - 1;
    return `${startYear}-${startYear + 1}`;
}

async function findOrCreateTeam(client, name) {
    const canonical = canonicalTeamName(name);
    const existing = await client.query(
        'SELECT id, name FROM team ORDER BY id',
        []
    );
    const exact = existing.rows.find(row => row.name === name);
    if (exact) return exact;
    const matched = existing.rows.find(row =>
        canonicalTeamName(row.name) === canonical
    );
    if (matched) return matched;

    const created = await client.query(
        `INSERT INTO team (name)
         VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, name`,
        [canonical]
    );
    return created.rows[0];
}

async function findOrCreatePlayer(client, name) {
    const { firstName, lastName } = splitPlayerName(name);
    const existing = await client.query(
        `SELECT id FROM player
         WHERE first_name = $1 AND last_name IS NOT DISTINCT FROM $2
         LIMIT 1`,
        [firstName, lastName]
    );
    if (existing.rows.length) return existing.rows[0];

    const created = await client.query(
        `INSERT INTO player (first_name, last_name)
         VALUES ($1, $2)
         ON CONFLICT (first_name, last_name) DO UPDATE
         SET first_name = EXCLUDED.first_name
         RETURNING id`,
        [firstName, lastName]
    );
    return created.rows[0];
}

async function ensureSeason(client, matchDate) {
    const active = await client.query(
        'SELECT id, name FROM season WHERE active = TRUE LIMIT 1'
    );
    if (!active.rows.length) {
        throw new ImportConflict('No active season exists; configure it before submitting scores.');
    }
    return active.rows[0];
}

async function ensureFixture(client, seasonId, fixture) {
    const season = await client.query(
        'SELECT baseline_through_week FROM season WHERE id = $1',
        [seasonId]
    );
    if (season.rows.length &&
        Number(season.rows[0].baseline_through_week) > 0) {
        const cutoff = await client.query(
            `SELECT MAX(match_date) AS cutoff_date
             FROM fixture
             WHERE season_id = $1
               AND week_number <= $2`,
            [seasonId, Number(season.rows[0].baseline_through_week)]
        );
        const cutoffDate = cutoff.rows[0]?.cutoff_date;
        if (cutoffDate) {
            const normalizedCutoff = cutoffDate instanceof Date
                ? cutoffDate.toISOString().slice(0, 10)
                : String(cutoffDate).slice(0, 10);
            if (fixture.matchDate <= normalizedCutoff) {
                throw new ImportConflict(
                    `Week ${season.rows[0].baseline_through_week} and earlier are preserved from the workbook; new submissions cannot alter them.`
                );
            }
        }
        const cutoffMatch = await client.query(
            `SELECT week_number
             FROM fixture
             WHERE season_id = $1
               AND match_date = $2::DATE
               AND board_number IS NOT DISTINCT FROM $3
               AND (
                    (home_team_id = $4 AND away_team_id = $5)
                 OR (home_team_id = $5 AND away_team_id = $4)
               )
             LIMIT 1`,
            [seasonId, fixture.matchDate, fixture.board,
             fixture.teamId, fixture.opponentId]
        );
        if (cutoffMatch.rows.length &&
            Number(cutoffMatch.rows[0].week_number) <=
                Number(season.rows[0].baseline_through_week)) {
            throw new ImportConflict(
                `Week ${cutoffMatch.rows[0].week_number} is preserved from the workbook; new submissions cannot alter it.`
            );
        }
    }
    const existing = await client.query(
        `SELECT id, home_team_id, away_team_id
         FROM fixture
         WHERE match_date = $1::DATE
           AND board_number IS NOT DISTINCT FROM $2
           AND (
                (home_team_id = $3 AND away_team_id = $4)
             OR (home_team_id = $4 AND away_team_id = $3)
           )
         LIMIT 1`,
        [fixture.matchDate, fixture.board, fixture.teamId, fixture.opponentId]
    );
    if (existing.rows.length) return existing.rows[0];
    throw new ImportConflict(
        'No scheduled match exists for this date, board, team, and opponent.'
    );
}

async function ensureRoster(client, seasonId, teamId, playerId) {
    await client.query(
        `INSERT INTO team_roster (season_id, team_id, player_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (season_id, team_id, player_id) DO NOTHING`,
        [seasonId, teamId, playerId]
    );
}

function ImportConflict(message) {
    const error = new Error(message);
    error.code = 'LEAGUE_IMPORT_CONFLICT';
    return error;
}

async function normalizeScoreCsvUpload(client, csvText, fixture, uploadedAt, parseCsv) {
    if (typeof parseCsv !== 'function') {
        parseCsv = require('../server').parseCsv;
    }
    const parsed = parseCsv(csvText)
        .filter(row => !row.every(value => !value.trim()));
    const header = parsed[0].map(value => value.trim());
    const roundIndexes = header
        .map((value, index) => ({ value, index }))
        .filter(item => /^round_\d+$/.test(item.value));
    const checkoutIndex = header.indexOf('Checkout');

    const season = await ensureSeason(client, fixture.matchDate);
    const team = await findOrCreateTeam(client, fixture.team);
    const opponent = await findOrCreateTeam(client, fixture.opponent);
    const reconciledFixture = await ensureFixture(client, season.id, {
        ...fixture,
        teamId: team.id,
        opponentId: opponent.id
    });

    const groupedGames = new Map();
    for (const rawRow of parsed.slice(1)) {
        const row = rawRow.map(value => value.trim());
        const gameNumber = Number(row[2]);
        const playerName = row[6];
        const winnerName = row[5];
        const game = groupedGames.get(gameNumber) || {
            gameNumber,
            winnerName,
            rows: []
        };
        if (game.winnerName !== winnerName) {
            throw ImportConflict(`Game ${gameNumber} contains conflicting winners.`);
        }
        game.rows.push(row);
        groupedGames.set(gameNumber, game);
    }

    for (const game of groupedGames.values()) {
        let winnerTeamId;
        if (canonicalTeamName(game.winnerName) === canonicalTeamName(fixture.team)) {
            winnerTeamId = team.id;
        } else if (canonicalTeamName(game.winnerName) === canonicalTeamName(fixture.opponent)) {
            winnerTeamId = opponent.id;
        } else {
            throw ImportConflict(`Game ${game.gameNumber} has an unknown winner.`);
        }

        const existingGame = await client.query(
            `SELECT winner_team_id FROM match_game
             WHERE fixture_id = $1 AND game_number = $2`,
            [reconciledFixture.id, game.gameNumber]
        );
        if (existingGame.rows.length &&
            existingGame.rows[0].winner_team_id &&
            Number(existingGame.rows[0].winner_team_id) !== Number(winnerTeamId)) {
            throw ImportConflict(
                `Game ${game.gameNumber} conflicts with an earlier winner submission.`
            );
        }

        const gameResult = await client.query(
            `INSERT INTO match_game (
                fixture_id, game_number, winner_team_id, status
             )
             VALUES ($1, $2, $3, 'finished')
             ON CONFLICT (fixture_id, game_number)
             DO UPDATE SET
                winner_team_id = EXCLUDED.winner_team_id,
                status = 'finished',
                updated_at = CURRENT_TIMESTAMP
             RETURNING id`,
            [reconciledFixture.id, game.gameNumber, winnerTeamId]
        );
        const matchGameId = gameResult.rows[0].id;

        for (const side of [
            { teamId: team.id, isWinner: winnerTeamId === team.id },
            { teamId: opponent.id, isWinner: winnerTeamId === opponent.id }
        ]) {
            await client.query(
                `INSERT INTO team_game (match_game_id, team_id, is_winner)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (match_game_id, team_id)
                 DO UPDATE SET is_winner = EXCLUDED.is_winner`,
                [matchGameId, side.teamId, side.isWinner]
            );
        }

        const sourceKey = [
            fixture.matchDate, fixture.board, canonicalTeamName(fixture.team),
            game.gameNumber
        ].join('|');
        const submission = await client.query(
            `INSERT INTO game_submission (
                fixture_id, match_game_id, source, source_key, status,
                raw_payload, accepted_at
             )
             VALUES ($1, $2, 'csv', $3, 'accepted', $4::JSONB, CURRENT_TIMESTAMP)
             ON CONFLICT (source, source_key)
             DO UPDATE SET
                fixture_id = EXCLUDED.fixture_id,
                match_game_id = EXCLUDED.match_game_id,
                status = 'accepted',
                raw_payload = EXCLUDED.raw_payload,
                accepted_at = CURRENT_TIMESTAMP
             RETURNING id`,
            [
                reconciledFixture.id,
                matchGameId,
                sourceKey,
                JSON.stringify(game.rows)
            ]
        );
        const submissionId = submission.rows[0].id;
        await client.query(
            `UPDATE game_submission
             SET status = 'superseded'
             WHERE match_game_id = $1
               AND id <> $2
               AND status = 'accepted'`,
            [matchGameId, submissionId]
        );

        await client.query(
            'DELETE FROM turn_score WHERE submission_id = $1',
            [submissionId]
        );

        for (const row of game.rows) {
            const playerName = row[6];
            const player = await findOrCreatePlayer(client, playerName);
            const playerTeamId = team.id;
            await ensureRoster(client, season.id, playerTeamId, player.id);
            await client.query(
                `INSERT INTO game_player_score (
                    match_game_id, team_id, player_id
                 )
                 VALUES ($1, $2, $3)
                 ON CONFLICT (match_game_id, team_id, player_id)
                 DO UPDATE SET is_lineup_player = TRUE`,
                [matchGameId, playerTeamId, player.id]
            );

            let turnNumber = 0;
            for (const roundItem of roundIndexes) {
                const scoreText = row[roundItem.index] || '';
                if (!scoreText) continue;
                turnNumber++;
                const score = Number(scoreText);
                const checkoutText = checkoutIndex >= 0 ? (row[checkoutIndex] || '') : '';
                const checkoutRemaining = /^\d+$/.test(checkoutText)
                    ? Number(checkoutText)
                    : null;
                await client.query(
                    `INSERT INTO turn_score (
                        submission_id, match_game_id, team_id, player_id,
                        turn_number, score, checkout_remaining
                     )
                     VALUES ($1, $2, $3, $4, $5, $6, $7)
                     ON CONFLICT (
                        match_game_id, team_id, player_id, turn_number
                     )
                     DO UPDATE SET
                        submission_id = EXCLUDED.submission_id,
                        score = EXCLUDED.score,
                        checkout_remaining = EXCLUDED.checkout_remaining`,
                    [
                        submissionId, matchGameId, playerTeamId, player.id,
                        turnNumber, score, checkoutRemaining
                    ]
                );
            }
        }
    }

    return {
        seasonId: season.id,
        fixtureId: reconciledFixture.id,
        uploadedAt
    };
}

async function importScoreCsvUpload(pool, csvText, fixture, parseCsv) {
    if (!pool || typeof pool.query !== 'function') {
        throw new TypeError('A PostgreSQL pool is required.');
    }
    if (typeof pool.connect !== 'function') {
        return null;
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const result = await client.query(
            `INSERT INTO score_csv_uploads (
                match_date, board, team, opponent, csv_data, row_count
             )
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (match_date, board, team)
             DO UPDATE SET
                opponent = EXCLUDED.opponent,
                csv_data = EXCLUDED.csv_data,
                row_count = EXCLUDED.row_count,
                uploaded_at = CURRENT_TIMESTAMP
             RETURNING uploaded_at`,
            [
                fixture.matchDate, fixture.board, fixture.team,
                fixture.opponent, csvText, fixture.rowCount
            ]
        );

        const normalized = await normalizeScoreCsvUpload(
            client, csvText, fixture, result.rows[0].uploaded_at, parseCsv
        );
        await client.query('COMMIT');
        return normalized;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function backfillScoreCsvUploads(pool, parseCsv) {
    if (!pool || typeof pool.query !== 'function') {
        throw new TypeError('A PostgreSQL pool is required.');
    }
    const result = await pool.query(
        `SELECT match_date, board, team, opponent, csv_data, row_count
         FROM score_csv_uploads
         ORDER BY match_date, board, team`
    );

    const processed = [];
    const conflicts = [];
    for (const upload of result.rows) {
        const fixture = {
            matchDate: upload.match_date instanceof Date
                ? upload.match_date.toISOString().slice(0, 10)
                : String(upload.match_date).slice(0, 10),
            board: upload.board,
            team: upload.team,
            opponent: upload.opponent,
            rowCount: upload.row_count
        };
        try {
            await importScoreCsvUpload(
                pool, upload.csv_data, fixture, parseCsv
            );
            processed.push({
                matchDate: fixture.matchDate,
                board: fixture.board,
                team: fixture.team
            });
        } catch (error) {
            if (error.code === 'LEAGUE_IMPORT_CONFLICT') {
                conflicts.push({
                    matchDate: fixture.matchDate,
                    board: fixture.board,
                    team: fixture.team,
                    error: error.message
                });
            } else {
                throw error;
            }
        }
    }
    return { processed, conflicts };
}

module.exports = {
    backfillScoreCsvUploads,
    canonicalTeamName,
    importScoreCsvUpload,
    inferSeasonName,
    normalizeScoreCsvUpload,
    splitPlayerName
};
