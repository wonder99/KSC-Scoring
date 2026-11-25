'use strict';

function reviewError(message) {
    const error = new Error(message);
    error.code = 'INVALID_SUBMISSION_REVIEW';
    return error;
}

async function lockSubmission(client, submissionId) {
    const target = await client.query(
        'SELECT fixture_id, upload_id FROM game_submission WHERE id = $1',
        [submissionId]
    );
    if (!target.rows.length) return null;
    const { fixture_id: fixtureId, upload_id: uploadId } = target.rows[0];
    if (fixtureId) {
        await client.query('SELECT id FROM fixture WHERE id = $1 FOR UPDATE', [fixtureId]);
    }
    const selected = await client.query(
        `SELECT id, fixture_id, match_game_id, submitted_team_id, winner_team_id, source, status
         FROM game_submission
         WHERE ($1::uuid IS NOT NULL AND upload_id = $1)
            OR ($1::uuid IS NULL AND id = $2)
         ORDER BY match_game_id, id
         FOR UPDATE`,
        [uploadId, submissionId]
    );
    if (!selected.rows.length) return null;
    if (selected.rows.some(row => row.fixture_id !== fixtureId)) {
        throw reviewError('The upload contains games from different matches and cannot be reviewed.');
    }
    return { fixtureId, uploadId, rows: selected.rows };
}

async function setSubmissionStatus(pool, submissionId, status) {
    if (!pool || typeof pool.connect !== 'function') {
        throw new Error('Transactional submission review requires PostgreSQL.');
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const selected = await lockSubmission(client, submissionId);
        if (!selected) {
            await client.query('ROLLBACK');
            return null;
        }
        const { fixtureId, uploadId, rows } = selected;
        if (!fixtureId) throw reviewError('The submission is not linked to a match.');
        if (rows.some(row =>
            !row.match_game_id || !row.submitted_team_id ||
            (status === 'accepted' && !row.winner_team_id)
        )) {
            throw reviewError('The submission is missing its game, team, or winner; it cannot be reviewed.');
        }
        const ids = rows.map(row => row.id);
        if (status === 'accepted') {
            for (const row of rows) {
                await client.query(
                    `UPDATE game_submission SET status = 'superseded'
                     WHERE match_game_id = $1 AND submitted_team_id = $2
                       AND status = 'accepted' AND NOT (id = ANY($3::int[]))`,
                    [row.match_game_id, row.submitted_team_id, ids]
                );
            }
        }
        const result = await client.query(
            `UPDATE game_submission
             SET status = $1,
                 accepted_at = CASE WHEN $1 = 'accepted'
                                    THEN clock_timestamp() ELSE accepted_at END
             WHERE id = ANY($2::int[])
             RETURNING id, status, accepted_at`,
            [status, ids]
        );

        for (const row of rows) {
            const winner = await client.query(
                `SELECT winner_team_id FROM game_submission
                 WHERE match_game_id = $1 AND status = 'accepted'
                   AND winner_team_id IS NOT NULL
                 ORDER BY accepted_at DESC NULLS LAST, id DESC LIMIT 1`,
                [row.match_game_id]
            );
            const winnerId = winner.rows[0]?.winner_team_id || null;
            await client.query(
                `UPDATE match_game
                 SET winner_team_id = $1, status = $2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $3`,
                [winnerId, winnerId ? 'finished' : 'unfinished', row.match_game_id]
            );
            await client.query(
                `INSERT INTO team_game (match_game_id, team_id, is_winner)
                 SELECT $1, side.team_id,
                        CASE WHEN $2::integer IS NULL THEN NULL ELSE side.team_id = $2 END
                 FROM fixture f
                 CROSS JOIN LATERAL (VALUES (f.home_team_id), (f.away_team_id)) side(team_id)
                 WHERE f.id = $3
                 ON CONFLICT (match_game_id, team_id)
                 DO UPDATE SET is_winner = EXCLUDED.is_winner`,
                [row.match_game_id, winnerId, fixtureId]
            );
            await client.query(
                'DELETE FROM game_player_score WHERE match_game_id = $1 AND team_id = $2',
                [row.match_game_id, row.submitted_team_id]
            );
            await client.query(
                `INSERT INTO game_player_score (match_game_id, team_id, player_id)
                 SELECT gs.match_game_id, gs.submitted_team_id, sp.player_id
                 FROM game_submission gs
                 JOIN submission_player sp ON sp.submission_id = gs.id
                 WHERE gs.match_game_id = $1 AND gs.submitted_team_id = $2
                   AND gs.status = 'accepted'
                 ON CONFLICT (match_game_id, team_id, player_id) DO NOTHING`,
                [row.match_game_id, row.submitted_team_id]
            );
        }
        if (status === 'accepted' && uploadId) {
            await client.query(
                `INSERT INTO score_csv_uploads
                    (match_date, board, team, opponent, csv_data, row_count)
                 SELECT match_date, board, team, opponent, csv_data, row_count
                 FROM score_submission_upload
                 WHERE id = $1 AND csv_data IS NOT NULL
                 ON CONFLICT (match_date, board, team)
                 DO UPDATE SET opponent = EXCLUDED.opponent,
                    csv_data = EXCLUDED.csv_data, row_count = EXCLUDED.row_count,
                    uploaded_at = CURRENT_TIMESTAMP`,
                [uploadId]
            );
        } else if (uploadId) {
            await client.query(
                `DELETE FROM score_csv_uploads csv
                 USING score_submission_upload rejected
                 WHERE rejected.id = $1
                   AND csv.match_date = rejected.match_date
                   AND csv.board = rejected.board AND csv.team = rejected.team
                   AND csv.csv_data = rejected.csv_data
                   AND NOT EXISTS (
                       SELECT 1 FROM score_submission_upload other
                       JOIN game_submission gs ON gs.upload_id = other.id
                       WHERE other.match_date = csv.match_date
                         AND other.board = csv.board AND other.team = csv.team
                         AND other.csv_data = csv.csv_data AND gs.status = 'accepted'
                   )`,
                [uploadId]
            );
        }
        await client.query('COMMIT');
        return result.rows.find(row => Number(row.id) === submissionId);
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function deleteRejectedSubmission(pool, submissionId) {
    if (!pool || typeof pool.connect !== 'function') {
        throw new Error('Transactional submission deletion requires PostgreSQL.');
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const selected = await lockSubmission(client, submissionId);
        if (!selected) {
            await client.query('ROLLBACK');
            return null;
        }
        const { fixtureId, uploadId, rows } = selected;
        if (rows.some(row => row.status !== 'rejected')) {
            throw reviewError('Only fully rejected uploads can be deleted.');
        }
        const ids = rows.map(row => row.id);
        const gameIds = rows.map(row => row.match_game_id).filter(id => id !== null);
        await client.query(
            'SELECT id FROM turn_score WHERE submission_id = ANY($1::int[]) FOR UPDATE',
            [ids]
        );
        await client.query(
            `DELETE FROM score_revision
             WHERE target_type = 'turn_score'
               AND target_id IN (SELECT id FROM turn_score WHERE submission_id = ANY($1::int[]))`,
            [ids]
        );
        if (uploadId) {
            await client.query(
                `DELETE FROM score_csv_uploads csv
                 USING score_submission_upload target
                 WHERE target.id = $1 AND csv.match_date = target.match_date
                   AND csv.board = target.board AND csv.team = target.team
                   AND csv.csv_data = target.csv_data
                   AND NOT EXISTS (
                       SELECT 1 FROM score_submission_upload other
                       JOIN game_submission gs ON gs.upload_id = other.id
                       WHERE other.id <> target.id
                         AND other.match_date = target.match_date
                         AND other.board = target.board AND other.team = target.team
                         AND other.csv_data = target.csv_data
                   )
                   AND NOT EXISTS (
                       SELECT 1 FROM game_submission gs
                       WHERE gs.fixture_id = $2
                         AND (gs.submitted_team_id = $3
                              OR gs.submitted_team_id IS NULL OR $3::integer IS NULL)
                         AND gs.status = 'accepted'
                   )`,
                [uploadId, fixtureId, rows[0].submitted_team_id]
            );
        }
        await client.query('DELETE FROM game_submission WHERE id = ANY($1::int[])', [ids]);
        if (uploadId) {
            await client.query('DELETE FROM score_submission_upload WHERE id = $1', [uploadId]);
        }
        await client.query(
            `DELETE FROM match_game mg
             WHERE mg.id = ANY($1::int[]) AND mg.status = 'unfinished'
               AND mg.winner_team_id IS NULL AND mg.starting_team_id IS NULL
               AND mg.finishing_player_id IS NULL AND mg.finish_remaining IS NULL
               AND NOT EXISTS (SELECT 1 FROM game_submission gs WHERE gs.match_game_id = mg.id)
               AND NOT EXISTS (SELECT 1 FROM turn_score ts WHERE ts.match_game_id = mg.id)
               AND NOT EXISTS (SELECT 1 FROM game_player_score gps WHERE gps.match_game_id = mg.id)
               AND NOT EXISTS (
                   SELECT 1 FROM team_game tg
                   WHERE tg.match_game_id = mg.id AND tg.is_winner IS NOT NULL
               )`,
            [gameIds]
        );
        await client.query('COMMIT');
        return { deletedGames: ids.length };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { setSubmissionStatus, deleteRejectedSubmission };
