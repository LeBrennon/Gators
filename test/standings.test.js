'use strict';
// Tests for parseStandings(): turning the league standings table into a
// name->record map (used for the jumbo records) and an ordered, logo-decorated
// row list (used by the Standings tab).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseStandings, applyStandingsOverride, MANUAL_STANDINGS_OVERRIDE } = require('../server');

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
  assert.equal(gators.logo, '/gators-logo.png');
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

// applyStandingsOverride(): a manual full-season override acts as a FLOOR so a
// lagging feed is lifted to the confirmed total, but the moment the feed catches
// up (or the team plays past it) the live numbers win and the record keeps
// climbing on its own — no manual clearing needed.
const GATORS = 'et1bt9sixrz5lnnl';

function parsedFor(w, l, t, streak) {
  return {
    map: { lakecharlesgumbeauxgators: { w, l, t } },
    rows: [{ id: GATORS, name: 'Lake Charles Gumbeaux Gators', short: 'Gators', w, l, t, streak }],
  };
}

function withOverride(id, ov, fn) {
  const prev = MANUAL_STANDINGS_OVERRIDE[id];
  MANUAL_STANDINGS_OVERRIDE[id] = ov;
  try { return fn(); } finally {
    if (prev === undefined) delete MANUAL_STANDINGS_OVERRIDE[id];
    else MANUAL_STANDINGS_OVERRIDE[id] = prev;
  }
}

test('applyStandingsOverride: lifts a lagging feed up to the confirmed floor', () => {
  withOverride(GATORS, { w: 16, l: 12, streak: 'W4' }, () => {
    const parsed = parsedFor(15, 12, 0, 'W3'); // feed a win short
    applyStandingsOverride(parsed);
    assert.deepEqual(parsed.map.lakecharlesgumbeauxgators, { w: 16, l: 12, t: 0 });
    assert.equal(parsed.rows[0].w, 16);
    assert.equal(parsed.rows[0].l, 12);
    assert.equal(parsed.rows[0].streak, 'W4'); // manual streak while still correcting
  });
});

test('applyStandingsOverride: self-expires — feed that caught up keeps its own numbers and streak', () => {
  withOverride(GATORS, { w: 16, l: 12, streak: 'W4' }, () => {
    const parsed = parsedFor(16, 12, 0, 'W4'); // feed now matches the floor
    applyStandingsOverride(parsed);
    assert.deepEqual(parsed.map.lakecharlesgumbeauxgators, { w: 16, l: 12, t: 0 });
    assert.equal(parsed.rows[0].streak, 'W4');
  });
});

test('applyStandingsOverride: never lowers a feed that has moved past the floor', () => {
  withOverride(GATORS, { w: 16, l: 12, streak: 'W4' }, () => {
    const parsed = parsedFor(17, 12, 0, 'W5'); // Gators won again; feed leads the floor
    applyStandingsOverride(parsed);
    assert.equal(parsed.map.lakecharlesgumbeauxgators.w, 17);
    assert.equal(parsed.rows[0].w, 17);
    assert.equal(parsed.rows[0].streak, 'W5'); // live streak preserved, not the stale manual one
  });
});

test('applyStandingsOverride: floors each of W and L independently', () => {
  withOverride(GATORS, { w: 16, l: 12, streak: 'W4' }, () => {
    const parsed = parsedFor(17, 11, 0, 'W1'); // more wins, but feed a loss short
    applyStandingsOverride(parsed);
    assert.equal(parsed.map.lakecharlesgumbeauxgators.w, 17); // feed's higher W wins
    assert.equal(parsed.map.lakecharlesgumbeauxgators.l, 12); // floor lifts the lagging L
    assert.equal(parsed.rows[0].streak, 'W4'); // still correcting (L was lifted)
  });
});

test('applyStandingsOverride: preserves the feed tie count and leaves other teams alone', () => {
  withOverride(GATORS, { w: 16, l: 12, streak: 'W4' }, () => {
    const parsed = parsedFor(15, 12, 2, 'W3');
    parsed.map.victoriagenerals = { w: 20, l: 8, t: 0 }; // not in the override list
    applyStandingsOverride(parsed);
    assert.equal(parsed.map.lakecharlesgumbeauxgators.t, 2); // tie count untouched
    assert.deepEqual(parsed.map.victoriagenerals, { w: 20, l: 8, t: 0 });
  });
});
