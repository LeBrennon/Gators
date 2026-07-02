'use strict';
// Tests for bsAddSeasonAvg(): appends a season batting-average (AVG) column to a
// box-score batting table so opponents' (and our) averages show in the box score
// for live and past games. Injected at serve time, so the figure never freezes
// in the cached box. Season stats live in module-private state that a unit test
// can't populate, so these assert the column mechanics; unmatched hitters show a
// placeholder dash rather than crashing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bsAddSeasonAvg, bsBatterName, bsBattingSlugs } = require('../server');

test('bsBatterName: strips the position span (First Last box format)', () => {
  assert.equal(bsBatterName('<th><div><span>cf</span> Ayden Sunday</div></th>'), 'Ayden Sunday');
});

test('bsBatterName: strips an inline trailing position (Last, First box format)', () => {
  assert.equal(bsBatterName('<td>Smith, John ss</td>'), 'Smith, John');
});

test('bsBatterName: drops a (decision) parenthetical', () => {
  assert.equal(bsBatterName('<th><div><span>dh</span> Easton Culp (W, 1-0)</div></th>'), 'Easton Culp');
});

// A box batting table shaped like the parsed/cleaned output: a header row, two
// hitter rows (position in a <span>), and a Totals row.
const TABLE =
  '<table>' +
  '<tr><th>Gators Hitters</th><th>AB</th><th>R</th><th>H</th></tr>' +
  '<tr><th><div><span>cf</span> Ayden Sunday</div></th><td>4</td><td>1</td><td>2</td></tr>' +
  '<tr><th><div><span>ss</span> Smith, John</div></th><td>3</td><td>0</td><td>1</td></tr>' +
  '<tr><th>Totals</th><td>7</td><td>1</td><td>3</td></tr>' +
  '</table>';

test('bsAddSeasonAvg: adds an AVG header cell', () => {
  const out = bsAddSeasonAvg(TABLE);
  assert.match(out, /<th class="bxavg">AVG<\/th>/);
});

test('bsAddSeasonAvg: appends one AVG cell to every hitter and the totals row', () => {
  const out = bsAddSeasonAvg(TABLE);
  const headers = (out.match(/<th class="bxavg">/g) || []).length;
  const cells = (out.match(/<td class="bxavg">/g) || []).length;
  assert.equal(headers, 1);       // one header
  assert.equal(cells, 3);         // two hitters + the totals row
});

test('bsAddSeasonAvg: hitters with no matching season stats show a dash', () => {
  const out = bsAddSeasonAvg(TABLE);
  // No roster/leaderboard state in a unit test, so both hitters fall through to '-'.
  assert.match(out, /<td class="bxavg">-<\/td>/);
  // The totals row's AVG cell stays blank (not a dash).
  assert.match(out, /<td class="bxavg"><\/td>/);
});

test('bsAddSeasonAvg: leaves existing columns and player names intact', () => {
  const out = bsAddSeasonAvg(TABLE);
  assert.match(out, /Ayden Sunday/);
  assert.match(out, /Smith, John/);
  assert.match(out, /<td>4<\/td>/); // original AB value survives
});

test('bsAddSeasonAvg: a row with no cells is left untouched', () => {
  assert.equal(bsAddSeasonAvg('<table><tr></tr></table>'), '<table><tr></tr></table>');
});

// bsBattingSlugs(): reads each hitter's own Presto slug straight off the RAW
// (pre-bsClean) Hitters table, from the same <a href=".../players/slug"> link
// their own profile page lives at — so an opponent's AVG can come from their own
// page instead of only the (unreliable) league leaderboard.
const RAW_TABLE =
  '<table>' +
  '<tr><th>Bombers Hitters</th><th>AB</th></tr>' +
  '<tr><th><div><span>cf</span> <a href="/sports/bsb/2026/players/joeyduran9x">Duran, Joey</a></div></th><td>4</td></tr>' +
  '<tr><th><div><span>ss</span> <a href="/sports/bsb/2026/players/jbohacek3z">Bohacek, Jacob</a></div></th><td>3</td></tr>' +
  '<tr><th>Totals</th><td>7</td></tr>' +
  '</table>';

test('bsBattingSlugs: maps each hitter\'s normalized name to their Presto slug', () => {
  const map = bsBattingSlugs(RAW_TABLE);
  assert.deepEqual(map, { 'joey duran': 'joeyduran9x', 'jacob bohacek': 'jbohacek3z' });
});

test('bsBattingSlugs: a Totals row (no link) and rows without a link are skipped', () => {
  const map = bsBattingSlugs('<table><tr><th>Totals</th><td>7</td></tr></table>');
  assert.deepEqual(map, {});
});

test('bsBattingSlugs: no rows at all yields an empty map, no crash', () => {
  assert.deepEqual(bsBattingSlugs('<table></table>'), {});
});

test('bsAddSeasonAvg: accepts a slugMap without crashing (no roster/leaderboard state in a unit test, so still dashes)', () => {
  const out = bsAddSeasonAvg(TABLE, { 'ayden sunday': 'aydensunday', 'smith john': 'jsmith' });
  assert.match(out, /<td class="bxavg">-<\/td>/);
});
