# Player season card conventions

How the one-page player season cards are built and what has to stay true of them.
Follow this whenever you produce a batch — including for teams other than the
Gators. The rules live in code, so a normal run reproduces them; this doc is the
intent, so a future session doesn't regress them by "cleaning up."

`docs/HANDOFF.md` has the design system (palette, croc band, auto-fit layout).
This doc is the stats side: what goes on a card, where each number comes from,
and which gates have to be green before anything is sent to a player.

## Print only

The owner stopped sending mobile cards. Render with:

```
python3 scripts/render-batch.py --print "Name:b" "Name:p" "Name:both" ...
```

`--print` skips mobile rendering entirely. `defense()` in
`scripts/player-season-data.py` returns nothing when `--mobile` is passed, so the
mobile templates keep rendering their old four panels if anyone ever runs them.
Don't add new stats to the mobile cards.

## What's on a card

Batter card panels: PRODUCTION / PLATE DISCIPLINE / HIT BREAKDOWN / BASE RUNNING
& DEFENSE, plus a full-width PLATOON SPLITS strip and the game log.
Pitcher card panels: RUN PREVENTION / COMMAND & RATES / HITTERS AGAINST /
WORKLOAD & DEFENSE.

**Four panels, always.** New stats go INSIDE an existing panel — that is a
standing owner preference, not an accident of layout. The defense rows were added
to BASE RUNNING and WORKLOAD rather than as a fifth panel for exactly this reason.

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
