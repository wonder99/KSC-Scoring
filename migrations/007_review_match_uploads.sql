ALTER TABLE game_submission
    ADD COLUMN upload_id UUID,
    ADD COLUMN submitted_team_id INTEGER REFERENCES team(id) ON DELETE RESTRICT,
    ADD COLUMN winner_team_id INTEGER REFERENCES team(id) ON DELETE RESTRICT;

UPDATE game_submission gs
SET submitted_team_id = (
        SELECT MIN(ts.team_id)
        FROM turn_score ts
        WHERE ts.submission_id = gs.id
        HAVING COUNT(DISTINCT ts.team_id) = 1
    ),
    winner_team_id = mg.winner_team_id
FROM match_game mg
WHERE mg.id = gs.match_game_id;

UPDATE game_submission gs
SET submitted_team_id = t.id
FROM team t
WHERE gs.submitted_team_id IS NULL
  AND lower(t.name) = lower(split_part(gs.source_key, '|', 3));

ALTER TABLE turn_score
    DROP CONSTRAINT turn_score_match_game_id_team_id_player_id_turn_number_key;

ALTER TABLE turn_score
    ADD CONSTRAINT turn_score_submission_player_turn_key
    UNIQUE (submission_id, match_game_id, team_id, player_id, turn_number);

CREATE UNIQUE INDEX uq_turn_score_without_submission
    ON turn_score (match_game_id, team_id, player_id, turn_number)
    WHERE submission_id IS NULL;

CREATE TABLE submission_player (
    submission_id INTEGER NOT NULL REFERENCES game_submission(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    PRIMARY KEY (submission_id, player_id)
);

CREATE TABLE score_submission_upload (
    id UUID PRIMARY KEY,
    match_date DATE NOT NULL,
    board TEXT NOT NULL,
    team TEXT NOT NULL,
    opponent TEXT NOT NULL,
    csv_data TEXT,
    row_count INTEGER NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO submission_player (submission_id, player_id)
SELECT DISTINCT gs.id, gps.player_id
FROM game_submission gs
JOIN game_player_score gps ON gps.match_game_id = gs.match_game_id
                           AND gps.team_id = gs.submitted_team_id
WHERE gs.status = 'accepted'
ON CONFLICT DO NOTHING;

CREATE INDEX idx_game_submission_upload ON game_submission (upload_id);
