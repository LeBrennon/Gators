'use strict';
// Tests for the semifinal series plumbing: the stand-in schedule rows that hold
// a playoff game the league hasn't posted to the feed yet, and the series score
// derived from the games already final.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  manualPlayoffGame, withManualPlayoffGames, seriesStatus, matchupSeries, pick, buildPlayoffPicture,
  MANUAL_PLAYOFF_GAMES, SEMIFINAL_DATES, PLAYOFF_SERIES, PLAYOFF_FIELD, REGULAR_SEASON_OVER, inPlayoffField,
  withFeaturedResult, semifinalLogRows, withSemifinalLog, finalistOf, eliminatedOf, playoffInfo,
  SEMIFINAL_WON_NOTE, SEMIFINAL_LOST_NOTE,
} = require('../server');

const GAT = 'et1bt9sixrz5lnnl'; // Gators
const ACA = 'cz8qei0rxijys6nm'; // Cane Cutters
const VIC = 'jm9r4btii24hhtfp'; // Generals
const BOM = 'z7w5th537gur3z15'; // Bombers
const SAN = 'do9ibktaduhyld7f'; // River Monsters

// A finished Gators game shaped like a parseSchedule() row.
function final(date, gatorsHome, gatorsRuns, oppRuns) {
  const gators = { id: GAT, name: 'Lake Charles Gumbeaux Gators', short: 'Gators', logo: '/gators-logo.png', score: gatorsRuns };
  const opp = { id: ACA, name: 'Acadiana Cane Cutters', short: 'Cane Cutters', logo: 'x.png', score: oppRuns };
  return { id: date + '_x47y', date, dateLabel: 'D', sortKey: +date, state: 'final', status: 'Final',
    gatorsHome, opponent: { name: opp.name, short: opp.short, logo: opp.logo },
    away: gatorsHome ? opp : gators, home: gatorsHome ? gators : opp };
}

test('every semifinal date carries a playoff series tag', () => {
  for (const d of SEMIFINAL_DATES) assert.ok(PLAYOFF_SERIES[d], 'missing tag for ' + d);
  assert.match(PLAYOFF_SERIES['20260728'].tag, /Game 1/);
  assert.match(PLAYOFF_SERIES['20260729'].tag, /Game 2/);
  assert.match(PLAYOFF_SERIES['20260730'].tag, /Game 3/);
});

test('manualPlayoffGame builds a scheduled away game at 7:05', () => {
  const g = manualPlayoffGame({ date: '20260729', awayId: GAT, homeId: ACA });
  assert.equal(g.date, '20260729');
  assert.equal(g.state, 'scheduled');
  assert.equal(g.status, '7:05 PM CDT');
  assert.equal(g.gatorsHome, false);
  assert.equal(g.opponent.short, 'Cane Cutters');
  assert.equal(g.away.id, GAT);
  assert.equal(g.home.id, ACA);
  assert.equal(g.sortKey, 20260729);
  assert.match(g.id, /^20260729_/);
});

test('the configured stand-in is the championship at Victoria', () => {
  assert.equal(MANUAL_PLAYOFF_GAMES.length, 1);
  const [m] = MANUAL_PLAYOFF_GAMES;
  assert.equal(m.date, '20260801');
  assert.equal(m.awayId, GAT);
  assert.equal(m.homeId, VIC);   // 31-19 to the Gators' 29-19, so Victoria hosts
  // Semifinal Game 3 never stands in — it's only played if the series goes the
  // distance, and the Gators' swept it away.
  assert.ok(!MANUAL_PLAYOFF_GAMES.some(x => x.date === '20260730'));
  // Game 2's stand-in is retired: the feed carries that game now.
  assert.ok(!MANUAL_PLAYOFF_GAMES.some(x => x.date === '20260729'));
});

// The mechanism, driven by an explicit list so these don't churn every time the
// configured stand-in above moves on to the next unposted game.
const G2 = [{ date: '20260729', awayId: GAT, homeId: ACA }];

test('withManualPlayoffGames appends the stand-in in date order', () => {
  const parsed = [final('20260728', true, 2, 1)];
  const merged = withManualPlayoffGames(parsed, G2);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(g => g.date), ['20260728', '20260729']);
  assert.equal(merged[1].state, 'scheduled');
});

test('a feed game on the same date wins over the stand-in', () => {
  const real = Object.assign(final('20260729', false, 0, 0), { state: 'scheduled', status: '7:05 PM CDT' });
  const merged = withManualPlayoffGames([final('20260728', true, 2, 1), real], G2);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].id, real.id);
  assert.ok(!merged.some(g => /_tbd$/.test(g.id)));
});

test('pick features the stand-in once Game 1 is out of its sticky window', () => {
  const games = withManualPlayoffGames([final('20260728', true, 2, 1)], G2);
  // Two days after Game 1 ended, the fresh-final window is long gone.
  const chosen = pick(games, Date.UTC(2026, 6, 30, 18));
  assert.equal(chosen.date, '20260729');
  assert.equal(chosen.state, 'scheduled');
});

test('the championship stand-in becomes the featured game once the semifinal is done', () => {
  // Friday, with the sweep two days behind us and nothing else on the schedule.
  const games = withManualPlayoffGames([final('20260728', true, 2, 1), final('20260729', false, 3, 1)]);
  const chosen = pick(games, Date.UTC(2026, 6, 31, 18));
  assert.equal(chosen.date, '20260801');
  assert.equal(chosen.state, 'scheduled');
  assert.equal(chosen.gatorsHome, false);        // at Victoria
  assert.equal(chosen.opponent.short, 'Generals');
});

test('seriesStatus reports the lead and each game played', () => {
  const s = seriesStatus(withManualPlayoffGames([final('20260728', true, 2, 1)]));
  assert.equal(s.w, 1);
  assert.equal(s.l, 0);
  assert.equal(s.label, 'Gators lead the series 1–0');
  assert.deepEqual(s.results.map(r => r.text), ['G1 W 2–1']);
  assert.equal(s.results[0].game, 1);
});

test('seriesStatus handles a split, a clincher and a series loss', () => {
  const tied = seriesStatus([final('20260728', true, 2, 1), final('20260729', false, 3, 8)]);
  assert.equal(tied.label, 'Series tied 1–1');
  assert.deepEqual(tied.results.map(r => r.text), ['G1 W 2–1', 'G2 L 3–8']);

  const won = seriesStatus([final('20260728', true, 2, 1), final('20260729', false, 6, 5)]);
  assert.equal(won.label, 'Gators win the series 2–0');

  const lost = seriesStatus([final('20260728', true, 1, 4), final('20260729', false, 2, 3)]);
  assert.equal(lost.label, 'Cane Cutters win the series 2–0');
});

test('seriesStatus ignores regular-season games and unplayed dates', () => {
  assert.equal(seriesStatus([final('20260726', true, 9, 1)]), null);
  assert.equal(seriesStatus(withManualPlayoffGames([])), null);
});

// ---- announced playoff field + per-matchup series ---------------------------

// A parseLeagueResults() row.
function logGame(date, awayId, awayScore, homeId, homeScore) {
  return { id: date + '_x', date, regulation: true,
    away: { id: awayId, score: awayScore }, home: { id: homeId, score: homeScore } };
}
// A standings row as /api/standings enriches it before seeding.
function stRow(id, name, short) { return { id, name, short, logo: null, site: null }; }

test('the announced field is the four teams the league named, in seed order', () => {
  assert.ok(REGULAR_SEASON_OVER);
  assert.deepEqual(PLAYOFF_FIELD.map(x => x.id), [VIC, ACA, GAT, BOM]);
  // San Antonio finished ahead of Brazos Valley in the derived second-half race
  // but did not make the league's bracket — the announced field is the truth.
  assert.equal(inPlayoffField(SAN), false);
  assert.equal(inPlayoffField(BOM), true);
  assert.equal(inPlayoffField(GAT), true);
});

test('buildPlayoffPicture seeds straight off an announced field', () => {
  const ranked = [stRow(SAN, 'San Antonio River Monsters', 'River Monsters'), stRow(GAT, 'Lake Charles Gumbeaux Gators', 'Gators'),
    stRow(BOM, 'Brazos Valley Bombers', 'Bombers'), stRow(VIC, 'Victoria Generals', 'Generals'),
    stRow(ACA, 'Acadiana Cane Cutters', 'Cane Cutters')];
  const p = buildPlayoffPicture(ranked, null, PLAYOFF_FIELD);
  assert.deepEqual(p.seeds.map(s => s.team.id), [VIC, ACA, GAT, BOM]);
  assert.deepEqual(p.matchups, [[1, 4], [2, 3]]);
  assert.equal(p.seeds[2].note, 'Second-half champion');
  assert.ok(!p.seeds.some(s => s.team.id === SAN));
  // Omitting the field keeps the derived picture (still used mid-season).
  const derived = buildPlayoffPicture(ranked.map(x => Object.assign({ clinched: null, pctSeason: 0, ws: 0, ls: 0 }, x)), null);
  assert.ok(derived.seeds.length === 4);
});

test('matchupSeries reads the other semifinal off the league log', () => {
  const log = [logGame('20260726', VIC, 3, BOM, 2), logGame('20260728', VIC, 8, BOM, 4)];
  const s = matchupSeries(log, VIC, BOM);
  // Only the semifinal dates count — the 7/26 regular-season meeting is ignored.
  assert.deepEqual(s.results.map(r => r.text), ['G1 Generals 8–4']);
  assert.equal(s.wins[VIC], 1);
  assert.equal(s.wins[BOM], 0);
  assert.equal(s.leaderId, VIC);
  assert.equal(s.label, 'Generals lead the series 1–0');
});

test('matchupSeries credits each game to its winner and calls the clincher', () => {
  const split = matchupSeries([logGame('20260728', VIC, 8, BOM, 4), logGame('20260729', BOM, 1, VIC, 5)], VIC, BOM);
  assert.equal(split.label, 'Generals win the series 2–0');
  assert.deepEqual(split.results.map(r => r.text), ['G1 Generals 8–4', 'G2 Generals 5–1']);

  const tied = matchupSeries([logGame('20260728', VIC, 8, BOM, 4), logGame('20260729', BOM, 7, VIC, 2)], VIC, BOM);
  assert.equal(tied.label, 'Series tied 1–1');
  assert.deepEqual(tied.results.map(r => r.text), ['G1 Generals 8–4', 'G2 Bombers 7–2']);
});

test('matchupSeries ignores games that are not this matchup', () => {
  assert.equal(matchupSeries([logGame('20260728', ACA, 1, GAT, 2)], VIC, BOM), null);
  assert.equal(matchupSeries([], VIC, BOM), null);
});

// ---- the schedule page lags the last out ------------------------------------
// Presto left Game 2 listed "live" with no score for hours after it ended, while
// the per-game live feed already had it final. Everything below is what keeps
// the series score from reading a game behind because of that.

// The 7/29 schedule row exactly as the feed served it after the game ended.
function stillLive(date) {
  const gators = { id: GAT, name: 'Lake Charles Gumbeaux Gators', short: 'Gators', logo: '/gators-logo.png', score: null };
  const opp = { id: ACA, name: 'Acadiana Cane Cutters', short: 'Cane Cutters', logo: 'x.png', score: null };
  return { id: date + '_ua2w', date, dateLabel: 'D', sortKey: +date, state: 'live', status: 'Bottom of 9th',
    gatorsHome: false, opponent: { name: opp.name, short: opp.short, logo: opp.logo }, away: gators, home: opp };
}
// The same game as the hero saw it: final off the live feed.
function feat(id, date, gatorsRuns, oppRuns) {
  return { id, date, status: 'final', inningLabel: 'Final',
    away: { runs: gatorsRuns }, home: { runs: oppRuns } };
}

test('withFeaturedResult folds the live-feed final into a copy of the schedule', () => {
  const live = stillLive('20260729');
  const sched = [final('20260728', true, 2, 1), live];
  const out = withFeaturedResult(sched, feat(live.id, '20260729', 3, 1));
  assert.equal(out[1].state, 'final');
  assert.equal(out[1].status, 'Final');
  assert.equal(out[1].away.score, 3);
  assert.equal(out[1].home.score, 1);
  // Game 1 is untouched, and the cached schedule itself never changes.
  assert.equal(out[0], sched[0]);
  assert.equal(live.state, 'live');
  assert.equal(live.away.score, null);
});

test('withFeaturedResult leaves the schedule alone when there is nothing to add', () => {
  const sched = [final('20260728', true, 2, 1), stillLive('20260729')];
  assert.equal(withFeaturedResult(sched, null), sched);
  // A live (not yet final) hero doesn't get to bank a result.
  assert.equal(withFeaturedResult(sched, { id: sched[1].id, status: 'live', away: { runs: 3 }, home: { runs: 1 } }), sched);
  // Nor does a final with no runs on it.
  assert.equal(withFeaturedResult(sched, { id: sched[1].id, status: 'final', away: {}, home: {} }), sched);
  // A game the schedule already has final keeps the schedule's own score.
  const done = withFeaturedResult([final('20260728', true, 2, 1)], feat('20260728_x47y', '20260728', 9, 9));
  assert.equal(done[0].home.score, 2);
});

test('the clincher counts the moment the feed calls it, not when the schedule does', () => {
  const live = stillLive('20260729');
  const sched = [final('20260728', true, 2, 1), live];
  // Straight off the schedule the series still reads a game behind.
  assert.equal(seriesStatus(sched).label, 'Gators lead the series 1–0');
  const s = seriesStatus(withFeaturedResult(sched, feat(live.id, '20260729', 3, 1)));
  assert.equal(s.w, 2);
  assert.equal(s.l, 0);
  assert.equal(s.label, 'Gators win the series 2–0');
  assert.deepEqual(s.results.map(r => r.text), ['G1 W 2–1', 'G2 W 3–1']);
});

test('semifinalLogRows rebuilds league-log rows from the Gators schedule', () => {
  const rows = semifinalLogRows([final('20260726', true, 9, 1), final('20260728', true, 2, 1), stillLive('20260729')]);
  // Regular-season and not-yet-final games are skipped.
  assert.deepEqual(rows.map(r => r.date), ['20260728']);
  assert.deepEqual(rows[0].away, { id: ACA, score: 1 });
  assert.deepEqual(rows[0].home, { id: GAT, score: 2 });
});

test('withSemifinalLog tops up the league log without duplicating what it has', () => {
  const live = stillLive('20260729');
  const sched = withFeaturedResult([final('20260728', true, 2, 1), live], feat(live.id, '20260729', 3, 1));
  // The league page has Game 1 and the other semifinal, but not the Gators' G2.
  const log = [logGame('20260728', ACA, 1, GAT, 2), logGame('20260729', BOM, 5, VIC, 0)];
  const merged = withSemifinalLog(log, sched);
  assert.equal(merged.length, 3);
  const s = matchupSeries(merged, ACA, GAT);
  assert.equal(s.label, 'Gators win the series 2–0');
  assert.deepEqual(s.results.map(r => r.text), ['G1 Gators 2–1', 'G2 Gators 3–1']);
  // The other semifinal still reads off the league log alone.
  assert.equal(matchupSeries(merged, VIC, BOM).label, 'Bombers lead the series 1–0');
  // Nothing to add once the league page catches up.
  assert.equal(withSemifinalLog(merged, sched).length, 3);
});

// ---- advancing to the championship ------------------------------------------

test('playoffInfo retires the "if needed" note once the series is decided', () => {
  const alive = { w: 1, l: 0 };
  assert.equal(playoffInfo('20260729', alive), PLAYOFF_SERIES['20260729']);
  assert.equal(playoffInfo('20260729', null), PLAYOFF_SERIES['20260729']);
  assert.match(PLAYOFF_SERIES['20260729'].note, /if needed/);

  const won = playoffInfo('20260729', { w: 2, l: 0 });
  assert.equal(won.tag, PLAYOFF_SERIES['20260729'].tag);   // still Game 2
  assert.equal(won.note, SEMIFINAL_WON_NOTE);
  assert.doesNotMatch(won.note, /if needed/);
  assert.equal(playoffInfo('20260729', { w: 1, l: 2 }).note, SEMIFINAL_LOST_NOTE);
  // Dates with no playoff block stay null either way.
  assert.equal(playoffInfo('20260726', { w: 2, l: 0 }), null);
});

test('the swap is only for semifinal dates — the championship keeps its own block', () => {
  // Only a semifinal date's note is about the semifinal. Without the date guard
  // a decided series would put "Gators advance to the TCL Championship" on the
  // championship game itself.
  const champ = playoffInfo('20260801', { w: 2, l: 0 });
  assert.equal(champ, PLAYOFF_SERIES['20260801']);
  assert.notEqual(champ.note, SEMIFINAL_WON_NOTE);
  // The championship carries no note at all — the hero's location line already
  // says where it's played — so the swap has nothing to overwrite.
  assert.equal(champ.note, null);
  assert.match(champ.tag, /Championship/);
});

// A seeded bracket slot as buildPlayoffPicture emits it.
function slot(seed, id, short) { return { seed, team: { id, name: short, short }, note: 'n' }; }

test('finalistOf names the team that banked two wins', () => {
  const gat = slot(3, GAT, 'Gators'), aca = slot(2, ACA, 'Cane Cutters');
  const swept = matchupSeries([logGame('20260728', ACA, 1, GAT, 2), logGame('20260729', GAT, 3, ACA, 1)], ACA, GAT);
  const f = finalistOf(swept, aca, gat);
  assert.equal(f.team.id, GAT);
  assert.equal(f.seed, 3);
  assert.equal(f.note, 'Beat Cane Cutters 2–0');
  assert.equal(f.clinched, true);
});

test('eliminatedOf names the team a decided series knocks out', () => {
  const swept = matchupSeries([logGame('20260728', ACA, 1, GAT, 2), logGame('20260729', GAT, 3, ACA, 1)], ACA, GAT);
  const out = eliminatedOf(swept);
  assert.equal(out.id, ACA);
  assert.equal(out.winnerId, GAT);
  assert.equal(out.reason, 'Eliminated in the semifinals — lost to Gators 2–0');
  // A series that went the distance reports the real margin.
  const three = matchupSeries([logGame('20260728', VIC, 8, BOM, 4), logGame('20260729', BOM, 5, VIC, 0),
    logGame('20260730', BOM, 2, VIC, 6)], VIC, BOM);
  assert.equal(three.label, 'Generals win the series 2–1');
  assert.equal(eliminatedOf(three).reason, 'Eliminated in the semifinals — lost to Generals 2–1');
});

test('eliminatedOf stays null while the series is still alive', () => {
  const tied = matchupSeries([logGame('20260728', VIC, 8, BOM, 4), logGame('20260729', BOM, 5, VIC, 0)], VIC, BOM);
  assert.equal(eliminatedOf(tied), null);
  assert.equal(eliminatedOf(matchupSeries([logGame('20260728', VIC, 8, BOM, 4)], VIC, BOM)), null);
  assert.equal(eliminatedOf(null), null);
});

test('finalistOf stays null while the series is still alive', () => {
  const vic = slot(1, VIC, 'Generals'), bom = slot(4, BOM, 'Bombers');
  const tied = matchupSeries([logGame('20260728', VIC, 8, BOM, 4), logGame('20260729', BOM, 5, VIC, 0)], VIC, BOM);
  assert.equal(tied.label, 'Series tied 1–1');
  assert.equal(finalistOf(tied, vic, bom), null);
  const lead = matchupSeries([logGame('20260728', VIC, 8, BOM, 4)], VIC, BOM);
  assert.equal(finalistOf(lead, vic, bom), null);
  assert.equal(finalistOf(null, vic, bom), null);
  // A decided series still needs both slots seeded to name anyone.
  const done = matchupSeries([logGame('20260728', VIC, 8, BOM, 4), logGame('20260729', BOM, 1, VIC, 5)], VIC, BOM);
  assert.equal(finalistOf(done, vic, null), null);
  assert.equal(finalistOf(done, vic, bom).team.id, VIC);
});
