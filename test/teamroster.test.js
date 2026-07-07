'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseTeamRosterSlugs } = require('../server');

// A Presto team roster page's roster table: a header row with a "Name" column,
// each player row linking their name to /players/<slug>. This is the source
// findSlug uses to resolve a newly-active player's real slug (the league
// pitching leaderboard is JS-rendered and lists no pitchers, so their slug can
// only come from here).
const TEAM_PAGE = `
<html><body>
<table>
  <tr><th>No.</th><th>Name</th><th>Pos.</th><th>Yr.</th></tr>
  <tr><td>12</td><td><a href="/sports/bsb/2026/players/taylorhollierabcd">Taylor Hollier</a></td><td>P</td><td>Fr.</td></tr>
  <tr><td>24</td><td><a href="/sports/bsb/2026/players/pierceboleswxyz">Boles, Pierce</a></td><td>P</td><td>So.</td></tr>
  <tr><td>47</td><td><a href="/sports/bsb/2026/players/braydenguillory12ab">Brayden Guillory</a></td><td>P</td><td>Fr.</td></tr>
</table>
</body></html>`;

test('parseTeamRosterSlugs: maps each player\'s normalized name to their Presto slug', () => {
  const map = parseTeamRosterSlugs(TEAM_PAGE);
  assert.equal(map['taylor hollier'], 'taylorhollierabcd');
  assert.equal(map['brayden guillory'], 'braydenguillory12ab');
});

test('parseTeamRosterSlugs: normalizes a "Last, First" name to "first last"', () => {
  const map = parseTeamRosterSlugs(TEAM_PAGE);
  // "Boles, Pierce" must key the same way findSlug looks it up (from "Pierce Boles").
  assert.equal(map['pierce boles'], 'pierceboleswxyz');
});

test('parseTeamRosterSlugs: a table without a Name column is skipped', () => {
  const noName = '<table><tr><th>No.</th><th>Pos.</th></tr><tr><td>1</td><td>P</td></tr></table>';
  assert.deepEqual(parseTeamRosterSlugs(noName), {});
});

test('parseTeamRosterSlugs: no tables at all yields an empty map, no crash', () => {
  assert.deepEqual(parseTeamRosterSlugs('<html><body>no tables here</body></html>'), {});
});
