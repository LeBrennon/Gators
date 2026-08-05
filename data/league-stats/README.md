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

## Known correction: Jack Garcille (lakecharles.json)

The league's own pitching export for Jack Garcille is missing his 7/17 relief
appearance at Baton Rouge (3.0 IP, 2 H, 0 R, 0 ER, 1 BB, 4 K) — the box score
for that game is unambiguous (his line plus the other two Gators pitchers'
lines sum exactly to the game's own printed pitching totals), so this is a
gap in the league's compilation, not a scope/identity issue like Matt Scott's.
His `pitching` record here has been hand-corrected (app/ip/h/bb/k/bf/era/whip)
to include that appearance. **If the owner sends a refreshed Lake Charles
pitching CSV, re-check Garcille's line before re-running merge-team-stats.py**
— if the league has since fixed their own record, the fresh CSV will already
be correct and this note (and the need for the hand patch) goes away; if not,
the same correction needs re-applying on top of the new export.
