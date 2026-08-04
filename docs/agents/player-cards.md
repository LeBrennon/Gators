# Player season card conventions

How the player season cards are built and what has to stay true of them.
Follow this whenever you produce a batch — including for teams other than the
Gators. The rules live in code, so a normal run reproduces them; this doc is the
intent, so a future session doesn't regress them by "cleaning up."

`docs/HANDOFF.md` has the design system (palette, croc band, auto-fit layout).
This doc is the stats side: what goes on a card, where each number comes from,
and which gates have to be green before anything is sent to a player.

## Print only

The owner stopped sending mobile cards. Render with:

```
python3 scripts/render-batch.py --print --roster data/season-final-batch.json
python3 scripts/render-batch.py --print --dry-run --roster data/season-final-batch.json   # gates only
```

A roster file holds the whole batch and every role in one reviewed place, so a
long command line can't quietly drop a player or send someone the wrong card.
`--dry-run` resolves every name and runs the validation gate without rendering —
run it first; it is cheap and it is the thing that says the batch is sendable.

Ad-hoc form still works: `--print "Name:b" "Name:p" "Name:both"`.

`--print` skips mobile rendering entirely. `defense()` in
`scripts/player-season-data.py` returns nothing when `--mobile` is passed, so the
mobile templates keep rendering their old four panels if anyone ever runs them.
Don't add new stats to the mobile cards.

## Who gets two cards

A player with appearances in both roles gets two cards **only when both roles are
substantial**. The owner set this on the active-roster batch: Jack Garcille (10
batting / 9 pitching) gets both; the other six two-way players get the single card
matching how they were actually used — Corrales, Degeyter, Robin and Hollier
pitching, Sparks and Bandiero hitting. Don't infer "both" from a player merely
having a line in each table; a card built on one or two games in a secondary role
reads as filler next to a full season.

Use the box-score spelling of a name in a roster file — that is what
`find_player` matches. The roster in `server.js` says "Matt Scott" and the box
says "Matthew Scott"; the roster-file spelling has to be the latter or the script
exits without finding him.

## Two pages

A print card is **two letter pages**: page 1 is every stat, page 2 is the
game-by-game log on its own. The log used to share page 1 and, on a long season,
squeezed itself into two columns at 8.8px to fit. Giving it a page of its own is
what lets both the stats and the log be set at a size a player can actually read.

`scripts/lib/season-card-print.js` holds the whole layout; the two templates carry
nothing but a DATA block and a call into it, so the batter and pitcher cards
cannot drift apart. Each page auto-fits by binary-searching scale factors against
a headless measurement — page 1 scales its panels, page 2 scales the log's type
(limited by page width) and its row height (limited by page height) separately,
because a short log runs out of width long before it runs out of height. Nothing
is allowed to overflow, and `render-batch.py` fails a card whose PDF is not
exactly two pages.

Panel legends are collected into one key block at the foot of page 1 rather than
sitting inside each panel. Four ragged legend blocks in half-width panels cost
far more height than one paragraph wrapping across the page, and that height is
what decides how large the numbers print.

## What's on a card

Batter card panels: PRODUCTION / PLATE DISCIPLINE / HIT BREAKDOWN / BASE RUNNING
& DEFENSE, plus the full-width PLATOON SPLITS, BY COUNT and BATTED BALL strips
and the game log.
Pitcher card panels: RUN PREVENTION / COMMAND & RATES / HITTERS AGAINST /
WORKLOAD & DEFENSE.

**Four panels, always.** New stats go INSIDE an existing panel — that is a
standing owner preference, not an accident of layout. The defense rows were added
to BASE RUNNING and WORKLOAD rather than as a fifth panel for exactly this reason.

The full-width strips are not a fifth panel: they are a print-layout move. A row
tagged `wide` in a panel's data is hoisted out and laid across the page, because
a slash line or five count buckets do not fit in a half-width column. `wide`
alone lands in PLATOON SPLITS; `wide:TITLE` opens a strip with that title. The
data still says which of the four panels the row belongs to — BY COUNT is
PLATE DISCIPLINE's, BATTED BALL is HIT BREAKDOWN's.

### wOBA and wRC+ (batter cards)

In PRODUCTION, after the slash line, where Baseball Savant puts them: the rate
stats that the slash line rolls up to, ahead of the derived and counting stats.
Both come from `scripts/runvalues.py`, which replays the league's own
play-by-play to derive TCL run values rather than borrowing MLB's. wRC+ is
indexed to TCL runs per plate appearance, so 100 is an average TCL hitter. **No
park factor** is applied — the league publishes none, and inventing one would be
worse than leaving it out. Say so if anyone asks why a card's wRC+ differs from a
site that parks-adjusts.

### Count splits and batted-ball direction (batter cards)

From `scripts/advanced.py`. The count bucket comes from the count Presto printed
for the plate appearance, never from reading the pitch letters, so it doesn't
depend on a scorer telling a swinging strike from a called one. Direction comes
from where the scorer said the ball went. **Whiff rate is deliberately absent** —
it would require trusting swing-and-miss entry, which the owner does not.

The BATTED BALL strip always carries a `Located` cell: how many balls in play had
a direction recorded and how many were omitted. Presto often writes "singled"
with no direction, and those are dropped, never guessed. Print the count so the
percentages can't be mistaken for the whole season.

### Defense (every card)

`PO · PO/G · A · E · FLD%`, from `scripts/fielding.py`.

A two-way player's two cards split the glove work: his hitting card reports
`defense(player, 'field')` and his pitching card `defense(player, 'p')`, so the
same putout is never counted on both. A player with no chances in that role
leaves his panel untouched — five of the 26 cards in the first batch have no
defensive line for that reason.

### Catchers: the throwing game

Anyone who caught also gets `Runners CS · Steals allowed · CS%`, plus a Pickoffs
row when he has any.

- A caught stealing is the catcher's **only when the throw starts with him** —
  `out at second c to 2b, caught stealing`. A runner retired on the pitcher's
  pickoff-and-rundown (`out at second p to 1b to ss, caught stealing`) is not his.
- Pickoffs are tracked separately and stay **out of CS%**, the way the league
  counts them.
- The labels are spelled out ("Runners CS", "Steals allowed") because the same
  panel already carries SB/CS for the player's own base running. Don't shorten
  them back to `CS` — the two would be indistinguishable on the card.

## Where the numbers come from

`box-seed.json` is the only stats source: every finished game with `box[]` (box
score HTML) and `pbp[]` (play-by-play HTML).

| Stat family | Source | Script |
|---|---|---|
| Counting stats (G/PA/AB/H/R/RBI/BB/K, IP/ER/#P) | official box score | `player-season-data.py` |
| Advanced (BABIP, FIP, FPS%, batted-ball mix, K%/BB%) | play-by-play text | `player-season-data.py` |
| Platoon splits | play-by-play + `league-throws.json` / `league-bt.json` | `batter-splits.py`, `platoon-splits.py` |
| **Defense (PO/A/E) and catcher CS** | **play-by-play** | **`fielding.py`** |

The official fielding table is **not** in `box-seed.json` — `parseBoxscore` in
`server.js` keeps only the batting and pitching tables — and Presto blocks direct
scraping from agent environments. That is why `fielding.py` rebuilds defense from
the play-by-play rather than reading it. Don't go looking for a fielding column
that isn't there.

## Gates — all of these must be green before sending

`python3 scripts/player-season-data.py "Name" --batter|--pitcher` prints
`N games, 0 mismatched` on stderr: per-game AB/H/BB/K (batters) or H/BB/K
(pitchers) rebuilt from play-by-play must equal the box line. **Never send a card
with a mismatch.**

`python3 scripts/fielding.py` prints five gates. On the 47-game Gators seed:

| Gate | What it proves | Result |
|---|---|---|
| PO | putouts credited == outs recorded on defense | 47/47 |
| E | errors credited == official line-score E column | 47/47 |
| LINEUP | the seeded nine sit where Presto chips them | 47/47 |
| FIELD | nine distinct fielders on at all times | 46/47 |
| CREDIT | every credit lands on a named player | 46/47 |

The two 46/47s are the same game, 7/1 at Brazos Valley: the play-by-play never
says who took left field after Landreneau moved to second, so 3 putouts stay
unattributed rather than guessed onto a player. Leaving a credit orphaned is the
correct behaviour — `fill_vacancies` only seats a player when exactly one person
carries that position's chip.

Two gate subtleties worth not re-learning the hard way:

- **Out markers under-count.** Presto omits the `(N out)` marker when an inning
  ends inside another batter's play ("... advanced to third, out at home lf to
  c"), so a completed half-inning is counted as three outs and only the game's
  final half-inning reads its marker.
- **Errors have two spellings.** `error by 3b` and the scorer shorthand `E5`.

## Known limits (say these out loud when handing cards over)

- **No third source for departed players.** Once a player is off the active
  roster, `roster-seed.json` has no official season line to diff against, so
  counting stats are validated box-vs-play-by-play only — two views of the same
  Presto feed.
- **Putouts read about 2 high** against the one external number available (a fan
  comparison sheet had Ayden Sunday at 64 PO / 3 A / 1 E; this pipeline gives
  66 / 3 / 1). Assists and errors matched exactly. Treat PO as ±2 until someone
  diffs it against the league's own fielding page from a browser.
- Catcher CS is on firmer ground than PO/A/E: steal attempts are stated
  explicitly in the text, and a straight recount of the raw play-by-play (121
  uncontested steals + 24 catcher caught-stealings = 145 attempts) matches the
  per-catcher lines exactly.

## Producing cards for other teams

The card scripts are hard-wired to the Gators in two ways, and the seed is the
bigger problem of the two.

**1. The seed only holds Gators games.** All 47 entries in `box-seed.json` have
Lake Charles as one of the two teams, because `build-box-seed.js` walks
`/api/schedule`, which is the Gators' schedule. Building a card for, say, a San
Antonio player from today's seed would give you only his games against the
Gators, not his season — the card would look complete and be badly wrong.

The way through: **the live site's box proxy serves any league box id**, not just
Gators games. Verified working:

```
curl -sSL "https://www.whatisthegatorscore.com/api/boxscore?id=20260728_zv8q"
   -> Victoria Generals vs Brazos Valley Bombers, both teams' box + 18 pbp blocks
```

The server warms Presto cookies, so this succeeds where a direct fetch to
`texasleaguestats.prestosports.com` returns 403 from an agent environment. So the
first job for a league-wide batch is collecting every team's box ids and
extending the seed — not rewriting the card renderers.

**2. `fielding.py` hard-codes the team.** `GATORS`, the `'Gators' in cells[0]`
test in `line_errors`, and the "opponent batting means we're in the field" test
all key off the club name. Generalising means threading a team name through
`lineup_from_box`, `game_fielding` and `line_errors` — mechanical, but do it
deliberately and re-run the gates per team, since the gates are what make the
numbers sendable. `player-season-data.py` has the same assumption in
`find_player` and `game_meta`, and `data/batch-roster.json` is a Gators-only bio
file, so other teams need their own bios (`league-roster.json` is the starting
point).

Handedness lookups are already league-wide: `league-bt.json` (442 batters) and
`league-throws.json` (321 pitchers) cover the whole TCL, so splits should carry
over without new research for players already in them.
