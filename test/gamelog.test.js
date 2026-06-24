'use strict';
// Tests for parseGameLog(): the pitching game log must list only games where the
// pitcher actually appeared (recorded outs or faced a batter), not every team
// game the player was listed for.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGameLog } = require('../server');

const pitchTable = rows => `<table>
  <tr><th>Date</th><th>Opponent</th><th>Score</th><th>IP</th><th>H</th><th>R</th><th>ER</th><th>BB</th><th>K</th><th>ERA</th></tr>
  ${rows}</table>`;
const row = (date, ip, h, r, er, bb, k, era) =>
  `<tr><td>${date}</td><td>Acadiana</td><td>W 5-2</td><td>${ip}</td><td>${h}</td><td>${r}</td><td>${er}</td><td>${bb}</td><td>${k}</td><td>${era}</td></tr>`;

test('parseGameLog: keeps games with recorded outs', () => {
  const { pit } = parseGameLog([pitchTable(row('Jun 10', '5.0', '4', '2', '2', '1', '6', '3.60'))]);
  assert.equal(pit.length, 1);
  assert.equal(pit[0].ip, '5.0');
});

test('parseGameLog: keeps a 0-out appearance that faced batters', () => {
  // Pulled before recording an out but gave up hits/runs — still an appearance.
  const { pit } = parseGameLog([pitchTable(row('Jun 12', '0.0', '2', '3', '3', '1', '0', '—'))]);
  assert.equal(pit.length, 1);
});

test('parseGameLog: extracts the box score URL from a row link', () => {
  const tbl = `<table>
    <tr><th>Date</th><th>Opponent</th><th>Score</th><th>IP</th><th>H</th><th>R</th><th>ER</th><th>BB</th><th>K</th><th>ERA</th></tr>
    <tr><td>Jun 10</td><td>Acadiana</td><td><a href="../boxscores/20260610_ab12.xml">W 5-2</a></td><td>5.0</td><td>4</td><td>2</td><td>2</td><td>1</td><td>6</td><td>3.60</td></tr></table>`;
  const { pit } = parseGameLog([tbl]);
  assert.equal(pit.length, 1);
  assert.match(pit[0].boxUrl, /\/boxscores\/20260610_ab12\.xml$/);
  // The bare game id powers the in-app box-score deep link (openBox).
  assert.equal(pit[0].boxId, '20260610_ab12');
});

test('parseGameLog: drops listed-but-did-not-pitch rows', () => {
  const rows = row('Jun 14', '0.0', '0', '0', '0', '0', '0', '—') + // all zeros => no appearance
               row('Jun 15', '-', '-', '-', '-', '-', '-', '-') +   // blanks => no appearance
               row('Jun 16', '3.1', '2', '0', '0', '0', '4', '0.00'); // real appearance
  const { pit } = parseGameLog([pitchTable(rows)]);
  assert.equal(pit.length, 1);
  assert.equal(pit[0].date, 'Jun 16');
});
