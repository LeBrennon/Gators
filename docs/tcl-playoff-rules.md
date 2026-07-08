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

## Data the app would need to apply these

The live standings feed (`parseStandings` in `server.js`) currently provides W / L / T
and streak only. Resolving the tie-breakers above additionally requires:

- **Run differential** (season, and within H2H games) — not currently aggregated.
- **Head-to-head records** between the tied teams — not currently aggregated.
- **The last regulation game** result between two tied teams (for the 2-team step 6).

Finished-game box scores are already fetched (`fetchBoxPage`), so run totals and H2H
results are derivable from game data if/when a live playoff-race view is built.
