'use strict';

const { canonicalTeamName } = require('./import-score-csv');

function validateBrowserSubmission(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Submission must be a JSON object.');
    }
    const isDate = value => typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value);
    if (!isDate(payload.matchDate)) {
        throw new Error('matchDate must use YYYY-MM-DD.');
    }
    if (typeof payload.board !== 'string' || !payload.board.trim()) {
        throw new Error('board is required.');
    }
    if (typeof payload.team !== 'string' || !payload.team.trim()) {
        throw new Error('team is required.');
    }
    if (typeof payload.opponent !== 'string' || !payload.opponent.trim()) {
        throw new Error('opponent is required.');
    }
    if (!Array.isArray(payload.games) || payload.games.length === 0) {
        throw new Error('games must contain at least one completed game.');
    }
    if (payload.games.length > 7) {
        throw new Error('games cannot contain more than seven entries.');
    }

    const games = new Set();
    for (const game of payload.games) {
        if (!game || typeof game !== 'object') {
            throw new Error('Each game must be an object.');
        }
        if (!Number.isInteger(game.game) || game.game < 1 || game.game > 7) {
            throw new Error('A game number must be between 1 and 7.');
        }
        if (games.has(game.game)) {
            throw new Error(`Game ${game.game} was submitted more than once.`);
        }
        games.add(game.game);

        const winner = canonicalTeamName(game.winner);
        if (![
            canonicalTeamName(payload.team),
            canonicalTeamName(payload.opponent)
        ].includes(winner)) {
            throw new Error(`Game ${game.game} has an unknown winner.`);
        }
        if (!Array.isArray(game.players) || game.players.length < 1 || game.players.length > 4) {
            throw new Error(`Game ${game.game} must contain between 1 and 4 players.`);
        }
        const names = new Set();
        for (const player of game.players) {
            if (!player || typeof player.name !== 'string' || !player.name.trim()) {
                throw new Error(`Game ${game.game} contains an invalid player.`);
            }
            if (names.has(player.name.trim())) {
                throw new Error(`Game ${game.game} contains a duplicate player.`);
            }
            names.add(player.name.trim());
        }
        if (!Array.isArray(game.turns)) {
            throw new Error(`Game ${game.game} turns must be an array.`);
        }
        for (const turn of game.turns) {
            if (!turn || typeof turn !== 'object') {
                throw new Error(`Game ${game.game} contains an invalid turn.`);
            }
            if (!names.has(String(turn.player || '').trim())) {
                throw new Error(`Game ${game.game} contains a turn for a player outside the lineup.`);
            }
            if (!Number.isInteger(turn.score) || turn.score < 0 || turn.score > 180) {
                throw new Error(`Game ${game.game} contains an invalid turn score.`);
            }
            if (typeof turn.busted !== 'boolean') {
                throw new Error(`Game ${game.game} contains a turn with no bust state.`);
            }
            if (!Number.isInteger(turn.remainingBefore) ||
                !Number.isInteger(turn.remainingAfter) ||
                turn.remainingBefore < 0 || turn.remainingBefore > 701 ||
                turn.remainingAfter < 0 || turn.remainingAfter > 701) {
                throw new Error(`Game ${game.game} contains invalid remaining scores.`);
            }
            if (!Array.isArray(turn.darts)) {
                throw new Error(`Game ${game.game} contains invalid dart details.`);
            }
        }
    }
    return payload;
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

function splitPlayerName(name) {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length === 1) return { firstName: parts[0], lastName: '' };
    return {
        firstName: parts.slice(0, -1).join(' '),
        lastName: parts[parts.length - 1]
    };
}

async function findOrCreatePlayer(client, name) {
    const { firstName, lastName } = splitPlayerName(name);
    const existing = await client.query(
        `SELECT id FROM player
         WHERE lower(first_name) = lower($1)
           AND lower(COALESCE(last_name, '')) = lower($2)
         ORDER BY id
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

async function resolveRosterPlayerName(client, seasonId, teamId, name) {
    const { firstName, lastName } = splitPlayerName(name);
    if (String(name).trim().toLowerCase() === 'spare') return 'Spare';
    if (lastName) {
        const exact = await client.query(
            `SELECT p.first_name, p.last_name
             FROM team_roster tr
             JOIN player p ON p.id = tr.player_id
             WHERE tr.season_id = $1
               AND tr.team_id = $2
               AND lower(p.first_name) = lower($3)
               AND lower(COALESCE(p.last_name, '')) = lower($4)
             LIMIT 1`,
            [seasonId, teamId, firstName, lastName]
        );
        if (!exact.rows.length) {
            throw new Error(`${name.trim()} is not on this team's active roster.`);
        }
        return [exact.rows[0].first_name, exact.rows[0].last_name]
            .filter(Boolean)
            .join(' ');
    }
    const result = await client.query(
        `SELECT p.first_name, p.last_name
         FROM team_roster tr
         JOIN player p ON p.id = tr.player_id
         WHERE tr.season_id = $1
           AND tr.team_id = $2
           AND lower(p.first_name) = lower($3)
         ORDER BY
           CASE WHEN COALESCE(p.last_name, '') = '' THEN 1 ELSE 0 END,
           p.last_name,
           p.id
         LIMIT 2`,
        [seasonId, teamId, firstName]
    );
    if (result.rows.length === 1) {
        return [result.rows[0].first_name, result.rows[0].last_name]
            .filter(Boolean)
            .join(' ');
    }
    if (!result.rows.length) {
        throw new Error(`${name.trim()} is not on this team's active roster.`);
    }
    throw new Error(`Player name "${name.trim()}" is ambiguous on this team's active roster.`);
}

async function ensureSeason(client, matchDate) {
    const active = await client.query(
        'SELECT id, name FROM season WHERE active = TRUE LIMIT 1'
    );
    if (!active.rows.length) {
        throw new Error('No active season exists; configure it before submitting scores.');
    }
    return active.rows[0];
}

async function ensureFixture(client, seasonId, payload, team, opponent) {
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
            if (payload.matchDate <= normalizedCutoff) {
                throw new Error(
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
            [seasonId, payload.matchDate, payload.board, team.id, opponent.id]
        );
        if (cutoffMatch.rows.length &&
            Number(cutoffMatch.rows[0].week_number) <=
                Number(season.rows[0].baseline_through_week)) {
            throw new Error(
                `Week ${cutoffMatch.rows[0].week_number} is preserved from the workbook; new submissions cannot alter it.`
            );
        }
    }
    const existing = await client.query(
        `SELECT id, home_team_id, away_team_id
         FROM fixture
         WHERE season_id = $1
           AND match_date = $2::DATE
           AND board_number IS NOT DISTINCT FROM $3
           AND (
                (home_team_id = $4 AND away_team_id = $5)
             OR (home_team_id = $5 AND away_team_id = $4)
           )
         LIMIT 1`,
        [seasonId, payload.matchDate, payload.board, team.id, opponent.id]
    );
    if (existing.rows.length) return existing.rows[0];
    throw new Error(
        'No scheduled match exists for this date, board, team, and opponent.'
    );
}

async function normalizeBrowserSubmission(pool, payload, compatibilityCsvText, compatibilityRowCount) {
    validateBrowserSubmission(payload);
    if (!pool || typeof pool.connect !== 'function') {
        throw new TypeError('Transactional browser submissions require PostgreSQL.');
    }

    const client = await pool.connect();
    let rowCount = 0;
    try {
        await client.query('BEGIN');
        const season = await ensureSeason(client, payload.matchDate);
        const team = await findOrCreateTeam(client, payload.team);
        const opponent = await findOrCreateTeam(client, payload.opponent);
        const fixture = await ensureFixture(client, season.id, payload, team, opponent);

        for (const game of payload.games) {
            const winnerName = canonicalTeamName(game.winner);
            let winnerTeamId;
            if (winnerName === canonicalTeamName(team.name)) {
                winnerTeamId = team.id;
            } else if (winnerName === canonicalTeamName(opponent.name)) {
                winnerTeamId = opponent.id;
            } else {
                throw new Error(`Game ${game.game} has an unknown winner.`);
            }

            const existing = await client.query(
                `SELECT winner_team_id FROM match_game
                 WHERE fixture_id = $1 AND game_number = $2`,
                [fixture.id, game.game]
            );
            if (existing.rows.length &&
                existing.rows[0].winner_team_id &&
                Number(existing.rows[0].winner_team_id) !== Number(winnerTeamId)) {
                throw new Error(`Game ${game.game} conflicts with an earlier winner submission.`);
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
                [fixture.id, game.game, winnerTeamId]
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
                payload.matchDate, payload.board,
                canonicalTeamName(payload.team), game.game
            ].join('|');
            const submission = await client.query(
                `INSERT INTO game_submission (
                    fixture_id, match_game_id, source, source_key, status,
                    raw_payload, accepted_at
                 )
                 VALUES ($1, $2, 'browser', $3, 'accepted', $4::JSONB, CURRENT_TIMESTAMP)
                 ON CONFLICT (source, source_key)
                 DO UPDATE SET
                    fixture_id = EXCLUDED.fixture_id,
                    match_game_id = EXCLUDED.match_game_id,
                    status = 'accepted',
                    raw_payload = EXCLUDED.raw_payload,
                    accepted_at = CURRENT_TIMESTAMP
                 RETURNING id`,
                [
                    fixture.id,
                    matchGameId,
                    sourceKey,
                    JSON.stringify(game)
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
            await client.query(
                'DELETE FROM game_player_score WHERE match_game_id = $1 AND team_id = $2',
                [matchGameId, team.id]
            );

            for (const playerData of game.players) {
                const canonicalName = await resolveRosterPlayerName(
                    client,
                    season.id,
                    team.id,
                    playerData.name
                );
                const player = await findOrCreatePlayer(client, canonicalName);
                if (canonicalName !== 'Spare') {
                    await client.query(
                        `INSERT INTO team_roster (season_id, team_id, player_id)
                         VALUES ($1, $2, $3)
                         ON CONFLICT (season_id, team_id, player_id) DO NOTHING`,
                        [season.id, team.id, player.id]
                    );
                }
                await client.query(
                    `INSERT INTO game_player_score (
                        match_game_id, team_id, player_id
                     )
                     VALUES ($1, $2, $3)
                     ON CONFLICT (match_game_id, team_id, player_id)
                     DO UPDATE SET is_lineup_player = TRUE`,
                    [matchGameId, team.id, player.id]
                );
            }

            let turnNumberByPlayer = new Map();
            let playOrder = 0;
            for (const turn of game.turns) {
                const canonicalName = await resolveRosterPlayerName(
                    client,
                    season.id,
                    team.id,
                    turn.player
                );
                const player = await findOrCreatePlayer(client, canonicalName);
                const nextTurnNumber = (turnNumberByPlayer.get(player.id) || 0) + 1;
                turnNumberByPlayer.set(player.id, nextTurnNumber);
                const checkoutRemaining = turn.checkoutRemaining === 0 ||
                    turn.remainingAfter === 0
                    ? 0
                    : null;
                await client.query(
                    `INSERT INTO turn_score (
                        submission_id, match_game_id, team_id, player_id,
                        turn_number, play_order, score, dart_scores, is_bust,
                        remaining_before, remaining_after, checkout_remaining
                     )
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB, $9, $10, $11, $12)
                     ON CONFLICT (
                        match_game_id, team_id, player_id, turn_number
                     )
                     DO UPDATE SET
                        submission_id = EXCLUDED.submission_id,
                        play_order = EXCLUDED.play_order,
                        score = EXCLUDED.score,
                        dart_scores = EXCLUDED.dart_scores,
                        is_bust = EXCLUDED.is_bust,
                        remaining_before = EXCLUDED.remaining_before,
                        remaining_after = EXCLUDED.remaining_after,
                        checkout_remaining = EXCLUDED.checkout_remaining`,
                    [
                        submissionId,
                        matchGameId,
                        team.id,
                        player.id,
                        nextTurnNumber,
                        playOrder,
                        turn.score,
                        JSON.stringify(turn.darts),
                        turn.busted,
                        turn.remainingBefore,
                        turn.remainingAfter,
                        checkoutRemaining
                    ]
                );
                playOrder++;
                rowCount++;
            }
        }

        let uploadedAt = null;
        if (typeof compatibilityCsvText === 'string' && compatibilityCsvText.length) {
            const csvResult = await client.query(
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
                    payload.matchDate,
                    payload.board,
                    payload.team,
                    payload.opponent,
                    compatibilityCsvText,
                    Number.isInteger(compatibilityRowCount)
                        ? compatibilityRowCount
                        : rowCount
                ]
            );
            uploadedAt = csvResult.rows[0].uploaded_at;
        }

        await client.query('COMMIT');
        return {
            fixtureId: fixture.id,
            gameCount: payload.games.length,
            rowCount,
            uploadedAt
        };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    normalizeBrowserSubmission,
    validateBrowserSubmission
};
