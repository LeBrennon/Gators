'use strict';
// Tests for parseSchedule(): scraping the server-rendered schedule HTML into
// the Gators' games. Exercises team identification (from logo ids + alt text),
// score extraction, status classification, Gators-only filtering, and sorting.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSchedule } = require('../server');

const GATORS = 'et1bt9sixrz5lnnl';
const CANE   = 'cz8qei0rxijys6nm';   // Acadiana Cane Cutters
const ABILENE= 'ij0lwtvjsx2mi1nh';   // Abilene Flying Bison
const ROUGAROU = 'z10kgms3gvy1eszs';
const BOMBERS  = 'z7w5th537gur3z15';

// One schedule row: two team logos (away then home), each followed by its score,
// a status string, then the boxscore link the parser keys off of.
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

// Built out of order on purpose (later date first) to prove the parser sorts.
const HTML = `<html><body>
  ${row('20260621', 'cccc', CANE, 'Acadiana Cane Cutters', 3, GATORS, 'Lake Charles Gumbeaux Gators', 5, 'Final')}
  ${row('20260620', 'aaaa', GATORS, 'Lake Charles Gumbeaux Gators', 2, ABILENE, 'Abilene Flying Bison', 1, 'Top 4')}
  ${row('20260621', 'zzzz', ROUGAROU, 'Baton Rouge Rougarou', 7, BOMBERS, 'Brazos Valley Bombers', 4, 'Final')}
</body></html>`;

test('parseSchedule: keeps only Gators games', () => {
  const games = parseSchedule(HTML);
  assert.equal(games.length, 2);
  assert.ok(games.every(g => g.away.id === GATORS || g.home.id === GATORS));
});

test('parseSchedule: sorts ascending by date', () => {
  const games = parseSchedule(HTML);
  assert.deepEqual(games.map(g => g.date), ['20260620', '20260621']);
});

test('parseSchedule: away game — Gators on the road, opponent is the home team', () => {
  const away = parseSchedule(HTML).find(g => g.id === '20260620_aaaa');
  assert.equal(away.gatorsHome, false);
  assert.equal(away.state, 'live');
  assert.equal(away.status, 'Top of 4th');
  assert.equal(away.opponent.short, 'Flying Bison');
  assert.equal(away.away.id, GATORS);
  assert.equal(away.away.score, 2);
  assert.equal(away.home.id, ABILENE);
  assert.equal(away.home.score, 1);
});

test('parseSchedule: home game — Gators at home, scores and final status', () => {
  const home = parseSchedule(HTML).find(g => g.id === '20260621_cccc');
  assert.equal(home.gatorsHome, true);
  assert.equal(home.state, 'final');
  assert.equal(home.status, 'Final/9');
  assert.equal(home.opponent.name, 'Acadiana Cane Cutters');
  assert.equal(home.away.score, 3);
  assert.equal(home.home.score, 5);
});

test('parseSchedule: empty / non-matching HTML yields no games', () => {
  assert.deepEqual(parseSchedule('<html>nothing here</html>'), []);
});
