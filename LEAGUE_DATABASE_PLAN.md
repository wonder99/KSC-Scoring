# Plan: PostgreSQL League Tables + Public Reports Website

## Problem
- `server.js` already connects to PostgreSQL via `pg`, has CSV upload table, routing, auth, static serving
- Only one table exists (`score_csv_uploads`) — no league data (teams, players, matches, scores, stats)
- Need to add 8 league tables to support the reports currently in the Excel file
- Need a public website where all reports can be viewed

## What changes

### 1. DB connection module (new)
- **`db/connection.js`** — pg Pool helper extracted from server.js for clarity
- Reads from `DATABASE_URL` env var (already how server.js works)

### 2. League schema SQL (new file, run once)
- **`darts_league_schema.sql`** — all 8 tables + indexes + views
- Tables: season, team, player, match, match_game, game_score, player_season_stats, team_season_stats
- Views that mirror existing Excel sheets: standings, mens_overall, mens_avg, mens_95, mens_outs, lady_overall, lady_avg, lady_95, lady_outs, leaders, weekly_match_report
- Uses `SERIAL`, `TIMESTAMPTZ`, `DOUBLE PRECISION` for PostgreSQL

### 3. server.js — add league tables + report endpoints
**initializeDatabase()** — runs the league schema alongside existing score_csv_uploads table

**New API endpoints:**
- `GET /api/seasons` — list seasons
- `POST /api/teams` — create team (admin)
- `POST /api/players` — add player to team with gender (admin)
- `POST /api/matches` — schedule weekly matchup (admin)
- `POST /api/scores` — submit game scores for a match_game (scorer app)

**Report endpoints:**
- `GET /api/reports/standings` → Standings sheet data
- `GET /api/reports/mens-overall` → Mens Overall sheet data
- `GET /api/reports/mens-avg` → Mens Avg sheet data
- `GET /api/reports/mens-95` → Mens 95+ sheet data
- `GET /api/reports/mens-outs` → Mens Outs sheet data
- `GET /api/reports/lady-overall` → Lady Overall sheet data
- `GET /api/reports/lady-avg` → Lady Avg sheet data
- `GET /api/reports/lady-95` → Lady 95+ sheet data
- `GET /api/reports/lady-outs` → Lady Outs sheet data
- `GET /api/reports/leaders` → Leaders sheet (combined mens + lady top in each category)
- `GET /api/reports/match/:id` → Weekly match report for a specific match

### 4. Reports website (new files, served statically)
**`reports/index.html`** — Main reports page with tabbed navigation:
- Tab 1: Standings
- Tab 2: Mens Stats (sub-tabs: Overall, Avg, 95+, Outs)
- Tab 3: Lady Stats (sub-tabs: Overall, Avg, 95+, Outs)
- Tab 4: Leaders

**`reports/styles.css`** — Report-specific styling (tables, cards, responsive)

**`reports/reports.js`** — Fetches data from /api/reports/* endpoints and renders tables. No framework needed — just vanilla JS + fetch.

### 5. Admin dashboard (new files, authenticated via ADMIN_API_KEY)
**`admin/index.html`** — Authenticated admin dashboard with tabs:
- Tab 1: **Score Review** — list all score entries across all matches, filterable by date/team/week; inline-edit any field (games_played, shots_taken, score_achieved, avg, 95+, outs, finishes); delete erroneous entries; stats auto-recalculate
- Tab 2: **Team Management** — add new teams; rename existing teams; change roster_limit; remove teams; manage rosters — add players (first/last name, gender M/F), remove players from rosters; view player stats inline
- Tab 3: **Schedule View/Edit** — full season schedule grid showing all weeks/matches; edit matchups (swap home/away teams, reschedule dates, change board #); add new weeks

**`admin/admin.js`** — Auth check via ADMIN_API_KEY header; fetches admin data; inline-edit forms; score review with delete/recalculate; roster management UI; schedule grid
**`admin/styles.css`** — Admin styling (tables, cards, inline-edit forms)

### 6. Updates to existing files
- **`server.js`**: Add `initializeLeagueTables()`, report endpoints, admin endpoints (/api/admin/scores, /api/admin/teams, /api/admin/players, /api/admin/matches), auth using `adminApiKey` env var
- **`.gitignore`**: add .env (for DATABASE_URL, UPLOAD_API_KEY, ADMIN_API_KEY)
- **`README.md`**: Document setup steps for league schema

## Key Design Decisions
1. Keep score_csv_uploads table — existing CSV upload workflow works fine
2. Reports are public (no auth) — just read-only SELECT from views
3. One page, tabbed layout — matches your existing app.js single-page pattern
4. Materialized stats tables update on score entry (like Excel auto-calculate)
5. Vanilla JS only for reports — no framework needed

## Files to create/modify
- `db/connection.js` — new, pg Pool helper
- `darts_league_schema.sql` — new, full PostgreSQL DDL
- `reports/index.html` — new, tabbed reports page
- `reports/styles.css` — new, report styling
- `reports/reports.js` — new, fetch + render logic
- `server.js` — modify: league tables, API routes
- `.gitignore` — add .env
- `README.md` — document setup
