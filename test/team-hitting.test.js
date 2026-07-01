'use strict';
// Tests for parseLeagueTeamHitters(): the same league hitting leaderboard that
// seeds our roster, but grouped by team id and keeping each hitter's full season
// line — this powers the Standings-tab "tap a team to see its hitters" view.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLeagueTeamHitters } = require('../server');

const GATORS_ID = 'et1bt9sixrz5lnnl';
const OTHER_ID = 'z7w5th537gur3z15';

function hittingHtml(rows) {
  return `<table>
    <tr><th>Rank</th><th>Player</th><th>Team</th><th>AVG</th><th>OBP</th><th>SLG</th><th>HR</th><th>RBI</th><th>H</th><th>AB</th></tr>
    ${rows}</table>`;
}
const hRow = (name, teamId, s) =>
  `<tr><td>1</td><td><a href="/players/x">${name}</a></td>` +
  `<td><a href="/sports/bsb/2026/players?id=${teamId}">t</a></td>` +
  `<td>${s.avg}</td><td>${s.obp}</td><td>${s.slg}</td><td>${s.hr}</td><td>${s.rbi}</td><td>${s.h}</td><td>${s.ab}</td></tr>`;

test('parseLeagueTeamHitters: groups every team’s hitters with full lines', () => {
  const html = hittingHtml(
    hRow('Jake Smith', OTHER_ID, { avg: '.345', obp: '.410', slg: '.560', hr: '4', rbi: '18', h: '38', ab: '110' }) +
    hRow('Sam Jones', OTHER_ID, { avg: '.300', obp: '.360', slg: '.450', hr: '2', rbi: '10', h: '27', ab: '90' }) +
    hRow('Gator Guy', GATORS_ID, { avg: '.288', obp: '.350', slg: '.400', hr: '1', rbi: '9', h: '21', ab: '73' })
  );
  const byTeam = parseLeagueTeamHitters(html);
  assert.equal(byTeam[OTHER_ID].length, 2);
  assert.equal(byTeam[GATORS_ID].length, 1);
  assert.equal(byTeam[OTHER_ID][0].name, 'Jake Smith');
  assert.deepEqual(byTeam[OTHER_ID][0].stats,
    { avg: '.345', obp: '.410', slg: '.560', hr: '4', rbi: '18', h: '38', ab: '110' });
});

test('parseLeagueTeamHitters: rows without a resolvable team id are skipped', () => {
  const html = `<table>
    <tr><th>Rank</th><th>Player</th><th>Team</th><th>AVG</th></tr>
    <tr><td>1</td><td><a href="/players/x">No Team</a></td><td>—</td><td>.250</td></tr></table>`;
  assert.deepEqual(parseLeagueTeamHitters(html), {});
});

test('parseLeagueTeamHitters: requires the AVG column (guards junk pages)', () => {
  const html = '<table><tr><th>Rank</th><th>Player</th><th>Team</th><th>Pts</th></tr></table>';
  assert.deepEqual(parseLeagueTeamHitters(html), {});
});
