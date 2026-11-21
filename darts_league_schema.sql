-- ============================================================
-- The 701 Club Dart League - Database Schema Design
-- Season: 2026-2027
-- Database engine: SQLite (also works with PostgreSQL/MySQL)
-- ============================================================

-- Drop existing tables for clean setup
DROP TABLE IF EXISTS game_score;
DROP TABLE IF EXISTS player_stat;
DROP TABLE IF EXISTS team_week_stats;
DROP TABLE IF EXISTS match_game;
DROP TABLE IF EXISTS match_result;
DROP TABLE IF EXISTS roster;
DROP TABLE IF EXISTS player;
DROP TABLE IF EXISTS season;

-- ============================================================
-- 1. SEASON (the league itself)
--    One row per league/season
-- ============================================================
CREATE TABLE season (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,   -- e.g. 'The 701 Club - 2026-2027'
    started_at      DATE,                   -- league start date
    ended_at        DATE,                   -- league end date (NULL while ongoing)
    max_games       INTEGER DEFAULT 7,      -- games per match night
    active          BOOLEAN DEFAULT 1
);

-- ============================================================
-- 2. TEAM (the teams in the league)
--    ~12 teams total based on current spreadsheet
-- ============================================================
CREATE TABLE team (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id       INTEGER NOT NULL REFERENCES season(id),
    name            TEXT NOT NULL,          -- e.g. 'JUG Zone', 'Team 2'
    roster_limit    INTEGER DEFAULT 6,      -- max players on roster
    created_at      TIMESTAMP DEFAULT (datetime('now')),
    UNIQUE(season_id, name)
);

-- ============================================================
-- 3. PLAYER (individual dart players)
-- ============================================================
CREATE TABLE player (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id         INTEGER NOT NULL REFERENCES team(id),
    first_name      TEXT,
    last_name       TEXT,
    gender          TEXT CHECK(gender IN ('M', 'F')),  -- M or F for stats segregation
    created_at      TIMESTAMP DEFAULT (datetime('now')),
    UNIQUE(team_id, first_name, last_name)
);

-- ============================================================
-- 4. MATCH (a weekly matchup between two teams)
--    Maps to one W-XXXX sheet (one week's data)
--    Each match covers all 7 games played that night
-- ============================================================
CREATE TABLE match (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id       INTEGER NOT NULL REFERENCES season(id),
    home_team_id    INTEGER NOT NULL REFERENCES team(id),
    away_team_id    INTEGER NOT NULL REFERENCES team(id),
    week_number     INTEGER NOT NULL,       -- 1-22 based on spreadsheet (W1-W22)
    match_date      DATE,                   -- date of the league night
    board_number    INTEGER,                -- board # used that night
    created_at      TIMESTAMP DEFAULT (datetime('now')),
    UNIQUE(season_id, home_team_id, away_team_id, week_number),
    CHECK(home_team_id != away_team_id)
);

-- ============================================================
-- 5. MATCH_GAME (a single game within a match)
--    Each game is one round between the two teams
--    Maps to "Game 1", "Game 2", etc. in ScoreSheet
--    Starting team alternates each game
-- ============================================================
CREATE TABLE match_game (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id        INTEGER NOT NULL REFERENCES match(id),
    game_number     INTEGER NOT NULL,       -- 1-7
    batting_team_id INTEGER NOT NULL REFERENCES team(id),  -- which team starts with darts first
    remaining_score INTEGER DEFAULT 701,     -- starts at 701 (or whatever target score)
    is_win          BOOLEAN,                 -- did this team win this game?
    finishing_player_id INTEGER REFERENCES player(id),   -- who threw the final dart
    finish_remaining INTEGER,               -- points left when finished (e.g. 42 for "42 out")
    created_at      TIMESTAMP DEFAULT (datetime('now')),
    UNIQUE(match_id, game_number)
);

-- ============================================================
-- 6. GAME_SCORE (every individual player's score per game)
--    This is the core stats table -- one row per player per game
--    Maps to each player stat cell in T-sheets (rows 3-8,
--    13-18, 23-28, etc.) and W-sheet rows 42-51.
-- ============================================================
CREATE TABLE game_score (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    match_game_id       INTEGER NOT NULL REFERENCES match_game(id),
    player_id           INTEGER NOT NULL REFERENCES player(id),
    
    -- Raw stats (entered by scorer)
    games_played        INTEGER DEFAULT 0,      -- GP: how many games played (cumulative from spreadsheet perspective)
    shots_taken         INTEGER DEFAULT 0,       -- total number of darts thrown across their games
    score_achieved      INTEGER DEFAULT 0,       -- total points scored
    
    -- Derived/computed stats
    average             REAL,                    -- avg = score / (shots / 3)  or  score / games depending on spreadsheet convention
    ninetyfive_plus     INTEGER DEFAULT 0,       -- count of games with average >= 95
    outs                INTEGER DEFAULT 0,       -- count of finishes (times they scored in a game)
    fifty_plus_finishes INTEGER DEFAULT 0,       -- count of finishes where remaining score <= 50
    
    -- High scores
    highest_score       INTEGER DEFAULT 0,       -- best single-game score (171 target)
    six_dart_171        INTEGER DEFAULT 0,       -- count of perfect 6-dart 171 finishes
    three_dart_180      INTEGER DEFAULT 0,       -- count of 180 breaks
    
    created_at          TIMESTAMP DEFAULT (datetime('now'))
);

-- ============================================================
-- 7. PLAYER_SEASON_STATS (cumulative per-player season totals)
--    Maps to "Mens Overall" / "Lady Overall" sheets.
--    Recalculated or updated on every score entry -- essentially
--    materialized aggregates from game_score.
-- ============================================================
CREATE TABLE player_season_stats (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id           INTEGER NOT NULL REFERENCES season(id),
    player_id           INTEGER NOT NULL REFERENCES player(id),
    
    -- Season aggregates
    total_games         INTEGER DEFAULT 0,       -- GP cumulative across all weeks
    total_shots         INTEGER DEFAULT 0,
    total_score         INTEGER DEFAULT 0,
    avg_points_per_game REAL,
    ninetyfive_plus     INTEGER DEFAULT 0,
    total_outs          INTEGER DEFAULT 0,
    fifty_plus_finishes INTEGER DEFAULT 0,
    highest_season_avg  REAL,
    
    created_at          TIMESTAMP DEFAULT (datetime('now')),
    updated_at          TIMESTAMP DEFAULT (datetime('now')),
    UNIQUE(season_id, player_id)
);

-- ============================================================
-- 8. TEAM_SEASON_STATS (cumulative per-team season totals)
--    Maps to "Standings" sheet: Wins, Losses, Games, Avg.
-- ============================================================
CREATE TABLE team_season_stats (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    season_id           INTEGER NOT NULL REFERENCES season(id),
    team_id             INTEGER NOT NULL REFERENCES team(id),
    
    wins                INTEGER DEFAULT 0,
    losses              INTEGER DEFAULT 0,
    total_games         INTEGER DEFAULT 0,
    avg_points_per_game REAL,
    
    created_at          TIMESTAMP DEFAULT (datetime('now')),
    updated_at          TIMESTAMP DEFAULT (datetime('now')),
    UNIQUE(season_id, team_id)
);

-- ============================================================
-- INDEXES (for performance on common queries)
-- ============================================================
CREATE INDEX idx_player_season_stats_season ON player_season_stats(season_id);
CREATE INDEX idx_player_season_stats_player ON player_season_stats(player_id);
CREATE INDEX idx_team_season_stats_season ON team_season_stats(season_id);
CREATE INDEX idx_game_score_match_game ON game_score(match_game_id);
CREATE INDEX idx_match_season ON match(season_id);
CREATE INDEX idx_match_week ON match(week_number);
CREATE INDEX idx_player_gender ON player(gender);

-- ============================================================
-- VIEWS (generate the report sheets dynamically from DB)
-- ============================================================

-- View: Weekly Match Report (like T1, T2, ... sheets)
-- Shows each team's players across all games of a match with their stats
CREATE VIEW vw_weekly_match_report AS
SELECT 
    m.week_number,
    m.match_date,
    ht.name AS home_team,
    at.name AS away_team,
    mg.game_number,
    p.id AS player_id,
    p.first_name,
    p.last_name,
    gs.games_played,
    gs.shots_taken,
    gs.score_achieved,
    gs.average,
    gs.ninetyfive_plus,
    gs.outs,
    gs.highest_score,
    gs.six_dart_171,
    gs.three_dart_180,
    gs.fifty_plus_finishes,
    mg.remaining_score,
    mg.is_win,
    mg.finishing_player_id,
    mg.finish_remaining
FROM match m
JOIN team ht ON m.home_team_id = ht.id
JOIN team at ON m.away_team_id = at.id
JOIN match_game mg ON mg.match_id = m.id
JOIN player p ON p.team_id IN (ht.id, at.id)
LEFT JOIN game_score gs ON gs.match_game_id = mg.id AND gs.player_id = p.id;

-- View: Team Standings (like "Standings" sheet)
CREATE VIEW vw_standings AS
SELECT 
    s.name AS season,
    t.name AS team,
    ts.wins,
    ts.losses,
    ts.total_games AS games,
    ROUND(ts.avg_points_per_game, 2) AS avg
FROM team_season_stats ts
JOIN team t ON ts.team_id = t.id
JOIN season s ON ts.season_id = s.id
ORDER BY ts.wins DESC, ts.losses ASC;

-- View: Mens Overall (like "Mens Overall" sheet)
CREATE VIEW vw_mens_overall AS
SELECT 
    p.first_name || ' ' || p.last_name AS player,
    t.name AS team,
    ps.total_games AS GP,
    ps.total_shots AS Shots,
    ps.total_score AS Score,
    ROUND(ps.avg_points_per_game, 2) AS Avg,
    ps.ninetyfive_plus AS "95+",
    ps.total_outs AS Outs,
    ps.fifty_plus_finishes AS "50+Fin"
FROM player_season_stats ps
JOIN player p ON ps.player_id = p.id
JOIN team t ON p.team_id = t.id
WHERE p.gender = 'M'
ORDER BY ps.avg_points_per_game DESC;

-- View: Mens High Averages (top 11, like "Mens Avg" sheet)
CREATE VIEW vw_mens_avg AS
SELECT 
    p.first_name || ' ' || p.last_name AS player,
    t.name AS team,
    ROUND(ps.avg_points_per_game, 2) AS average,
    ps.total_games AS GP
FROM player_season_stats ps
JOIN player p ON ps.player_id = p.id
JOIN team t ON p.team_id = t.id
WHERE p.gender = 'M' AND ps.total_games > 0
ORDER BY ps.avg_points_per_game DESC
LIMIT 11;

-- View: Mens High Scores (like "Mens Overall" but filtered for highest scorers)
CREATE VIEW vw_mens_overall_filtered AS
SELECT 
    p.first_name || ' ' || p.last_name AS player,
    t.name AS team,
    ps.total_games AS GP,
    ps.total_shots AS Shots,
    ps.total_score AS Score,
    ROUND(ps.avg_points_per_game, 2) AS Avg,
    ps.ninetyfive_plus AS "95+",
    ps.total_outs AS Outs,
    ps.fifty_plus_finishes AS "50+Fin"
FROM player_season_stats ps
JOIN player p ON ps.player_id = p.id
JOIN team t ON p.team_id = t.id
WHERE p.gender = 'M'
ORDER BY ps.total_score DESC;

-- View: Mens 95+ Averages (like "Mens 95" sheet)
CREATE VIEW vw_mens_95 AS
SELECT 
    p.first_name || ' ' || p.last_name AS player,
    t.name AS team,
    ps.ninetyfive_plus AS "95+",
    ROUND(ps.avg_points_per_game, 2) AS average,
    ps.total_games AS GP
FROM player_season_stats ps
JOIN player p ON ps.player_id = p.id
JOIN team t ON p.team_id = t.id
WHERE p.gender = 'M' AND ps.ninetyfive_plus > 0
ORDER BY ps.ninetyfive_plus DESC;

-- View: Mens Outs (like "Mens Outs" sheet)
CREATE VIEW vw_mens_outs AS
SELECT 
    p.first_name || ' ' || p.last_name AS player,
    t.name AS team,
    ps.total_outs AS outs,
    ROUND(ps.avg_points_per_game, 2) AS average,
    ps.total_games AS GP
FROM player_season_stats ps
JOIN player p ON ps.player_id = p.id
JOIN team t ON p.team_id = t.id
WHERE p.gender = 'M' AND ps.total_outs > 0
ORDER BY ps.total_outs DESC;

-- View: Ladies Overall (like "Lady Overall" sheet)
CREATE VIEW vw_lady_overall AS
SELECT 
    p.first_name || ' ' || p.last_name AS player,
    t.name AS team,
    ps.total_games AS GP,
    ps.total_shots AS Shots,
    ps.total_score AS Score,
    ROUND(ps.avg_points_per_game, 2) AS Avg,
    ps.ninetyfive_plus AS "95+",
    ps.total_outs AS Outs,
    ps.fifty_plus_finishes AS "50+Fin"
FROM player_season_stats ps
JOIN player p ON ps.player_id = p.id
JOIN team t ON p.team_id = t.id
WHERE p.gender = 'F'
ORDER BY ps.avg_points_per_game DESC;

-- View: Ladies High Averages (like "Lady Avg" sheet)
CREATE VIEW vw_lady_avg AS
SELECT 
    p.first_name || ' ' || p.last_name AS player,
    t.name AS team,
    ROUND(ps.avg_points_per_game, 2) AS average,
    ps.total_games AS GP
FROM player_season_stats ps
JOIN player p ON ps.player_id = p.id
JOIN team t ON p.team_id = t.id
WHERE p.gender = 'F' AND ps.total_games > 0
ORDER BY ps.avg_points_per_game DESC
LIMIT 11;

-- View: Ladies High Scores (like "Lady Overall" but by score)
CREATE VIEW vw_lady_overall_filtered AS
SELECT 
    p.first_name || ' ' || p.last_name AS player,
    t.name AS team,
    ps.total_games AS GP,
    ps.total_shots AS Shots,
    ps.total_score AS Score,
    ROUND(ps.avg_points_per_game, 2) AS Avg,
    ps.ninetyfive_plus AS "95+",
    ps.total_outs AS Outs,
    ps.fifty_plus_finishes AS "50+Fin"
FROM player_season_stats ps
JOIN player p ON ps.player_id = p.id
JOIN team t ON p.team_id = t.id
WHERE p.gender = 'F'
ORDER BY ps.total_score DESC;

-- View: Ladies 95+ (like "Lady 95" sheet)
CREATE VIEW vw_lady_95 AS
SELECT 
    p.first_name || ' ' || p.last_name AS player,
    t.name AS team,
    ps.ninetyfive_plus AS "95+",
    ROUND(ps.avg_points_per_game, 2) AS average,
    ps.total_games AS GP
FROM player_season_stats ps
JOIN player p ON ps.player_id = p.id
JOIN team t ON p.team_id = t.id
WHERE p.gender = 'F' AND ps.ninetyfive_plus > 0
ORDER BY ps.ninetyfive_plus DESC;

-- View: Ladies Outs (like "Lady Outs" sheet)
CREATE VIEW vw_lady_outs AS
SELECT 
    p.first_name || ' ' || p.last_name AS player,
    t.name AS team,
    ps.total_outs AS outs,
    ROUND(ps.avg_points_per_game, 2) AS average,
    ps.total_games AS GP
FROM player_season_stats ps
JOIN player p ON ps.player_id = p.id
JOIN team t ON p.team_id = t.id
WHERE p.gender = 'F' AND ps.total_outs > 0
ORDER BY ps.total_outs DESC;

-- View: League Leaders (like "Leaders" sheet - top in each category)
CREATE VIEW vw_leaders_mens_avg AS
SELECT 
    p.first_name || ' ' || p.last_name AS player,
    t.name AS team,
    ROUND(ps.avg_points_per_game, 2) AS average,
    ps.total_games AS GP
FROM player_season_stats ps
JOIN player p ON ps.player_id = p.id
JOIN team t ON p.team_id = t.id
WHERE p.gender = 'M' AND ps.total_games > 0
ORDER BY ps.avg_points_per_game DESC
LIMIT 11;

CREATE VIEW vw_leaders_mens_95 AS
SELECT 
    p.first_name || ' ' || p.last_name AS player,
    t.name AS team,
    ps.ninetyfive_plus AS "95+",
    ROUND(ps.avg_points_per_game, 2) AS average,
    ps.total_games AS GP
FROM player_season_stats ps
JOIN player p ON ps.player_id = p.id
JOIN team t ON p.team_id = t.id
WHERE p.gender = 'M' AND ps.ninetyfive_plus > 0
ORDER BY ps.ninetyfive_plus DESC;

CREATE VIEW vw_leaders_mens_outs AS
SELECT 
    p.first_name || ' ' || p.last_name AS player,
    t.name AS team,
    ps.total_outs AS outs,
    ROUND(ps.avg_points_per_game, 2) AS average,
    ps.total_games AS GP
FROM player_season_stats ps
JOIN player p ON ps.player_id = p.id
JOIN team t ON p.team_id = t.id
WHERE p.gender = 'M' AND ps.total_outs > 0
ORDER BY ps.total_outs DESC;

CREATE VIEW vw_leaders_lady_avg AS
SELECT 
    p.first_name || ' ' || p.last_name AS player,
    t.name AS team,
    ROUND(ps.avg_points_per_game, 2) AS average,
    ps.total_games AS GP
FROM player_season_stats ps
JOIN player p ON ps.player_id = p.id
JOIN team t ON p.team_id = t.id
WHERE p.gender = 'F' AND ps.total_games > 0
ORDER BY ps.avg_points_per_game DESC
LIMIT 11;

CREATE VIEW vw_leaders_lady_95 AS
SELECT 
    p.first_name || ' ' || p.last_name AS player,
    t.name AS team,
    ps.ninetyfive_plus AS "95+",
    ROUND(ps.avg_points_per_game, 2) AS average,
    ps.total_games AS GP
FROM player_season_stats ps
JOIN player p ON ps.player_id = p.id
JOIN team t ON p.team_id = t.id
WHERE p.gender = 'F' AND ps.ninetyfive_plus > 0
ORDER BY ps.ninetyfive_plus DESC;

CREATE VIEW vw_leaders_lady_outs AS
SELECT 
    p.first_name || ' ' || p.last_name AS player,
    t.name AS team,
    ps.total_outs AS outs,
    ROUND(ps.avg_points_per_game, 2) AS average,
    ps.total_games AS GP
FROM player_season_stats ps
JOIN player p ON ps.player_id = p.id
JOIN team t ON p.team_id = t.id
WHERE p.gender = 'F' AND ps.total_outs > 0
ORDER BY ps.total_outs DESC;
