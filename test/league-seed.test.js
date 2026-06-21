'use strict';
// Tests for parseLeagueStats(): the league hitting/pitching pages are the fast
// seed for the Roster tab — one fetch each populates most cards before the slow
// per-player pass runs. We only keep Gators players (matched by team ?id=).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLeagueStats } = require('../server');

const GATORS_ID = 'et1bt9sixrz5lnnl';
const OTHER_ID = 'z7w5th537gur3z15';

// A trimmed league hitting leaderboard: rank | player(link) | team(link) | stats…
function hittingHtml(rows) {
  return `<table>
    <tr><th>Rank</th><th>Player</th><th>Team</th><th>AVG</th><th>HR</th><th>RBI</th></tr>
    ${rows}</table>`;
}
const hRow = (slug, teamId, avg, hr, rbi) =>
  `<tr><td>1</td><td><a href="/players/${slug}">x</a></td>` +
  `<td><a href="/sports/bsb/2026/players?id=${teamId}">t</a></td>` +
  `<td>${avg}</td><td>${hr}</td><td>${rbi}</td></tr>`;

test('parseLeagueStats: seeds Gators hitters by slug with card fields', () => {
  const html = hittingHtml(
    hRow('jakesmith8yx5', GATORS_ID, '.345', '4', '18') +
    hRow('someoneelsezzzz', OTHER_ID, '.300', '2', '10')
  );
  const map = parseLeagueStats(html, 'h');
  assert.deepEqual(map.jakesmith8yx5, { avg: '.345', hr: '4', rbi: '18' });
  assert.equal(map.someoneelsezzzz, undefined); // non-Gators excluded
});

test('parseLeagueStats: requires the AVG column for hitting (guards junk pages)', () => {
  const html = '<table><tr><th>Rank</th><th>Player</th><th>Team</th><th>Pts</th></tr></table>';
  assert.deepEqual(parseLeagueStats(html, 'h'), {});
});

test('parseLeagueStats: parses pitching when ERA/IP columns are present', () => {
  const html = `<table>
    <tr><th>Rank</th><th>Player</th><th>Team</th><th>ERA</th><th>IP</th><th>K</th></tr>
    <tr><td>1</td><td><a href="/players/davisduhons0vw">x</a></td>
    <td><a href="/sports/bsb/2026/players?id=${GATORS_ID}">t</a></td>
    <td>2.45</td><td>22.0</td><td>30</td></tr></table>`;
  const map = parseLeagueStats(html, 'p');
  assert.deepEqual(map.davisduhons0vw, { era: '2.45', ip: '22.0', k: '30' });
});
