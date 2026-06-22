'use strict';
// Tests for parseLeagueScoreboard(): scraping the same schedule HTML into a
// league-wide, single-day scoreboard (no Gators-only filter), with scores,
// status, and live-before-final-before-scheduled ordering (Gators first).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLeagueScoreboard } = require('../server');

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
