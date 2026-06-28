'use strict';
// Regression test for lineGrid(): parsing the score-by-innings line table out of
// a box score. A redeclared loop variable (`for (const r ...)` plus an inner
// `const r`) put `r` in the temporal dead zone, so every call threw "Cannot
// access 'r' before initialization" — which silently killed the whole post-game
// report build. Existing box-stats tests passed an empty line score, so they
// never exercised this path; this one feeds a real table.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../scripts/postgame-report.js');

const LINE = `<table>
  <tr><th></th><th>1</th><th>2</th><th>3</th><th>R</th><th>H</th><th>E</th></tr>
  <tr><td>Lake Charles Gumbeaux Gators</td><td>0</td><td>2</td><td>3</td><td>5</td><td>9</td><td>1</td></tr>
  <tr><td>Brazos Valley Bombers</td><td>1</td><td>0</td><td>2</td><td>3</td><td>5</td><td>0</td></tr>
</table>`;

test('lineGrid: parses the line score without a temporal-dead-zone throw', () => {
  let grid;
  assert.doesNotThrow(() => { grid = P.lineGrid(LINE); });
  assert.ok(Array.isArray(grid) && grid.length >= 2);
  const g = grid.find(r => /gator/i.test(r.name));
  assert.ok(g, 'Gators row present');
  assert.equal(g.r, 5);
  assert.equal(g.h, 9);
  assert.equal(g.e, 1);
  assert.deepEqual(g.innings, [0, 2, 3]);
});

test('lineGrid: returns null when there is no line-score table', () => {
  assert.equal(P.lineGrid(''), null);
});
