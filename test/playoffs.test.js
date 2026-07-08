'use strict';
// Tests for the playoff-race engine: league game-log parsing, run differential /
// head-to-head metrics, Jared's 2- and 3+-team tie-breakers, and the four-team
// seeding with the both-halves overlap rule. See docs/tcl-playoff-rules.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseLeagueResults, computeLeagueMetrics, cmpTwoTeam, rankSecondHalf, buildPlayoffPicture,
} = require('../server');

// Real Presto team ids (must match server.js TEAMS).
const GAT = 'et1bt9sixrz5lnnl'; // Gators
const ACA = 'cz8qei0rxijys6nm'; // Cane Cutters (1H clinch)
const ROU = 'z10kgms3gvy1eszs'; // Rougarou
const BIS = 'ij0lwtvjsx2mi1nh'; // Flying Bison
const BOM = 'z7w5th537gur3z15'; // Bombers
const VIC = 'jm9r4btii24hhtfp'; // Generals (1H clinch)

// Build one schedule-page game row: away logo, away score, home logo, home score,
// a status word, then the box-score link — the same shape parseLeagueResults reads.
let _g = 0;
function game(date, away, aScore, home, hScore, status) {
  const gid = 'g' + (++_g);
  return '<tr>'
    + '<td><img src="/logos/id/' + away + '.png" alt="away team logo"></td>'
    + '<td><span>' + aScore + '</span></td>'
    + '<td><img src="/logos/id/' + home + '.png" alt="home team logo"></td>'
    + '<td><span>' + hScore + '</span></td>'
    + '<td><span>' + (status || 'Final') + '</span></td>'
    + '<td><a href="/sports/bsb/2026/boxscores/' + date + '_' + gid + '.xml">Box</a></td>'
    + '</tr>';
}

test('parseLeagueResults reads decided games and skips forfeits as non-regulation', () => {
  const html = '<table>'
    + game('20260601', GAT, 7, BOM, 3, 'Final')
    + game('20260602', ROU, 2, GAT, 5, 'Final')
    + game('20260603', BIS, 9, ACA, 1, 'Forfeit')
    + game('20260604', VIC, 4, BOM, 4, '7:00 PM')   // scheduled (no Final) -> skipped
    + '</table>';
  const log = parseLeagueResults(html);
  assert.equal(log.length, 3, 'three decided games (scheduled row skipped)');
  const g1 = log.find(g => g.id.startsWith('20260601'));
  assert.deepEqual(g1.away, { id: GAT, score: 7 });
  assert.deepEqual(g1.home, { id: BOM, score: 3 });
  assert.equal(g1.regulation, true);
  const ff = log.find(g => g.id.startsWith('20260603'));
  assert.equal(ff.regulation, false, 'forfeit is not a regulation game');
});

test('computeLeagueMetrics rolls up run diff, head-to-head, and last regulation game', () => {
  const html = '<table>'
    + game('20260601', GAT, 7, BOM, 3, 'Final')   // GAT +4
    + game('20260602', BOM, 6, GAT, 1, 'Final')   // GAT -5 (BOM wins)
    + game('20260610', GAT, 2, BOM, 0, 'Final')   // GAT +2, latest meeting
    + '</table>';
  const m = computeLeagueMetrics(parseLeagueResults(html));
  // Season run diff: GAT scored 7+1+2=10, allowed 3+6+0=9 => +1; BOM the inverse => -1.
  assert.equal(m.rd[GAT].rs - m.rd[GAT].ra, 1);
  assert.equal(m.rd[BOM].rs - m.rd[BOM].ra, -1);
  // Head-to-head: GAT 2-1 vs BOM.
  assert.equal(m.h2h[GAT][BOM].w, 2);
  assert.equal(m.h2h[GAT][BOM].l, 1);
  // Latest regulation meeting (6/10) was a GAT win.
  assert.equal(m.lastReg[GAT][BOM].date, '20260610');
  assert.equal(m.lastReg[GAT][BOM].winnerId, GAT);
});

// Minimal standings row for the ranking/seeding functions.
function row(id, w2, l2, extra) {
  const g = w2 + l2;
  return Object.assign({ id, name: id, short: id, logo: null, w2, l2, pct: g ? w2 / g : 0,
    ws: w2, ls: l2, pctSeason: g ? w2 / g : 0, diff: 0, clinched: null }, extra || {});
}
function metricsWith(h2h, rd) {
  return { rd: rd || {}, h2h: h2h || {}, lastReg: {} };
}

test('cmpTwoTeam walks the 2-team chain: H2H, then run diff, then H2H run diff', () => {
  const a = row(GAT, 6, 4), b = row(BOM, 6, 4);   // level on games back + win%
  // 3. head-to-head decides.
  let r = cmpTwoTeam(a, b, metricsWith({ [GAT]: { [BOM]: { w: 2, l: 1, rs: 0, ra: 0 } } }));
  assert.ok(r.d < 0 && r.by === 'head-to-head', 'more H2H wins ranks ahead');
  // H2H even -> 4. run differential.
  r = cmpTwoTeam(a, b, metricsWith(
    { [GAT]: { [BOM]: { w: 1, l: 1, rs: 5, ra: 5 } }, [BOM]: { [GAT]: { w: 1, l: 1, rs: 5, ra: 5 } } },
    { [GAT]: { rs: 20, ra: 5 }, [BOM]: { rs: 10, ra: 8 } }));
  assert.ok(r.d < 0 && r.by === 'run differential', 'better season run diff ranks ahead');
  // Run diff even -> 5. run diff in H2H games.
  r = cmpTwoTeam(a, b, metricsWith(
    { [GAT]: { [BOM]: { w: 1, l: 1, rs: 9, ra: 4 } }, [BOM]: { [GAT]: { w: 1, l: 1, rs: 4, ra: 9 } } },
    { [GAT]: { rs: 10, ra: 5 }, [BOM]: { rs: 10, ra: 5 } }));
  assert.ok(r.d < 0 && r.by === 'run differential (H2H)', 'better H2H run diff ranks ahead');
});

test('rankSecondHalf resolves a 3-team tie by head-to-head among the tied teams', () => {
  // Three teams level at 6-4. Among themselves: GAT 2-0, BOM 1-1, ROU 0-2.
  const rows = [row(BOM, 6, 4), row(ROU, 6, 4), row(GAT, 6, 4), row(BIS, 4, 6)];
  const h2h = {
    [GAT]: { [BOM]: { w: 1, l: 0, rs: 5, ra: 2 }, [ROU]: { w: 1, l: 0, rs: 4, ra: 1 } },
    [BOM]: { [GAT]: { w: 0, l: 1, rs: 2, ra: 5 }, [ROU]: { w: 1, l: 0, rs: 3, ra: 2 } },
    [ROU]: { [GAT]: { w: 0, l: 1, rs: 1, ra: 4 }, [BOM]: { w: 0, l: 1, rs: 2, ra: 3 } },
  };
  const out = rankSecondHalf(rows, metricsWith(h2h));
  assert.deepEqual(out.rows.map(r => r.id), [GAT, BOM, ROU, BIS]);
  assert.ok(out.tiebreaks.length >= 1 && /head-to-head/.test(out.tiebreaks[0]));
});

test('buildPlayoffPicture applies the both-halves overlap rule', () => {
  // Seeds 1-2: first-half qualifiers Victoria & Acadiana (clinched).
  // Victoria is ALSO the second-half leader -> it keeps its first-half seed, and
  // the vacated second-half berth must go to the best FULL-SEASON record among
  // the not-yet-qualified teams (GAT here), NOT the third-best second-half team.
  const ranked = [
    row(VIC, 9, 1, { clinched: '1st-half champion' }),                 // 2H #1 (overlap)
    row(ROU, 8, 2),                                                    // 2H #2 -> seed 3
    row(BOM, 7, 3, { ws: 7, ls: 3, pctSeason: 0.700 }),               // 2H #3, weaker full season
    row(GAT, 6, 4, { ws: 20, ls: 4, pctSeason: 0.833 }),               // best full season -> seed 4
    row(ACA, 3, 7, { clinched: '1st-half champion' }),
    row(BIS, 2, 8),
  ];
  const p = buildPlayoffPicture(ranked, metricsWith());
  const bySeed = {}; p.seeds.forEach(s => { bySeed[s.seed] = s; });
  assert.equal(bySeed[1].team.id, VIC, 'seed 1 = better first-half record');
  assert.equal(bySeed[2].team.id, ACA, 'seed 2 = other first-half qualifier');
  assert.equal(bySeed[3].team.id, ROU, 'seed 3 = genuine second-half qualifier');
  assert.equal(bySeed[4].team.id, GAT, 'seed 4 = best remaining full-season record, not 2H #3');
  assert.match(bySeed[4].note, /full-season/i);
  assert.ok(p.notes.some(n => /both halves/i.test(n)), 'explains the overlap');
});
