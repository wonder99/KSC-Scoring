# KSC Darts League

A browser-based 701 darts scorer backed by PostgreSQL. The app supports live match scoring, normalized league submissions, public reports, CSV compatibility downloads, and authenticated league administration.

See the [Player Guide](user-guide.html) for scoring instructions and the [Admin Guide](admin/admin-guide.html) for league management.

## App version

The landing page version increments automatically before each commit. Enable the repository hook once per clone:

```powershell
git config --local core.hooksPath .githooks
```

The hook requires Node.js and stages the updated version label in `index.html`.

## Run the app

The Node.js server serves the scorer, reports, admin dashboard, and API. Install dependencies and provide these environment variables:

- `DATABASE_URL` - PostgreSQL connection string
- `UPLOAD_API_KEY` - key for score submissions and CSV uploads
- `ADMIN_API_KEY` - key for `/admin` and admin APIs

For a Render external database, use the PostgreSQL **External Database URL** locally and include `sslmode=verify-full` or another TLS setting supported by the database. The Render internal hostname is intended for Render services.

```powershell
npm.cmd install
$env:DATABASE_URL = "your-postgresql-connection-string"
$env:UPLOAD_API_KEY = "your-upload-key"
$env:ADMIN_API_KEY = "your-admin-key"
npm.cmd run migrate
npm.cmd start
```

Open <http://localhost:10000>.

- Scorer: `/`
- Public league stats: `/stats` (old `/reports` links redirect to `/stats`)
- Admin dashboard: `/admin`
- Player guide: `/user-guide.html`
- Admin guide: `/admin/admin-guide.html`

Static-only hosting cannot provide database submissions, reports, migrations, or administration.

## League database migrations

Server startup creates the existing CSV upload table and applies forward-only PostgreSQL migrations from `migrations/`.
Run migrations manually with `npm.cmd run migrate` after configuring `DATABASE_URL`.
Public league stats are available at `/stats`. They require no league upload or admin key. `/reports` redirects to `/stats` for compatibility.
Import the authoritative team roster CSV and workbook genders into the active season with:
`npm.cmd run backfill:rosters -- team_lists.csv "C:\path\to\league-workbook.xlsx"`
Import the schedule into the active season with:
`npm.cmd run backfill:schedule -- dart_league_schedule.csv`
Import existing XLSX statistics through week 10 and continue adding new week results with:
`npm.cmd run backfill:baselines -- team_lists.csv "C:\path\to\league-workbook.xlsx" 10`

Configure `ADMIN_API_KEY` to enable the dashboard at `/admin`.
The `/admin` page creates a 12-hour HttpOnly session cookie after the key is entered. The admin API also continues to accept `Authorization: Bearer <ADMIN_API_KEY>` for scripts and integrations.
Do not run `darts_league_schema.sql` or `darts_league_schema_postgresql.sql` against an existing database; those files are workbook model references rather than the migration runner.

Applied migrations are recorded in `schema_migrations`. Starting the server requires a working `DATABASE_URL` and `UPLOAD_API_KEY`.

Existing `score_csv_uploads` records can be reconciled after migrations with `npm.cmd run backfill:scores`. It is a data import, not a required startup step.

## Current implementation state

- The active 2026-2027 season is baseline protected through week 10, ending November 18.
- Week 10 and earlier submissions are rejected so workbook totals cannot be overwritten.
- Player names are canonicalized against `team_lists.csv`; the admin dashboard can edit or merge records.
- Browser submissions write normalized turns, lineups, game results, and a compatibility CSV record.
- Public reports combine workbook baselines with accepted post-baseline submissions.
- Admin users can manage seasons, teams, players, schedule matches, submissions, turn revisions, and rejection/acceptance status.
- The player and admin guides describe browser and league workflows.

## Database backups

Authenticated administrators can create, download, and restore backups from `/admin` in the **Backups** tab. Restore requires typing `RESTORE` exactly and confirmation in the browser.
Use **Upload Backup** to upload an existing `.dump` file. The upload is stored in `backups/` and does not modify or restore the database. Download and restore remain separate actions.
Administrators can also upload an existing `.dump` file in the Backups tab. Uploading preserves the file on the server but does not restore or modify the database until the backup is selected and restored with confirmation.

Web backup creation and restore require `pg_dump` and `pg_restore` to be installed inside the running Node server environment. The local Windows machine and hosted container must both have PostgreSQL client tools on `PATH`.

Create a custom-format PostgreSQL backup:

```powershell
$env:DATABASE_URL = "your-postgresql-connection-string"
npm.cmd run backup
```

Backups are written to `backups/league-YYYY-MM-DDTHH-mm-ss.dump`. Restore only after stopping the app and confirming that the target database is the intended environment:

```powershell
$env:DATABASE_URL = "target-postgresql-connection-string"
npm.cmd run restore -- --confirm=RESTORE --file=backups\league-YYYY-MM-DDTHH-mm-ss.dump
```

Restores are destructive in the target database. `pg_dump` and `pg_restore` must be installed and available on `PATH`.
Restore treats the common `pg_stat_statements` ownership warning as a partial-success warning when it is limited to two ignored extension operations. Other `pg_restore` errors remain failures and should be reviewed before relying on the restored database.

## Start a match

1. The match day defaults to today when it is scheduled, or otherwise the most recent past scheduled day. Choose another day if needed.
2. Choose your team from that day's scheduled teams; the opponent and board are filled in from the schedule.
3. Select **Start Game**. The first four roster names start in the **Playing this game** area above the divider, and exactly four names always stay there. Drag an unselected name into the desired spot; the fourth selected player moves below the divider. The top-to-bottom order is the play order. Drag a selected name down onto its intended row; the names in between shift up. Use **Add** to replace the fourth player, **Replace** to swap a selected player with the first unselected player, and the arrows to reorder on touch screens. An optional `Spare` player appears below the divider; a spare's turn is prefilled with 25 points, which must still be submitted.
4. Select **Start Game** to begin the first of seven games for the selected match. Each game starts at 701 with a shared team score. Use the arrows at the top to switch between games; each game's lineup and scoring state are kept separately. After a game is won, choose the next lineup. **Restart Everything** clears all game and scoring data for the match while keeping the selected match and team.

When scoring with the dart grid, enter up to three darts per turn; Miss records a zero-point dart. The total-only field is also available. A winning checkout must be recorded with the dart grid so the app can verify the final dart was a double or bull. Scores that go below zero, leave one, or reach zero without a double-out bust and do not reduce the team's score.

Checkout suggestions follow the recommended outs and alternatives in [Rick Smith's Doubling Out Charts](https://ricksmith.ca/Darts/dartsouts.htm), including the chart's unavailable three-dart finishes. During a dart-grid turn, the strategy updates for the remaining darts. Turn history appears below the scoring controls as four player rows, with each player's successive scores shown as positive values and added horizontally; scores of 95 or more are highlighted. If the opponent doubles out first, select the opponent-win button and confirm to finish the game as a loss.

After each game, use **Submit to League** on the winner screen. The first press reveals the league upload key field. Enter the key and submit the results. The server stores normalized turns, lineups, winner information, and checkout data in PostgreSQL.

The 2026-2027 season is baseline-protected through week 10 (November 18). The scorer rejects submissions for weeks through week 10 and allows new normalized submissions for scheduled matches after that cutoff.

## Public reports

Open `/stats` to view:

- Standings
- Mens Overall, Average, 95+, and Outs
- Ladies Overall, Average, 95+, and Outs
- League leaders
- Team and player totals based on week 10 workbook baselines plus accepted post-cutoff submissions

Report filtering uses the active season. Report rows are not artificially capped.

## Admin dashboard

Open `/admin` and enter `ADMIN_API_KEY` to manage:

- Seasons
- Teams
- Players, including edit, remove, delete, and merge
- Schedule matches
- Submission status
- Submission turn revisions with audit reasons

On the Schedule tab, administrators can download the selected season as an XLSX workbook, edit it offline, and upload it back. Match ID values preserve existing rows. Removing a row deletes a match only if it has no linked games; linked matches are protected.

Player edits preserve the existing player ID, so existing baselines and linked turn data remain attached. Merge operations require explicit canonical and duplicate player IDs. Rejected submissions do not affect public reports.

## Deploy and share the app

To enable submissions, reports, and administration, deploy this repository to Render as a **Web Service**, not a Static Site:

- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Environment Variables**: `DATABASE_URL`, `UPLOAD_API_KEY`, and `ADMIN_API_KEY`

The upload key entered in the app must exactly match the service's `UPLOAD_API_KEY`. The admin key must match `ADMIN_API_KEY`. Keep these values in environment settings and do not place them in source files or browser code.

Match progress is saved in this browser using local storage and restored after a reload on the same device. It is not synchronized between devices or saved to an account. Submit completed matches before clearing browser site data or changing devices.

## Testing

Run syntax and application checks:

```powershell
node --check app.js
node --check server.js
npm.cmd test
```

The Node test suite covers CSV parsing, migration structure, browser submission validation, report routes, admin authorization, and compact UI terminology.
Set `DATABASE_URL` before running the suite to include the reversible live integration test. It submits one post-week-10 browser score, verifies that player and team stats increase, and removes the test submission, game, turn, and compatibility CSV data afterward.

## Available npm commands

```text
npm start                      Start the server
npm run migrate                Apply forward-only database migrations
npm run backfill:scores        Normalize existing CSV upload rows
npm run backfill:rosters       Import team_lists.csv plus workbook genders
npm run backfill:schedule      Import dart_league_schedule.csv
npm run backfill:baselines     Import established XLSX totals
npm run merge:keepers-duplicates Merge the previously identified Keepers name duplicates
npm run backup                 Create a PostgreSQL backup
npm run restore -- ...         Restore a PostgreSQL backup with confirmation
npm test                       Run the Node test suite
```

## Continuing implementation in a new chat

The main implementation branch is `league2`. Keep it separate from `main` until the implementation is approved. Before starting a future session:

1. Commit or stash the current implementation changes.
2. Record any uncommitted data/import decisions in the handoff message.
3. Provide this README, `LEAGUE_DATABASE_PLAN.md`, the admin guide, and the relevant database migration files to the next chat.
4. State which real submissions, baseline imports, or database edits have already occurred.
5. Keep `DATABASE_URL`, `UPLOAD_API_KEY`, and `ADMIN_API_KEY` in environment variables, not in chat or source files.

The repository is the source of truth for code and migrations. A concise handoff should include the current branch, migration numbers applied, active season, baseline cutoff, outstanding test work, and the last verified test command.

## CSV formats

Roster file (`team_lists.csv`): one `team name, player name` row per player.

Schedule file (`dart_league_schedule.csv`): a header row with `date`, `board`, `team_1`, and `team_2` columns. Scheduled team names are matched to roster names without a leading "The" or trailing team-number parentheses.
