ALTER TABLE season
    ADD COLUMN IF NOT EXISTS baseline_through_week INTEGER NOT NULL DEFAULT 0;

ALTER TABLE season
    DROP CONSTRAINT IF EXISTS season_baseline_week_valid;

ALTER TABLE season
    ADD CONSTRAINT season_baseline_week_valid
    CHECK (baseline_through_week >= 0);

CREATE TABLE IF NOT EXISTS player_season_baseline (
    season_id INTEGER NOT NULL REFERENCES season(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    baseline_games INTEGER NOT NULL DEFAULT 0,
    baseline_shots INTEGER NOT NULL DEFAULT 0,
    baseline_score INTEGER NOT NULL DEFAULT 0,
    baseline_ninetyfive_plus INTEGER NOT NULL DEFAULT 0,
    baseline_outs INTEGER NOT NULL DEFAULT 0,
    baseline_score_171 INTEGER NOT NULL DEFAULT 0,
    baseline_score_180 INTEGER NOT NULL DEFAULT 0,
    baseline_fifty_plus_finishes INTEGER NOT NULL DEFAULT 0,
    source_sheet TEXT,
    source_row INTEGER,
    source_reference TEXT,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (season_id, team_id, player_id),
    CONSTRAINT baseline_games_valid CHECK (baseline_games >= 0),
    CONSTRAINT baseline_shots_valid CHECK (baseline_shots >= 0),
    CONSTRAINT baseline_score_valid CHECK (baseline_score >= 0),
    CONSTRAINT baseline_n95_valid CHECK (baseline_ninetyfive_plus >= 0),
    CONSTRAINT baseline_outs_valid CHECK (baseline_outs >= 0),
    CONSTRAINT baseline_171_valid CHECK (baseline_score_171 >= 0),
    CONSTRAINT baseline_180_valid CHECK (baseline_score_180 >= 0),
    CONSTRAINT baseline_50_valid CHECK (baseline_fifty_plus_finishes >= 0)
);

CREATE TABLE IF NOT EXISTS team_season_baseline (
    season_id INTEGER NOT NULL REFERENCES season(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    baseline_wins INTEGER NOT NULL DEFAULT 0,
    baseline_losses INTEGER NOT NULL DEFAULT 0,
    baseline_shots INTEGER NOT NULL DEFAULT 0,
    baseline_score INTEGER NOT NULL DEFAULT 0,
    source_sheet TEXT,
    source_reference TEXT,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (season_id, team_id),
    CONSTRAINT team_baseline_wins_valid CHECK (baseline_wins >= 0),
    CONSTRAINT team_baseline_losses_valid CHECK (baseline_losses >= 0),
    CONSTRAINT team_baseline_shots_valid CHECK (baseline_shots >= 0),
    CONSTRAINT team_baseline_score_valid CHECK (baseline_score >= 0)
);

CREATE INDEX IF NOT EXISTS idx_player_season_baseline_player
    ON player_season_baseline (player_id);
CREATE INDEX IF NOT EXISTS idx_team_season_baseline_team
    ON team_season_baseline (team_id);
