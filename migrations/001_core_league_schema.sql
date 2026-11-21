CREATE TABLE IF NOT EXISTS season (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    start_date DATE,
    end_date DATE,
    active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT season_dates_valid CHECK (
        end_date IS NULL OR start_date IS NULL OR end_date >= start_date
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_season
    ON season (active)
    WHERE active;

CREATE TABLE IF NOT EXISTS team (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS player (
    id SERIAL PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL DEFAULT '',
    gender TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT player_gender_valid CHECK (gender IS NULL OR gender IN ('M', 'F')),
    CONSTRAINT player_name_unique UNIQUE (first_name, last_name)
);

CREATE TABLE IF NOT EXISTS team_roster (
    season_id INTEGER NOT NULL REFERENCES season(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    gender TEXT,
    joined_at DATE,
    left_at DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (season_id, team_id, player_id),
    CONSTRAINT roster_gender_valid CHECK (gender IS NULL OR gender IN ('M', 'F')),
    CONSTRAINT roster_dates_valid CHECK (
        left_at IS NULL OR joined_at IS NULL OR left_at >= joined_at
    )
);

CREATE TABLE IF NOT EXISTS fixture (
    id SERIAL PRIMARY KEY,
    season_id INTEGER NOT NULL REFERENCES season(id) ON DELETE RESTRICT,
    week_number INTEGER,
    match_date DATE NOT NULL,
    board_number TEXT,
    home_team_id INTEGER NOT NULL REFERENCES team(id) ON DELETE RESTRICT,
    away_team_id INTEGER NOT NULL REFERENCES team(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fixture_teams_differ CHECK (home_team_id <> away_team_id),
    CONSTRAINT fixture_week_valid CHECK (week_number IS NULL OR week_number > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fixture_season_week_teams
    ON fixture (season_id, week_number, home_team_id, away_team_id)
    WHERE week_number IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_fixture_date_board_teams
    ON fixture (match_date, board_number, home_team_id, away_team_id);

CREATE TABLE IF NOT EXISTS match_game (
    id SERIAL PRIMARY KEY,
    fixture_id INTEGER NOT NULL REFERENCES fixture(id) ON DELETE CASCADE,
    game_number INTEGER NOT NULL,
    starting_team_id INTEGER REFERENCES team(id) ON DELETE RESTRICT,
    winner_team_id INTEGER REFERENCES team(id) ON DELETE RESTRICT,
    finishing_player_id INTEGER REFERENCES player(id) ON DELETE RESTRICT,
    finish_remaining INTEGER,
    status TEXT NOT NULL DEFAULT 'unfinished',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT match_game_number_valid CHECK (game_number BETWEEN 1 AND 7),
    CONSTRAINT match_game_status_valid CHECK (
        status IN ('unfinished', 'finished', 'void')
    ),
    UNIQUE (fixture_id, game_number)
);

CREATE TABLE IF NOT EXISTS team_game (
    match_game_id INTEGER NOT NULL REFERENCES match_game(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    is_winner BOOLEAN,
    PRIMARY KEY (match_game_id, team_id)
);

CREATE TABLE IF NOT EXISTS game_player_score (
    id SERIAL PRIMARY KEY,
    match_game_id INTEGER NOT NULL REFERENCES match_game(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    is_lineup_player BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (match_game_id, team_id, player_id)
);

CREATE TABLE IF NOT EXISTS game_submission (
    id SERIAL PRIMARY KEY,
    fixture_id INTEGER REFERENCES fixture(id) ON DELETE RESTRICT,
    match_game_id INTEGER REFERENCES match_game(id) ON DELETE RESTRICT,
    source TEXT NOT NULL,
    source_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    raw_payload JSONB,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    accepted_at TIMESTAMPTZ,
    CONSTRAINT game_submission_source_valid CHECK (
        source IN ('csv', 'browser', 'admin', 'workbook')
    ),
    CONSTRAINT game_submission_status_valid CHECK (
        status IN ('pending', 'accepted', 'rejected', 'superseded')
    ),
    UNIQUE (source, source_key)
);

CREATE TABLE IF NOT EXISTS turn_score (
    id SERIAL PRIMARY KEY,
    submission_id INTEGER REFERENCES game_submission(id) ON DELETE CASCADE,
    match_game_id INTEGER NOT NULL REFERENCES match_game(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    turn_number INTEGER NOT NULL,
    score INTEGER NOT NULL,
    dart_scores JSONB,
    is_bust BOOLEAN NOT NULL DEFAULT FALSE,
    remaining_before INTEGER,
    remaining_after INTEGER,
    checkout_remaining INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT turn_number_valid CHECK (turn_number > 0),
    CONSTRAINT turn_score_valid CHECK (score BETWEEN 0 AND 180),
    CONSTRAINT turn_remaining_valid CHECK (
        remaining_before IS NULL OR remaining_before BETWEEN 0 AND 701
    ),
    CONSTRAINT turn_remaining_after_valid CHECK (
        remaining_after IS NULL OR remaining_after BETWEEN 0 AND 701
    ),
    UNIQUE (match_game_id, team_id, player_id, turn_number)
);

CREATE TABLE IF NOT EXISTS score_revision (
    id SERIAL PRIMARY KEY,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    before_json JSONB,
    after_json JSONB,
    reason TEXT,
    actor TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_team_roster_player
    ON team_roster (player_id);
CREATE INDEX IF NOT EXISTS idx_team_roster_team_season
    ON team_roster (team_id, season_id);
CREATE INDEX IF NOT EXISTS idx_fixture_season_date
    ON fixture (season_id, match_date);
CREATE INDEX IF NOT EXISTS idx_match_game_fixture
    ON match_game (fixture_id);
CREATE INDEX IF NOT EXISTS idx_game_player_score_player
    ON game_player_score (player_id);
CREATE INDEX IF NOT EXISTS idx_turn_score_match_game
    ON turn_score (match_game_id);
CREATE INDEX IF NOT EXISTS idx_turn_score_player
    ON turn_score (player_id);
CREATE INDEX IF NOT EXISTS idx_game_submission_fixture
    ON game_submission (fixture_id);
CREATE INDEX IF NOT EXISTS idx_score_revision_target
    ON score_revision (target_type, target_id);
