# Plan: PostgreSQL League Database and Public Reports

## Goal

Replace the workbook as the operating record with a PostgreSQL-backed browser application while preserving the existing live scoring and CSV workflows during migration.

The database will own:
- seasons, teams, roster membership, fixtures, games, and lineups
- raw submitted turns and game results
- player and team season calculations
- public reports
- authenticated score and schedule administration

`score_csv_uploads` will remain as an immutable compatibility/upload audit record until the browser scorer has been migrated and validated.

## Verified Workbook Behavior

The supplied workbook (`MASTER-DARTS-Stats file. - 2026-2027 Kari.xlsx`) confirms that the Excel application uses these report sheets:

- `Standings`
- `Mens Overall`, `Mens Avg`, `Mens 95`, `Mens Outs`
- `Lady Overall`, `Lady Avg`, `Lady 95`, `Lady Outs`
- `Leaders`
- `Playoff Standings`
- weekly `W*` sheets and team `T*` sheets
- `ScoreSheet`

Player calculations found in the workbook:

- GP is the number of games played
- Shots is the count of non-empty recorded turns, not the count of individual darts
- Score is the sum of turn scores
- Average is `Score / Shots`
- `95+` is the count of player turn scores that are at least 95
- Outs is a recorded checkout/finish count
- 171 and 180 are counts of turn scores equal to those values
- `50+Fin.` is present in the player summary, but its exact workbook rule and source cells need a manual validation pass
- Team average is total team Score divided by total team Shots

The browser currently captures turn totals (and dart-grid details), game winners, and the four-player lineup. It also has a spare-player path that automatically submits 25. The database design must retain these facts rather than only storing spreadsheet totals.

## Critical Plan Issues

1. **Do not run destructive schema SQL at startup.** The SQLite schema has `DROP TABLE` statements. The PostgreSQL schema is not an idempotent migration and would destroy data. Use ordered migrations and never include destructive DDL in normal startup.

2. **Do not maintain two incompatible schemas.** The plan calls for singular names such as `season` and `game_score`, while an earlier implementation used plural names such as `seasons`, `teams`, `matches`, and `scores`. The implementation must settle on one normalized PostgreSQL schema before adding endpoints.

3. **Do not make `player.team_id` permanent.** Players can be on a team for one or more seasons or transfer teams. Use `roster_membership(season_id, team_id, player_id, gender, joined_at, left_at)`.

4. **Do not store only cached summary tables.** Cached player/team totals can drift after edits and are hard to audit. Use views or aggregate queries as the report source of truth, with optional snapshot tables only if performance requires them.

5. **Do not treat the spreadsheet formula text as enough.** The workbook contains cross-sheet formulas and manual records. It must be used as a migration fixture and formula oracle. Automated tests must compare database reports with exported workbook values for a known completed week.

6. **Do not update league data twice.** CSV uploads and JSON score submissions must converge on one transactional importer. If CSV remains the compatibility format, parse it once and insert normalized rows plus an upload audit record.

7. **Handle opponent uploads explicitly.** One CSV upload currently contains only one team's players and is keyed by `(match_date, board, team)`. The database should create or reconcile the shared fixture only after both sides, or an authorized merge operation, agree on the matchup and winner.

8. **Do not put `ADMIN_API_KEY` in browser JavaScript.** Browser code cannot securely read `process.env`. Send the key with admin requests using a server-issued session or keep API-key authorization in server-side routes. Do not expose the key in static files.

9. **Preserve audit history.** Editing or deleting a score must be append-only or have an audit table with actor, timestamp, old values, new values, and reason. This is required for correcting league records safely.

10. **Reserve SQL keywords.** Use `fixture` or `match` quoted consistently; `matches` is the clearer existing application name and avoids reserved-name ambiguity.

## Data Model

Use migrations for the following PostgreSQL tables:

### Core identity
- `season`
- `team`
- `player`
- `team_roster`
- `fixture`
- `match_game`
- `team_game`
- `game_player_score`
- `turn_score`

### Supporting and audit
- `score_submission`
- `score_revision`
- `score_csv_uploads` (existing table retained)

Recommended invariants:

- `season.name` is unique
- `(season_id, team_id, player_id)` is unique in `team_roster`
- each fixture has one season, exactly two teams, a week, date, and board
- a fixture cannot contain the same team on both sides
- `(fixture_id, game_number)` is unique in `match_game`
- `(match_game_id, team_id, player_id)` is unique in `game_player_score`
- turn rows are ordered by `turn_number` and cannot be duplicated by the same submission
- every turn is linked to a player and team that are valid for the same fixture
- every game has a recorded winner or is explicitly unfinished
- checkout fields are nullable unless a legal finish was recorded

### Raw turn design

`turn_score` should store:

- `match_game_id`
- `team_id`
- `player_id`
- `turn_number`
- `score`
- `dart_scores` (JSONB, nullable for total-only entry)
- `is_bust`
- `remaining_score_before`
- `remaining_score_after`
- `checkout_remaining`
- submission and revision metadata

The app's existing CSV remains a normalized export of these facts. It should not be the only place that per-dart, bust, remaining-score, or spare-turn data exists.

## Transactions and API

All score submissions must use one PostgreSQL transaction:

1. validate upload key or admin session
2. resolve season, fixture, teams, roster members, and game
3. validate lineup size and player membership
4. insert or reconcile the submission
5. insert raw turns and game results
6. mark the submission accepted or rejected

Upsert rules must be explicit. A repeated submit should replace or create a revision for the same submission, never silently duplicate turns.

### Existing and new endpoints

Keep:
- `POST /api/score-submissions`
- `GET /api/reports/*`
- `/admin` schedule and submission administration
- `POST /api/seasons`
- `POST /api/teams`
- `POST /api/players`
- `POST /api/matches`
- `POST /api/scores`

Add or revise:
- `POST /api/fixtures/:id/submissions`
- `GET /api/fixtures/:id`
- `GET /api/admin/submissions`
- `POST /api/admin/submissions/:id/revision`
- `GET /api/reports/standings?season=...`
- `GET /api/reports/mens-overall?season=...`
- `GET /api/reports/mens-avg?season=...`
- `GET /api/reports/mens-95?season=...`
- `GET /api/reports/mens-outs?season=...`
- `GET /api/reports/lady-overall?season=...`
- `GET /api/reports/lady-avg?season=...`
- `GET /api/reports/lady-95?season=...`
- `GET /api/reports/lady-outs?season=...`
- `GET /api/reports/leaders?season=...`
- `GET /api/reports/match/:id`

Every report endpoint requires an explicit season or defaults to exactly one active season. Never silently combine seasons.

## Report Calculations

Implement report SQL after seeding migration fixtures and comparing every result against workbook exports.

- Season player total average: `SUM(score) / NULLIF(SUM(shots), 0)`
- GP: count of distinct accepted player/game rows
- 95+: count of accepted recorded turns with `score >= 95`
- Outs: count of accepted finishes credited to the player
- 171/180: count of accepted turns where the total equals 171/180
- Team average: `SUM(team turn score) / SUM(team turn shots)`
- Standings: wins and losses by fixture, not by a cache maintained outside the transaction
- Rankings: use workbook order and sorting rules, including ties, as migration fixtures

Do not add `LIMIT` inside generic reporting views. Return report rows deterministically, with a UI or API parameter controlling leader limits.

## Migration and Backfill

Implement this in phases:

1. Add migration framework and schema checks.
2. Add seasons, teams, players, rosters, fixtures, and games.
3. Add turn and submission tables.
4. Import the existing workbook rosters, season, schedule, and completed results into a staging schema.
5. Reconcile the workbook with `score_csv_uploads`.
6. Seed report fixture tests from known workbook values.
7. Switch browser score submission to normalized transaction writes while still writing CSV compatibility records.
8. Mark Excel as retired only after two-sided fixture reconciliation and report sign-off.

Each migration must be forward-only, reversible only for development, and recorded in a migration table. Existing databases must be migrated rather than recreated.

The workbook import should preserve source references such as sheet name, team sheet, and source row/cell. This allows a final reconciliation report and makes disputed historical data auditable.

## Admin Dashboard

Use server-side session authentication or a server-side API key exchange. The dashboard needs:

- submission review and approved/rejected state
- side-by-side CSV/normalized turn review
- fixture and lineup correction
- roster membership with effective seasons
- schedule create/edit/reschedule
- score revision with reason and audit history
- recalculation/status indicators rather than blind cache refresh

No `coming soon` controls should be exposed as working UI actions.

## Public Reports Website

Keep vanilla JavaScript and static files if consistent with the current app. The public pages should:

- require no admin key
- select a season explicitly
- show loading and empty states
- render mens and lady report groups
- show standings, leaders, and match reports
- remain usable at desktop and mobile widths

## Testing and Acceptance

Add tests for:

- migration from an empty database
- migration against an existing `score_csv_uploads` database
- each report formula
- 95+ threshold, 171, 180, bust, spare 25, and double-out validation
- repeated submission/idempotency
- conflicting winner/opponent uploads
- roster transfer between seasons
- revision and audit behavior
- public versus admin authorization
- mobile and desktop report rendering

For syntax and runtime validation, retain the repository's existing Node test commands:

```powershell
node --check app.js
node --check server.js
npm test
npm run test:all
```

The first implementation milestone is complete only when database-calculated reports match the workbook fixture values to the workbook's displayed precision.
