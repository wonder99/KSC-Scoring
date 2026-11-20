# The 701 Club

A browser-based 701 darts scorer for one team's shared score. Four selected team members rotate turns; the opposing team's score is not tracked.

See the [Player Guide](user-guide.html) for scoring instructions and a simple phone-hosting option.

## Run the app

The Node.js server serves the app and provides the score-upload API. To run it locally, configure `DATABASE_URL` with a PostgreSQL connection string and set `UPLOAD_API_KEY` to a secret key. Install dependencies and start the server:

```powershell
npm.cmd install
$env:DATABASE_URL = "your-postgresql-connection-string"
$env:UPLOAD_API_KEY = "your-secret-upload-key"
npm.cmd start
```

Open <http://localhost:10000>. Enter the same `UPLOAD_API_KEY` value in the app's **League upload key** field when saving results.

For scoring without server uploads, you can still serve the files with a static HTTP server. In that case, the **Save to League** API is unavailable.

## Start a match

1. The match day defaults to today when it is scheduled, or otherwise the most recent past scheduled day. Choose another day if needed.
2. Choose your team from that day's scheduled teams; the opponent and board are filled in from the schedule.
3. Select **Start Game**. The first four roster names start in the **Playing this game** area above the divider, and exactly four names always stay there. Drag an unselected name into the desired spot; the fourth selected player moves below the divider. The top-to-bottom order is the play order. Drag a selected name down onto its intended row; the names in between shift up. Use **Add** to replace the fourth player, **Replace** to swap a selected player with the first unselected player, and the arrows to reorder on touch screens. An optional `Spare` player appears below the divider; a spare's turn is prefilled with 25 points, which must still be submitted.
4. Select **Start Game** to begin the first of seven games for the selected fixture. Each game starts at 701 with a shared team score. Use the arrows at the top to switch between games; each game's lineup and scoring state are kept separately. After a game is won, choose the next lineup. **Restart Everything** clears all game and scoring data for the fixture while keeping the selected match and team.

When scoring with the dart grid, enter up to three darts per turn; Miss records a zero-point dart. The total-only field is also available. A winning checkout must be recorded with the dart grid so the app can verify the final dart was a double or bull. Scores that go below zero, leave one, or reach zero without a double-out bust and do not reduce the team's score.

Checkout suggestions follow the recommended outs and alternatives in [Rick Smith's Doubling Out Charts](https://ricksmith.ca/Darts/dartsouts.htm), including the chart's unavailable three-dart finishes. During a dart-grid turn, the strategy updates for the remaining darts. Turn history appears below the scoring controls as four player rows, with each player's successive scores shown as positive values and added horizontally; scores of 95 or more are highlighted. If the opponent doubles out first, select the opponent-win button and confirm to finish the game as a loss.

After each game, the winner screen offers CSV download, **Email CSV**, or **Upload Results**. The CSV contains each selected player's accepted points and turn count, plus the winning team, for every completed game in the fixture. Email CSV downloads the file and opens a Gmail draft addressed to `speedfreqall@gmail.com`; sign in if prompted and attach the downloaded CSV before sending. Upload Results downloads the file and opens the team's Dropbox File Request; select the downloaded CSV on Dropbox to complete the upload. Neither service receives the file automatically.

## Deploy and share the app

To enable **Save to League**, deploy this repository to Render as a **Web Service**, not a Static Site:

- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Environment Variables**: `DATABASE_URL` (from a PostgreSQL database) and `UPLOAD_API_KEY` (a secret key)

The upload key entered in the app must exactly match the service's `UPLOAD_API_KEY`. A static-site deployment such as Netlify Drop can host the scoring UI, but it does not run this Node.js API, so server uploads will not work there.

Match progress is saved in the browser on that device and restored after a reload; it is not synchronized between devices or saved to an account. Clearing the browser's site data removes saved progress, so download results before clearing it.

## CSV formats

Roster file (`team_lists.csv`): one `team name, player name` row per player.

Schedule file (`dart_league_schedule.csv`): a header row with `date`, `board`, `team_1`, and `team_2` columns. Scheduled team names are matched to roster names without a leading "The" or trailing team-number parentheses.
