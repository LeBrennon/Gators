# TCL Playoff Seeding & Tie-Breaker Rules

Official Texas Collegiate League (TCL) rules for playoff qualification, seeding, and
tie-breakers. Source: **Jared**, the TCL's rules & stats authority, relayed 2026-07-08.

These are recorded verbatim so the end-of-season playoff picture (and any tie-break)
can be resolved quickly rather than re-litigated. Where Jared flagged his own
uncertainty ("And then from there, I believe it goes…"), that caveat is preserved —
confirm the tie-breaker order with him before it decides a real seed.

## Playoff qualification & seeding

The TCL regular season is split into two halves (see `SEASON_HALF` / `FIRST_HALF_FINAL`
in `server.js`). Four teams make the playoffs.

- The two **half champions** clinch playoff berths (already modeled in the app as the
  `x-` clinch tag). They take the **1 and 2 seeds**.
- The **top 2 teams of the 2nd half** receive the **3 and 4 seed**.
- **Overlap rule.** If one team qualifies by virtue of *both* the first-half and
  second-half standings, it is seeded based off its **first-half finish**. The team
  with the **next best record for the entire regular season** among teams that did not
  otherwise qualify then qualifies for the playoffs as the **4th seed** (or as the 3rd
  *and* 4th seed if both the first-half and second-half teams are the same).

## Series format & hosting

Source: **Jared**, confirmed 2026-07-09.

Each playoff round is a **best-of-3 series** (first to two wins advances). The
matchups are **1 vs 4** and **2 vs 3**. Hosting is split within the series:

- The **lower seed hosts Game 1**.
- The **higher seed hosts Games 2 and 3** (Game 3 only if needed).

"Higher seed" here means the **better team** (the smaller seed number), so the 1 and 2
seeds are the *away* team in Game 1 and host any remaining games. This mirrors the note
already shown on the Playoff Picture card in `server.js`.

## Tie-breakers

> Jared's recollection, prefaced "I believe it goes." Confirm before applying to a
> live seeding decision.

### If 2 teams are tied

1. Games back
2. Win percentage
3. Head-to-head (H2H)
4. Run differential
5. Run differential in H2H games
6. Whoever won the last regulation game between the 2 teams

### If 3+ teams are tied

1. H2H for all teams involved
2. Run differential
3. Run differential in H2H games for all teams involved

## How the app applies these

The live playoff race is computed in `server.js` and served by `GET /api/standings`
(rendered on the **Standings** tab). The standings feed only carries W / L / T +
streak, so the run-differential and head-to-head inputs are reconstructed from the
league schedule page:

- **`parseLeagueResults(html)`** — every decided game on the schedule (all eight teams,
  all dates) as `{ date, regulation, away:{id,score}, home:{id,score} }`. Forfeits are
  real W/L but not "regulation" games, so they're excluded from the last-regulation-game
  step.
- **`computeLeagueMetrics(log)`** — per-team season run differential, pairwise
  head-to-head (record + runs), and the latest regulation meeting between each pair.
- **`cmpTwoTeam` / `rankTiedGroup` / `rankSecondHalf`** — the 2-team and 3+-team
  tie-break chains above, used to fully order the second-half standings; the applied
  tie-breaks are surfaced as plain-language footnotes.
- **`buildPlayoffPicture(ranked, metrics)`** — the four-team bracket, including the
  both-halves overlap rule (a team that places top-2 in both halves keeps its first-half
  seed; the vacated second-half berth passes to the best remaining full-season record).

Season run differential shows as a **DIFF** column on the standings table; the playoff
picture shows each seed's reason and any overlap note. Tests live in
`test/playoffs.test.js`.

## Mathematical elimination

`computeElimination(rows, remaining)` marks a non-champion team **Out** on the
Standings tab once it's provably dead for both ways into a berth:

- **Door A** — finish top-2 of the second half outright. Closed for a team once at
  least 2 *other* teams are guaranteed a higher second-half win total than that team
  could reach even by winning out (a standard ceiling/floor check).
- **Door B** — the overlap rule above: a first-half champion finishes top-2 of the
  second half anyway (it doesn't need the berth) and hands the now-redundant slot to
  the best remaining full-season record. This door only exists while a champion can
  still reach a literal top-2 second-half finish, so it's permanently shut the moment
  **both** champions are themselves shut out of door A.

A team is only shown **Out** once both doors are shut. This is deliberately
conservative: while either champion could still land in the second-half top 2, no
team is marked out, even one that's already effectively hopeless — a false "Out"
would be worse than a late one. `remainingGamesByTeam(html)` supplies each team's
games-left count (every not-yet-decided game on the schedule page, since the whole
season is past its first half by the time `SEASON_HALF` is 2).
