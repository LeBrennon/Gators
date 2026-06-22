'use strict';
// Tests for parseStandings(): turning the league standings table into a
// name->record map (used for the jumbo records) and an ordered, logo-decorated
// row list (used by the Standings tab).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseStandings } = require('../server');

// A trimmed standings table shaped like the PrestoSports page: a header row with
// short W/L/T codes and a team-name cell that links to /teams/<id>.
const HTML = `
<table>
  <tr><th>Team</th><th>W</th><th>L</th><th>T</th><th>PCT</th></tr>
  <tr><td><a href="/sports/bsb/2026/teams/et1bt9sixrz5lnnl">Lake Charles Gumbeaux Gators</a></td><td>20</td><td>10</td><td>0</td><td>.667</td></tr>
  <tr><td><a href="/sports/bsb/2026/teams/z7w5th537gur3z15">Brazos Valley Bombers</a></td><td>18</td><td>11</td><td>1</td><td>.617</td></tr>
  <tr><td>Some New Expansion Team</td><td>5</td><td>25</td><td>0</td><td>.167</td></tr>
</table>`;

test('parseStandings: builds the name->record map', () => {
  const { map } = parseStandings(HTML);
  assert.deepEqual(map.lakecharlesgumbeauxgators, { w: 20, l: 10, t: 0 });
  assert.deepEqual(map.brazosvalleybombers, { w: 18, l: 11, t: 1 });
});

test('parseStandings: returns rows in page order', () => {
  const { rows } = parseStandings(HTML);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.w), [20, 18, 5]);
});

test('parseStandings: decorates known teams with id, short name, and logo', () => {
  const { rows } = parseStandings(HTML);
  const gators = rows[0];
  assert.equal(gators.id, 'et1bt9sixrz5lnnl');
  assert.equal(gators.short, 'Gators');
  assert.equal(gators.logo, '/gators-logo.jpg');
  const bombers = rows[1];
  assert.equal(bombers.short, 'Bombers');
  assert.match(bombers.logo, /\/logos\/id\/z7w5th537gur3z15\.png$/);
});

test('parseStandings: falls back to the raw name for unknown teams', () => {
  const { rows } = parseStandings(HTML);
  const unknown = rows[2];
  assert.equal(unknown.id, null);
  assert.equal(unknown.short, 'Some New Expansion Team');
  assert.equal(unknown.logo, '');
});

test('parseStandings: matches a known team by name when no /teams link is present', () => {
  const html = `
    <table>
      <tr><th>Team</th><th>W</th><th>L</th></tr>
      <tr><td>Victoria Generals</td><td>12</td><td>9</td></tr>
    </table>`;
  const { rows } = parseStandings(html);
  assert.equal(rows[0].id, 'jm9r4btii24hhtfp');
  assert.equal(rows[0].short, 'Generals');
});

test('parseStandings: returns empty when there is no W/L header', () => {
  const { map, rows } = parseStandings('<table><tr><th>Team</th><th>Pts</th></tr></table>');
  assert.deepEqual(map, {});
  assert.deepEqual(rows, []);
});

test('parseStandings: parses the streak column into compact W#/L# form', () => {
  const html = `
    <table>
      <tr><th>Team</th><th>W</th><th>L</th><th>T</th><th>PCT</th><th>Streak</th></tr>
      <tr><td><a href="/sports/bsb/2026/teams/et1bt9sixrz5lnnl">Lake Charles Gumbeaux Gators</a></td><td>20</td><td>10</td><td>0</td><td>.667</td><td>Won 5</td></tr>
      <tr><td><a href="/sports/bsb/2026/teams/z7w5th537gur3z15">Brazos Valley Bombers</a></td><td>18</td><td>11</td><td>1</td><td>.617</td><td>Lost 4</td></tr>
      <tr><td>Some New Expansion Team</td><td>5</td><td>25</td><td>0</td><td>.167</td><td>—</td></tr>
    </table>`;
  const { rows } = parseStandings(html);
  assert.equal(rows[0].streak, 'W5');
  assert.equal(rows[1].streak, 'L4');
  assert.equal(rows[2].streak, '');
});

test('parseStandings: streak is blank when there is no streak column', () => {
  const { rows } = parseStandings(HTML);
  assert.equal(rows[0].streak, '');
});
