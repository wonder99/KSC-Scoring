CREATE TABLE IF NOT EXISTS high_finish (
    season_id INTEGER NOT NULL REFERENCES season(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    score INTEGER NOT NULL,
    source_sheet TEXT,
    source_row INTEGER,
    source_reference TEXT,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (season_id, team_id, player_id, score),
    CONSTRAINT high_finish_score_valid
        CHECK (score >= 50 AND score <= 170)
);

CREATE INDEX IF NOT EXISTS idx_high_finish_season
    ON high_finish (season_id);
