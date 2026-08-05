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

## League awards

`AWARDS` in `player-season-data.py`, keyed by full name, prints as a gold pill
under the role line on page 1 — All-TCL Team, TCL Player/Pitcher of the Week.
**An award goes in only after its own article or announcement has been opened
and read**, never off a category-listing summary: texascollegiateleague.com's
listing page returned a different winner for the same week slot than the
week's own article more than once while this was researched. Cross-check a weekly-award name against `box-seed.json` before adding it: the
site's article URLs carry no season, so the same "Week N" slug can hand back a
prior year's winner. That's why Week 8 Pitcher of the Week is unset — the
credited name never appears in a 2026 Gators box score, and the owner confirmed
he's a 2025 Gator.

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

### Page 1's type target, and why it lands short

Below the season strip, page 1 scales its **type** (`--s`) separately from the
**space between things** (`--g`), and the fit spends every pixel of padding
before it gives back a point of type. The owner asked for double-size stats, so
`--s` is expressed as a fraction of double: **1.0 is exactly double, and it is
the ceiling** — the card never sets larger than asked, only smaller when the page
cannot hold it.

With everything currently on the card, a batter card reaches about **0.65 of
double** (~18px against the 12.6px it set before) with the spacing already pinned
at its floor. The constraint is content volume, not padding — and it is flat
across the batch: a 7-game card and a 44-game card land within a whisker of each
other, because page 1's content barely varies with games played. Pitcher cards
reach ~0.85, having one fewer strip and no ranks.

**The shortfall is accepted, and nothing comes off the card to close it.** That
is an owner decision, taken against measured alternatives, so don't "fix" the
shortfall later by deleting content or by rebalancing the fit:

| Page-1 content | Type reached |
|---|---|
| Everything (what ships) | 0.65 |
| − key/legend block | 0.88–0.95 |
| − key/legend − BY COUNT | 0.96 |
| − key/legend − BY COUNT − platoon splits | 1.00 |

(The alternatives were measured before the strips were made to stack, which cost
the shipping card about 0.04; they are still the right order of magnitude.)

Moving the legend or the strips to page 2 was measured too, and it is worse, not
better: on a 36–44 game card the log already fills page 2, so the moved block
sets at ~5px. Page 2 has spare room only on the light cards, which are the ones
that least need it.

### A panel's stats sit on shared columns

Each of the four panels is **one grid**, not a stack of independent rows: six
tracks — label, value, rank for the left stat, the same three for the right.
Every label, every value and every rank in a panel therefore lines up with the
others. Laid out row by row instead, a value starts wherever its own label
happens to end, which is how `BB% 15.2` / `BB:K 1.19` / `BB 25` each came to
begin at a different x.

Two things this depends on, both easy to undo by accident:

- **Every row emits exactly three cells.** The rank span is written even when the
  row has no rank. Drop it on the rankless rows and every following row shifts a
  column left, shearing the panel.
- **Auto-placement carries the left/right order.** Odd rows fill the first three
  tracks, even rows the last three — the same thing the old 50%-wide rows did. So
  the order rows arrive in still decides which side a stat lands on.

`.sr` generates no box at all now (`display: contents`), so its old padding lives
on the label and in the grid's gaps — and it is useless to the overflow guard,
which watches `.sg` instead.

**Nothing on page 1 reflows when it runs out of room — it overlaps.** A `.sg` is
a grid sized to its own content and a `.splitcell` is pinned to its share of a
strip, so type that outgrows the space either overflows the panel whole or paints
over whatever is beside it. Only `scrollWidth` reports either, so the fit refuses
any size where it happens and fails the card outright if the final choice does.

The guard has to measure the **label and value themselves**, not just the box
around them. A nowrap child that is allowed to shrink below its own text
overflows its own box while its parent's `scrollWidth` stays clean — so the fit
is told everything is fine. That is exactly how the platoon splits shipped with
the label printed over the slash line ("Total (165 P**.331**/.469/.575"): the
old guard looked only at `.sr` and `.splitcell` and reported zero overflows on a
page that was visibly scrambled. Don't narrow that selector list, and don't
reintroduce a `min-width: 0` on `.sl2` / `.sv2` that lets them shrink below
their text.

For the same reason **every full-width strip stacks** — label above value. Five
count buckets only fit that way, and at this type size so do three platoon
splits: side by side, the label and the slash line each want most of a third of
the page.

A **slash line is set as columns**, each part's label centred under its own
number rather than the three run together underneath all of them. The labels are
read off the row's own sub-label ("AVG · OBP · SLG"), not hardcoded, so the
pitcher card's vs LHB / vs RHB lines get it without the layout knowing about
them. Anything after the em dash — the OPS roll-up — is dropped: it has no
column to sit under, and OPS is already in PRODUCTION and the season strip. A
value that isn't a slash line (the count buckets) falls through to the plain
label-under-value form.

## What's on a card

Batter card panels: PRODUCTION / PLATE DISCIPLINE / HIT BREAKDOWN / BASE RUNNING
& DEFENSE, plus the full-width PLATOON SPLITS and BY COUNT strips and the game
log.
Pitcher card panels: RUN PREVENTION / COMMAND & RATES / HITTERS AGAINST /
WORKLOAD & DEFENSE.

**Four panels, always.** New stats go INSIDE an existing panel — that is a
standing owner preference, not an accident of layout. The defense rows were added
to BASE RUNNING and WORKLOAD rather than as a fifth panel for exactly this reason.

The full-width strips are not a fifth panel: they are a print-layout move. A row
tagged `wide` in a panel's data is hoisted out and laid across the page, because
a slash line or five count buckets do not fit in a half-width column. `wide`
alone lands in PLATOON SPLITS; `wide:TITLE` opens a strip with that title. Every
strip stacks its label above its value. The data still says which of the four
panels the row belongs to — BY COUNT is PLATE DISCIPLINE's, BATTED BALL is
HIT BREAKDOWN's.

### The league's line is the official number

**Where our play-by-play total and the TCL leaderboard disagree, the leaderboard
wins and its number goes on the card.** That is an owner ruling, and it is the
right one: the league's line is what a player sees on his own page, and our
per-game reconstruction exists to produce the stats Presto does *not* publish —
platoon splits, spray, count buckets, fielding — not to argue with it about the
ones it does. `official_line()` in `player-season-data.py` applies it; the rate
stats are taken as Presto prints them rather than recomputed, because Presto
rounds where it rounds.

Two players are excluded, and both exclusions are about scope, not doubt:

- **Matt Scott** — his card is a full-season line across Brazos Valley and Lake
  Charles by owner decision. The TCL page holds only his Gators half, so its
  totals describe a different season than the card does.
- **Landon Hennen** — `server.js` carries him as slug `landonhennen` with
  `findSlug: true`, a placeholder the site never resolved. The page it reaches
  (1 game, 3 AB) is not the 4 games the boxes credit him.

The game log keeps OUR per-game rows and OUR total — it has to add up to the
rows printed above it. When that total differs from the league's line, page 2
says so in a note rather than letting two numbers contradict each other in
silence.

### TCL ranks (batter cards)

A small gold number beside a stat is its rank in the Texas Collegiate League —
the same thing the website's player bio shows, from the same source. The ranks
are **Presto's own**, read off each player's league player page and cached by
`scripts/fetch-ranks.py` into `data/league-ranks.json`. Re-run that script when
the league updates; the cache is committed so a card render stays reproducible.

The line explaining the gold number sits at the **top right of the season strip**,
sharing a row with the "Season Totals" title, not in the key block at the foot —
the strip is where a reader meets his first gold number, so that is where the
explanation belongs. Sharing the title's row rather than taking one of its own is
also worth a little type: it bought the fullest batter card 0.65 → 0.67.

It appears only when the card has at least one rank, so pitcher cards and a
batter with none (Cooley, Guidry) carry the title alone.

Four rules decide whether a rank prints:

1. **Top 50 only.** Below that a rank is not a distinction, it is a headcount —
   Gabe Guidry's best is 58th, so his card carries none. The card does not say
   this: the line explaining the gold number names no cutoff, because a player
   has no use for the threshold and printing it invites him to read a missing
   rank as a placing just outside it. `RANK_TOP` still governs which ranks print.
2. **Never on a stat where placing high is bad.** `NO_RANK` in
   `player-season-data.py` holds them: **K**, **CS**, and GIDP/E against the day
   they get a Presto key. A hitter should not learn from his own card that he was
   6th in the league for striking out, or 4th at being thrown out stealing — the
   badge reads as a distinction when it is the opposite. The stats still print
   their number, and still take the league's figure like every other.

   Presto ranks all of them, so the refusal is ours and not a gap in the data.
   That is why they stay in `RANK_KEYS` and are turned away in `rank_of`: a stat
   simply missing from the map looks like an oversight and invites a "fix".
   This cost Landreneau his K 6th and Sunday his K 11th, which is the point.
3. **Only when the number on the card equals Presto's for that stat.** Since the
   league's line is now what the card prints, this normally holds by
   construction; it is the backstop for the cases that rule can't cover — a card
   whose scope isn't a TCL line (Matt Scott), a stat Presto doesn't publish, and
   a player it has no line for.
4. **Hitting only.** Presto publishes no pitching ranks at all — not for the
   league ERA leader, not for anyone. Pitcher cards carry none, and the website
   says the same in its own legend.

**Every tile in the season strip is a stat the TCL ranks**, so the strip reads as
a row of league placings rather than a row of numbers with one gap in it. OPS was
the exception — the one headline stat Presto publishes no rank for — and the
owner took it off the strip for exactly that reason. It still prints in
PRODUCTION, so nothing left the card. Before adding a tile, check it has a key in
`RANK_KEYS`; if it doesn't, it will sit there permanently blank.

Do **not** compute ranks from the league leaderboard. That was tried and thrown
out: the board pages out around 216 hitters, short of the league, and Presto
applies a minimum-AB qualifier to the rate stats that the raw board does not.
Landreneau's AVG rank came out 70th against Presto's 49th — small enough to look
right and be wrong.

**Two-way players carry no hitting ranks, and this is deliberate.** Presto's own
player page shows only the pitching "Overall" table for a two-way player, so
`fetch-ranks.py` gets a real hitting `line` back but an empty `ranks` — nothing
to compare against, not a top-50 miss. Confirmed on Jack Garcille, Bryson
Pierce, Matthew McKinley. `server.js` already has a fallback for exactly this
on the live site (`computeLeagueHitRanks`, off the raw hitting leaderboard) —
the owner was offered the same fallback for cards and declined it, on the same
leaderboard-accuracy grounds as the paragraph above. Don't port it without
asking again.

### wOBA and wRC+ (batter cards)

In PRODUCTION, after the slash line, where Baseball Savant puts them: the rate
stats that the slash line rolls up to, ahead of the derived and counting stats.
Both come from `scripts/runvalues.py`, which replays the league's own
play-by-play to derive TCL run values rather than borrowing MLB's. wRC+ is
indexed to TCL runs per plate appearance, so 100 is an average TCL hitter. **No
park factor** is applied — the league publishes none, and inventing one would be
worse than leaving it out. Say so if anyone asks why a card's wRC+ differs from a
site that parks-adjusts.

### Count splits (batter cards)

From `scripts/advanced.py`. The count bucket comes from the count Presto printed
for the plate appearance, never from reading the pitch letters, so it doesn't
depend on a scorer telling a swinging strike from a called one. **Whiff rate is
deliberately absent** — it would require trusting swing-and-miss entry, which the
owner does not.

**BATTED BALL is off the card by owner decision.** `advanced.py` still derives
pull/centre/oppo and still counts how many balls in play had no direction
recorded, so putting the strip back is a matter of emitting the rows again, not
rebuilding anything. If it ever returns, the `Located` cell goes with it: Presto
often writes "singled" with no direction, those are dropped rather than guessed,
and the count has to travel with the percentages so they can't be read as the
whole season.

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
