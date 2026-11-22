CREATE TABLE IF NOT EXISTS honourable_mention (
    season_id INTEGER NOT NULL REFERENCES season(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    score INTEGER NOT NULL,
    source_sheet TEXT,
    source_row INTEGER,
    source_reference TEXT,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (season_id, team_id, player_id, score),
    CONSTRAINT honourable_mention_score_valid
        CHECK (score >= 130 AND score <= 180)
);

CREATE INDEX IF NOT EXISTS idx_honourable_mention_season
    ON honourable_mention (season_id);
