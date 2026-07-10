# Box-score PDF conventions

How the branded one-page box-score PDF (`scripts/box-score.js`, `npm run report:box`)
is generated and every formatting rule baked into it. Follow this whenever you make
the next game's box score so it matches the ones already produced. The rules live in
code (mostly `buildHtml`), so a normal run reproduces them — this doc is the intent,
so a future session doesn't regress them by "cleaning up."

## Automatic delivery (no action needed)

When a Gators game goes final, the live server fires a `gators-final`
`repository_dispatch` and the `Refresh seed + post-game report` Action
(`.github/workflows/refresh-seed.yml`) builds the box-score PDF and **emails it**
to the recipients — alongside the post-game report, GM cards, and rest chart. The
box step runs `box-score.js <game_id> --pdf --strict` in a retry loop; `--strict`
fails until Presto has rendered the finished box (line score present), so it waits
out the post-final gate lag before sending. So the owner gets the box in their
inbox within a few minutes of the last out without asking. Generate by hand only
for a re-run or a game that predates the automation.

## Generating one

**Right after a game ends — one command (the fast path):**
```
REPORT_APP_BASE=https://gators.onrender.com node scripts/box-score.js tonight --pdf
```
`tonight` (also `live`) pulls the current **featured** game straight from the live
app: `/api/game` for the header meta (home/away, score, record) and `/api/boxscore`
for the tables + play-by-play. No manual data, even though a just-finished game
isn't in the season seed yet. Team names come from the box's own captions when the
line score hasn't rendered, so the Gators are still branded/ordered correctly. An
explicit fresh-final box id works the same way when it's the featured game.

**Any other game:**
```
node scripts/box-score.js <target> --pdf      # latest | "Jun 27" | 20260627_5hqn | box URL
```
`latest`/date/id resolve through the season seed. A box-score URL is fetched + parsed
locally (`deriveMeta` reads the header from the parsed box).

Output lands in `reports/box/` (gitignored — a personal artifact, never committed and
never on the website). Deliver the file to the user; don't commit it.

- **Data source:** the parsed box comes from the live app's `/api/boxscore?id=…`
  (`REPORT_APP_BASE`). PrestoSports 403s most hosts, so go through the app.
- **Record:** on the `tonight` path it's taken from `/api/game` (the Gators side's
  W-L, which normally already includes the just-finished game). If the feed's record
  looks stale, confirm with the user.
- **Manual fallback (`BOX_DATA`):** only needed when the app is unreachable or the
  numbers are in hand but the box can't be fetched. JSON shape:
  `{ game:{id,date,home,opp,gs,os,win}, record:{w,l}, line, box, pbp }` — `pbp` is
  required for HBP, positions, subs, and position-change notes.
  `BOX_DATA=/path/box.json node scripts/box-score.js --pdf`.
- **Rendering:** local Chromium at `/opt/pw-browsers/chromium`, one US-letter page.
- **Verify before sending:** render the HTML at *true letter pixel size*
  (`--window-size=816,1056`, i.e. 8.5×11 @ 96dpi) and eyeball it. A taller preview
  window hides bottom overflow — check the **Totals rows are all visible**.

## Formatting rules (all in `scripts/box-score.js`)

1. **Names** — position prefix upper-cased and spaced off the name (`RF Griffin
   Hebert`); the player name keeps its real case. An all-caps source name is
   title-cased, but intentional inner caps (`LaCava`, `DeShields`) are preserved.
   Never re-introduce the blanket `span{text-transform:uppercase}` — it SHOUTED
   pitcher/positionless names.
2. **No season AVG column** — this is a single-game sheet. The `bxavg` column is
   stripped. (The in-app web box score still shows AVG — that's intentional.)
3. **Substitutes indented** under the starter they replaced (MLB Gameday style),
   with `a-/b-` letters and a legend beneath the table: `a- in for X in the Nth`.
   This includes subs the app itself missed because the source left their position
   blank — the position is backfilled from the play-by-play, then the "repeated
   position = sub" rule is re-run so they indent + get a letter like the rest.
4. **Backfilled positions** — a positionless player gets his spot from the PBP
   `"<Player> to <pos> for <Other>"` announcement (double-switch cases).
5. **Idle pitchers dropped from batting** — a reliever listed with an empty 0-for-0
   line is removed. A pitcher who *actually batted* in the DH slot (nonzero line) is
   kept, so genuine two-way games render correctly.
6. **HBP column** is derived from the play-by-play. The pitching table auto-sizes
   each stat column so no header (`HBP`, `ERA`, `#P`, `S%`) ever clips.
7. **Long pitcher names** shorten to `F. Last` (one line) instead of wrapping the
   narrow pitching name column. Short names stay in full.
8. **Box notes** under each batting table: `2B/3B/HR/SB/CS/E`. Errors (`E`) sit on
   their **own row** beneath the offensive notes so the fielders stay grouped.
9. **Position changes** — a dual-position player (box shows `SS/3B`) changed
   mid-game. A "Position changes (Nth):" line under the batting table names each,
   `from→to`, with the inning. The inning comes from the PBP; when a sub enters and
   the fielders cascade one spot over (no per-player announcement), they're dated to
   the team's sole defensive-realignment inning.
10. **Header scoreboard** is a compact card: team name left, score right, winner's
    score in gold, `FINAL` footer. The record uses a **plain hyphen** (`4-2`), not an
    em dash. Title stays on one line.
11. **One-page fit** — the header is deliberately compact and cell padding is
    adaptive (`padV`, scaled to the row count and the caption/legend/notes overhead)
    so a long lineup + deep bullpen still lands every Totals row on the single page.
    If you add vertical content, re-verify at true letter size.
