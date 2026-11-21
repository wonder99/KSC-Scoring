'use strict';

async function mergePlayerRecords(client, canonicalId, duplicateId) {
    if (canonicalId === duplicateId) {
        throw new Error('Canonical and duplicate player IDs must be different.');
    }

    await client.query(
        `DELETE FROM team_roster duplicate
         WHERE duplicate.player_id = $1
           AND EXISTS (
               SELECT 1
               FROM team_roster canonical
               WHERE canonical.season_id = duplicate.season_id
                 AND canonical.team_id = duplicate.team_id
                 AND canonical.player_id = $2
           )`,
        [duplicateId, canonicalId]
    );
    await client.query(
        'UPDATE team_roster SET player_id = $1 WHERE player_id = $2',
        [canonicalId, duplicateId]
    );

    const duplicateBaselines = await client.query(
        'SELECT * FROM player_season_baseline WHERE player_id = $1',
        [duplicateId]
    );
    for (const duplicateBaseline of duplicateBaselines.rows) {
        const canonicalBaseline = await client.query(
            `SELECT * FROM player_season_baseline
             WHERE season_id = $1
               AND team_id = $2
               AND player_id = $3`,
            [duplicateBaseline.season_id, duplicateBaseline.team_id, canonicalId]
        );
        if (canonicalBaseline.rows.length) {
            const canonicalRow = canonicalBaseline.rows[0];
            await client.query(
                `UPDATE player_season_baseline
                 SET baseline_games = $1,
                     baseline_shots = $2,
                     baseline_score = $3,
                     baseline_ninetyfive_plus = $4,
                     baseline_outs = $5,
                     baseline_score_171 = $6,
                     baseline_score_180 = $7,
                     baseline_fifty_plus_finishes = $8,
                     imported_at = CURRENT_TIMESTAMP
                 WHERE season_id = $9
                   AND team_id = $10
                   AND player_id = $11`,
                [
                    Number(canonicalRow.baseline_games) + Number(duplicateBaseline.baseline_games),
                    Number(canonicalRow.baseline_shots) + Number(duplicateBaseline.baseline_shots),
                    Number(canonicalRow.baseline_score) + Number(duplicateBaseline.baseline_score),
                    Number(canonicalRow.baseline_ninetyfive_plus) + Number(duplicateBaseline.baseline_ninetyfive_plus),
                    Number(canonicalRow.baseline_outs) + Number(duplicateBaseline.baseline_outs),
                    Number(canonicalRow.baseline_score_171) + Number(duplicateBaseline.baseline_score_171),
                    Number(canonicalRow.baseline_score_180) + Number(duplicateBaseline.baseline_score_180),
                    Number(canonicalRow.baseline_fifty_plus_finishes) + Number(duplicateBaseline.baseline_fifty_plus_finishes),
                    duplicateBaseline.season_id,
                    duplicateBaseline.team_id,
                    canonicalId
                ]
            );
            await client.query(
                `DELETE FROM player_season_baseline
                 WHERE season_id = $1
                   AND team_id = $2
                   AND player_id = $3`,
                [duplicateBaseline.season_id, duplicateBaseline.team_id, duplicateId]
            );
        } else {
            await client.query(
                `UPDATE player_season_baseline
                 SET player_id = $1
                 WHERE season_id = $2
                   AND team_id = $3
                   AND player_id = $4`,
                [canonicalId, duplicateBaseline.season_id,
                 duplicateBaseline.team_id, duplicateId]
            );
        }
    }

    await client.query(
        `DELETE FROM turn_score duplicate
         WHERE duplicate.player_id = $1
           AND EXISTS (
               SELECT 1
               FROM turn_score canonical
               WHERE canonical.match_game_id = duplicate.match_game_id
                 AND canonical.team_id = duplicate.team_id
                 AND canonical.player_id = $2
                 AND canonical.turn_number = duplicate.turn_number
           )`,
        [duplicateId, canonicalId]
    );
    await client.query(
        'UPDATE turn_score SET player_id = $1 WHERE player_id = $2',
        [canonicalId, duplicateId]
    );
    await client.query(
        `DELETE FROM game_player_score duplicate
         WHERE duplicate.player_id = $1
           AND EXISTS (
               SELECT 1
               FROM game_player_score canonical
               WHERE canonical.match_game_id = duplicate.match_game_id
                 AND canonical.team_id = duplicate.team_id
                 AND canonical.player_id = $2
           )`,
        [duplicateId, canonicalId]
    );
    await client.query(
        'UPDATE game_player_score SET player_id = $1 WHERE player_id = $2',
        [canonicalId, duplicateId]
    );
    await client.query(
        'UPDATE match_game SET finishing_player_id = $1 WHERE finishing_player_id = $2',
        [canonicalId, duplicateId]
    );
    await client.query(
        'DELETE FROM player WHERE id = $1',
        [duplicateId]
    );
}

module.exports = { mergePlayerRecords };
