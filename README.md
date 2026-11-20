# The 701 Club

A browser-based 701 darts scorer for one team's shared score. Four selected team members rotate turns; the opposing team's score is not tracked.

See the [Player Guide](user-guide.html) for scoring instructions and a simple phone-hosting option.

## Run the app

The app loads `team_lists.csv` and `dart_league_schedule.csv` automatically, so serve this folder over HTTP instead of opening `index.html` directly:

1. Open PowerShell in this project folder.
2. Run `py -m http.server 8000`.
3. Open <http://localhost:8000> in your browser.

If the `py` command is unavailable, use `python -m http.server 8000`.

## Start a match

1. The match day defaults to today when it is scheduled, or otherwise the most recent past scheduled day. Choose another day if needed.
2. Choose your team from that day's scheduled teams; the opponent and board are filled in from the schedule.
3. Select **Start Game**. The first four roster names start in the **Playing this game** area above the divider, and exactly four names always stay there. Drag an unselected name into the desired spot; the fourth selected player moves below the divider. The top-to-bottom order is the play order. Drag a selected name down onto its intended row; the names in between shift up. Use **Add** to replace the fourth player, **Replace** to swap a selected player with the first unselected player, and the arrows to reorder on touch screens. An optional `Spare` player appears below the divider; a spare's turn is prefilled with 25 points, which must still be submitted.
4. Select **Start Game** to begin the first of seven games for the selected fixture. Each game starts at 701 with a shared team score. After a game is won, choose the next lineup.

When scoring with the dart grid, enter up to three darts per turn; Miss records a zero-point dart. The total-only field is also available. A winning checkout must be recorded with the dart grid so the app can verify the final dart was a double or bull. Scores that go below zero, leave one, or reach zero without a double-out bust and do not reduce the team's score.

Checkout suggestions follow the recommended outs and alternatives in [Rick Smith's Doubling Out Charts](https://ricksmith.ca/Darts/dartsouts.htm), including the chart's unavailable three-dart finishes. During a dart-grid turn, the strategy updates for the remaining darts. Turn history appears below the scoring controls as four player rows, with each player's successive scores shown as positive values and added horizontally; scores of 95 or more are highlighted. If the opponent doubles out first, select the opponent-win button and confirm to finish the game as a loss.

After each game, the winner screen offers CSV download, **Email CSV**, or **Upload Results**. The CSV contains each selected player's accepted points and turn count, plus the winning team, for every completed game in the fixture. Email CSV downloads the file and opens a Gmail draft addressed to `speedfreqall@gmail.com`; sign in if prompted and attach the downloaded CSV before sending. Upload Results downloads the file and opens the team's Dropbox File Request; select the downloaded CSV on Dropbox to complete the upload. Neither service receives the file automatically.

## Share the app

The app is static and needs no build step. Upload the site files together using [Netlify Drop](https://app.netlify.com/drop), then share the resulting HTTPS link with players. Include `index.html`, `app.js`, `styles.css`, `team_lists.csv`, and `dart_league_schedule.csv`; include `user-guide.html` if you want to share the guide too.

Static hosting makes the roster and schedule files publicly accessible. Scores are not synchronized between devices or saved to an account; use one device as the scorekeeper, and download results before refreshing or closing the page.

## CSV formats

Roster file (`team_lists.csv`): one `team name, player name` row per player.

Schedule file (`dart_league_schedule.csv`): a header row with `date`, `board`, `team_1`, and `team_2` columns. Scheduled team names are matched to roster names without a leading "The" or trailing team-number parentheses.
