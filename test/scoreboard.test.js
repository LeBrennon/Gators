'use strict';
// Tests for parseLeagueScoreboard(): scraping the same schedule HTML into a
// league-wide, single-day scoreboard (no Gators-only filter), with scores,
// status, and live-before-final-before-scheduled ordering (Gators first).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLeagueScoreboard, applyLiveScores, liveScoreCache } = require('../server');

const GATORS = 'et1bt9sixrz5lnnl';
const CANE   = 'cz8qei0rxijys6nm';
const ABILENE= 'ij0lwtvjsx2mi1nh';
const ROUGAROU = 'z10kgms3gvy1eszs';
const BOMBERS  = 'z7w5th537gur3z15';

function row(date, key, away, awayName, awayScore, home, homeName, homeScore, status) {
  return `
    <div class="game">
      <img src="https://cdn/logos/id/${away}.png" alt="${awayName} team logo">
      <span class="score">${awayScore}</span>
      <img src="https://cdn/logos/id/${home}.png" alt="${homeName} team logo">
      <span class="score">${homeScore}</span>
      <span class="status">${status}</span>
      <a href="/sports/bsb/2026/boxscores/${date}_${key}.xml">Box</a>
    </div>`;
}

const HTML = `<html><body>
  ${row('20260621', 'cccc', CANE, 'Acadiana Cane Cutters', 3, GATORS, 'Lake Charles Gumbeaux Gators', 5, 'Final')}
  ${row('20260620', 'aaaa', GATORS, 'Lake Charles Gumbeaux Gators', 2, ABILENE, 'Abilene Flying Bison', 1, 'Top 4')}
  ${row('20260621', 'zzzz', ROUGAROU, 'Baton Rouge Rougarou', 7, BOMBERS, 'Brazos Valley Bombers', 4, 'Final')}
</body></html>`;

test('parseLeagueScoreboard: returns every game on the given day (not just Gators)', () => {
  const sb = parseLeagueScoreboard(HTML, '20260621');
  assert.equal(sb.length, 2);
  assert.deepEqual(sb.map(g => g.id).sort(), ['20260621_cccc', '20260621_zzzz']);
});

test('parseLeagueScoreboard: filters by date', () => {
  const sb = parseLeagueScoreboard(HTML, '20260620');
  assert.equal(sb.length, 1);
  assert.equal(sb[0].id, '20260620_aaaa');
  assert.equal(sb[0].state, 'live');
});

test('parseLeagueScoreboard: carries scores and flags the Gators game', () => {
  const g = parseLeagueScoreboard(HTML, '20260621').find(x => x.id === '20260621_cccc');
  assert.equal(g.isGators, true);
  assert.equal(g.state, 'final');
  assert.equal(g.away.score, 3);
  assert.equal(g.home.score, 5);
  assert.equal(g.home.id, GATORS);
  const other = parseLeagueScoreboard(HTML, '20260621').find(x => x.id === '20260621_zzzz');
  assert.equal(other.isGators, false);
});

test('parseLeagueScoreboard: Gators game sorts first within the day', () => {
  const sb = parseLeagueScoreboard(HTML, '20260621');
  assert.equal(sb[0].isGators, true);
});

test('parseLeagueScoreboard: no games on an empty day', () => {
  assert.deepEqual(parseLeagueScoreboard(HTML, '20260101'), []);
});

test('parseLeagueScoreboard: no date filter returns every game across all dates', () => {
  // Standings "Cancellations" column counts cancelled games league-wide, which
  // relies on passing a falsy date to get every game, not just one day.
  const all = parseLeagueScoreboard(HTML, '');
  assert.equal(all.length, 3);
  assert.deepEqual(all.map(g => g.id).sort(), ['20260620_aaaa', '20260621_cccc', '20260621_zzzz']);
});

test('parseLeagueScoreboard: a cancelled game is flagged so it can be counted', () => {
  const CANC = `<html><body>${row('20260623', 'xxxx', CANE, 'Acadiana Cane Cutters', 0, GATORS, 'Lake Charles Gumbeaux Gators', 0, 'Cancelled')}</body></html>`;
  const g = parseLeagueScoreboard(CANC, '')[0];
  assert.equal(g.state, 'cancelled');
  assert.equal(g.away.id, CANE);
  assert.equal(g.home.id, GATORS);
});

// applyLiveScores: overlay live scores onto in-progress games, keep finals.
function game(id, state, aScore, hScore) {
  return { id, state, away: { id: 'a', short: 'A', score: aScore }, home: { id: 'h', short: 'H', score: hScore } };
}

test('applyLiveScores: live non-featured game takes its cached live score', () => {
  for (const k of Object.keys(liveScoreCache)) delete liveScoreCache[k];
  liveScoreCache['L1'] = { away: 6, home: 4, at: 1 };
  const out = applyLiveScores([game('L1', 'live', 0, 0)], null);
  assert.equal(out[0].away.score, 6);
  assert.equal(out[0].home.score, 4);
});

test('applyLiveScores: final game keeps its schedule score and clears the cache', () => {
  for (const k of Object.keys(liveScoreCache)) delete liveScoreCache[k];
  liveScoreCache['F1'] = { away: 2, home: 2, at: 1 }; // stale from when it was live
  const out = applyLiveScores([game('F1', 'final', 7, 5)], null);
  assert.equal(out[0].away.score, 7);
  assert.equal(out[0].home.score, 5);
  assert.equal(liveScoreCache['F1'], undefined); // stale entry shed
});

test('applyLiveScores: featured live game uses the featured runs, not the cache', () => {
  for (const k of Object.keys(liveScoreCache)) delete liveScoreCache[k];
  const feat = { id: 'GAME', away: { runs: 10 }, home: { runs: 9 } };
  const out = applyLiveScores([game('GAME', 'live', 0, 0)], feat);
  assert.equal(out[0].away.score, 10);
  assert.equal(out[0].home.score, 9);
});

test('applyLiveScores: live game with no cached score is left untouched', () => {
  for (const k of Object.keys(liveScoreCache)) delete liveScoreCache[k];
  const out = applyLiveScores([game('L2', 'live', 0, 0)], null);
  assert.equal(out[0].away.score, 0);
  assert.equal(out[0].home.score, 0);
});

test('applyLiveScores: featured game flipped to final marks the board game final too', () => {
  for (const k of Object.keys(liveScoreCache)) delete liveScoreCache[k];
  const feat = { id: 'GAME', status: 'final', inningLabel: 'Final/11', away: { runs: 12 }, home: { runs: 11 } };
  const out = applyLiveScores([game('GAME', 'live', 0, 0)], feat);
  assert.equal(out[0].state, 'final');
  assert.equal(out[0].status, 'Final/11');
  assert.equal(out[0].away.score, 12);
  assert.equal(out[0].home.score, 11);
});

test('applyLiveScores: a non-featured game the feed reports over is marked final', () => {
  for (const k of Object.keys(liveScoreCache)) delete liveScoreCache[k];
  liveScoreCache['OVER'] = { away: 6, home: 4, at: 1, over: true, label: 'Final' };
  const out = applyLiveScores([game('OVER', 'live', 0, 0)], null);
  assert.equal(out[0].state, 'final');
  assert.equal(out[0].status, 'Final');
  assert.equal(out[0].away.score, 6);
});

// ---- which day the board shows ----------------------------------------------
// The board follows the featured game's day, which is right while the Gators are
// playing. Once they're off the schedule (between rounds, waiting on a semifinal
// opponent) `featured` sticks on their last final, and the board would freeze on
// that date — hiding the game that decides who they play next.
const { pickBoardDate } = require('../server');

test('pickBoardDate: stays on the featured game while it is today or ahead', () => {
  assert.equal(pickBoardDate('20260730', '20260730', true), '20260730');
  assert.equal(pickBoardDate('20260801', '20260730', true), '20260801');
  // No featured date at all falls back to today.
  assert.equal(pickBoardDate(null, '20260730', true), '20260730');
});

test('pickBoardDate: falls forward to today once the featured game is behind', () => {
  assert.equal(pickBoardDate('20260729', '20260730', true), '20260730');
});

test('pickBoardDate: holds the featured game when today has no league games', () => {
  // An off day would otherwise trade a real result for an empty board.
  assert.equal(pickBoardDate('20260729', '20260730', false), '20260729');
});

// ---- stand-ins for league games the schedule page hasn't posted -------------
// Presto adds a playoff game only once it's official — for semifinal Game 2 that
// was the afternoon of. MANUAL_PLAYOFF_GAMES covers the Gators' own schedule;
// these cover a game between two OTHER teams, which the board had no source for.
const { manualLeagueGame, withManualLeagueGames, MANUAL_LEAGUE_GAMES } = require('../server');

const VIC = 'jm9r4btii24hhtfp'; // Generals (BOMBERS is already declared above)

// A parsed board row.
function boardGame(id, date, awayId, homeId, state) {
  return { id, date, state: state || 'scheduled', status: 'x', isGators: false, url: 'u',
    away: { id: awayId, short: 'A', logo: null, score: null },
    home: { id: homeId, short: 'H', logo: null, score: null } };
}

test('manualLeagueGame builds a scheduled board row at 7:05', () => {
  const g = manualLeagueGame({ date: '20260730', awayId: BOMBERS, homeId: VIC });
  assert.equal(g.date, '20260730');
  assert.equal(g.state, 'scheduled');
  assert.equal(g.status, '7:05 PM CDT');
  assert.equal(g.away.id, BOMBERS);
  assert.equal(g.home.id, VIC);
  assert.equal(g.isGators, false);
  assert.equal(g.url, null);       // no box page to link to until the league posts it
  assert.match(g.id, /^20260730_/);
});

test('the configured stand-in is semifinal Game 3 at Victoria', () => {
  const [m] = MANUAL_LEAGUE_GAMES;
  assert.equal(m.date, '20260730');
  assert.equal(m.awayId, BOMBERS);   // higher seed hosts Games 2 & 3
  assert.equal(m.homeId, VIC);
});

test('withManualLeagueGames fills an empty day', () => {
  const out = withManualLeagueGames([], '20260730');
  assert.equal(out.length, 1);
  assert.equal(out[0].home.id, VIC);
});

test('withManualLeagueGames only adds stand-ins for the day being shown', () => {
  assert.deepEqual(withManualLeagueGames([], '20260729'), []);
});

test('a real posting displaces its stand-in, either orientation', () => {
  const real = boardGame('20260730_abcd', '20260730', BOMBERS, VIC, 'live');
  const out = withManualLeagueGames([real], '20260730');
  assert.equal(out.length, 1);
  assert.equal(out[0].id, real.id);
  // Home/away listed the other way round is still the same matchup.
  const flipped = boardGame('20260730_abcd', '20260730', VIC, BOMBERS, 'live');
  const out2 = withManualLeagueGames([flipped], '20260730');
  assert.equal(out2.length, 1);
  assert.equal(out2[0].id, flipped.id);
});

test('an unrelated game that day does not displace the stand-in', () => {
  const other = boardGame('20260730_zzzz', '20260730', 'aaa', 'bbb', 'final');
  const out = withManualLeagueGames([other], '20260730');
  assert.equal(out.length, 2);
  assert.ok(out.some(g => /_tbd$/.test(g.id)));
});
