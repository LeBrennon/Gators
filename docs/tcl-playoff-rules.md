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
