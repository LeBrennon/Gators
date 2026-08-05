# League-wide stats

Every team's full season stats (batting, running, pitching, fielding), for all 8
TCL clubs — 430 players total. Owner-provided CSV exports (PrestoSports team stat
pages), merged one player per record by `scripts/merge-team-stats.py`.

This exists because `texasleaguestats.prestosports.com` is unreliable as a live
source: its bulk leaderboard pages are Cloudflare-blocked from this environment,
and separately went down with a site-wide 500 for the owner too. Presto also
publishes no pitching ranks at all on a player's own page, and computing hitting
ranks from its raw leaderboard was tried and abandoned earlier this season (the
board pages out short of the full league, and applies a rate-stat qualifier the
raw page doesn't show). This dataset is the fix: the complete league, owned
outright, refreshed only when the owner supplies new exports.

`scripts/build-league-ranks.py` reads these 8 files and computes every player's
league rank in every card-relevant stat — see that script and
`docs/agents/player-cards.md` for the qualifiers (minimum AB / IP before a rate
stat can rank) and the reasoning behind them.

Re-fetching: there's no automated pull. When the owner sends new CSV exports
(same four-file-per-team shape: batting, running, pitching, fielding), save
them as `<team>_batting.csv` / `_running.csv` / `_pitching.csv` / `_fielding.csv`
in this directory, run `python3 scripts/merge-team-stats.py <team> "<Team
Name>"` to rebuild that team's `<team>.json`, then rerun
`python3 scripts/build-league-ranks.py` to recompute every rank in the league.
