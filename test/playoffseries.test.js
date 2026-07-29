'use strict';
// Tests for the semifinal series plumbing: the stand-in schedule rows that hold
// a playoff game the league hasn't posted to the feed yet, and the series score
// derived from the games already final.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  manualPlayoffGame, withManualPlayoffGames, seriesStatus, pick,
  MANUAL_PLAYOFF_GAMES, SEMIFINAL_DATES, PLAYOFF_SERIES,
} = require('../server');

const GAT = 'et1bt9sixrz5lnnl'; // Gators
const ACA = 'cz8qei0rxijys6nm'; // Cane Cutters

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

test('the configured stand-in is Game 2 at Acadiana', () => {
  assert.equal(MANUAL_PLAYOFF_GAMES.length, 1);
  const [m] = MANUAL_PLAYOFF_GAMES;
  assert.equal(m.date, '20260729');
  assert.equal(m.awayId, GAT);
  assert.equal(m.homeId, ACA);
  // Game 3 is only played if the series goes the distance, so it never stands in.
  assert.ok(!MANUAL_PLAYOFF_GAMES.some(x => x.date === '20260730'));
});

test('withManualPlayoffGames appends the stand-in in date order', () => {
  const parsed = [final('20260728', true, 2, 1)];
  const merged = withManualPlayoffGames(parsed);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map(g => g.date), ['20260728', '20260729']);
  assert.equal(merged[1].state, 'scheduled');
});

test('a feed game on the same date wins over the stand-in', () => {
  const real = Object.assign(final('20260729', false, 0, 0), { state: 'scheduled', status: '7:05 PM CDT' });
  const merged = withManualPlayoffGames([final('20260728', true, 2, 1), real]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].id, real.id);
  assert.ok(!merged.some(g => /_tbd$/.test(g.id)));
});

test('pick features the stand-in once Game 1 is out of its sticky window', () => {
  const games = withManualPlayoffGames([final('20260728', true, 2, 1)]);
  // Two days after Game 1 ended, the fresh-final window is long gone.
  const chosen = pick(games, Date.UTC(2026, 6, 30, 18));
  assert.equal(chosen.date, '20260729');
  assert.equal(chosen.state, 'scheduled');
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
