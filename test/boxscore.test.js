'use strict';
// Fixture-based tests for parseBoxscore(): bucketing the boxscore page's tables
// into line score / batting / pitching / play-by-play, naming the box sections
// from the line-score teams, and stripping markup noise via bsClean.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseBoxscore, boxErrorResponse } = require('../server');

const DASH = '—'; // em dash used in box section labels
const HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'boxscore.html'), 'utf8');

test('parseBoxscore: counts each table type', () => {
  const { counts } = parseBoxscore(HTML);
  assert.deepEqual(counts, { tables: 6, line: 1, batting: 2, pitching: 1, pbp: 2 });
});

test('parseBoxscore: pulls both team names from the line score', () => {
  const { teams } = parseBoxscore(HTML);
  assert.deepEqual(teams, ['Acadiana Cane Cutters', 'Lake Charles Gumbeaux Gators']);
});

test('parseBoxscore: builds labeled box sections (each team grouped, batting then pitching)', () => {
  const { box } = parseBoxscore(HTML);
  assert.equal(box.length, 3);
  // Tables are grouped per team: a team's batting is immediately followed by
  // that team's pitching. (The fixture only carries the away team's pitching.)
  assert.deepEqual(box.map(b => b.label), [
    'Acadiana Cane Cutters ' + DASH + ' Batting',
    'Acadiana Cane Cutters ' + DASH + ' Pitching',
    'Lake Charles Gumbeaux Gators ' + DASH + ' Batting',
  ]);
});

test('parseBoxscore: parses play-by-play titles in order', () => {
  const { pbp } = parseBoxscore(HTML);
  assert.equal(pbp.length, 2);
  assert.equal(pbp[0].title, 'Top of 1st Inning');
  assert.equal(pbp[1].title, 'Bottom of 1st Inning');
});

test('parseBoxscore: line score is cleaned but keeps the data', () => {
  const { line } = parseBoxscore(HTML);
  // Cleaned: no images, links, classes, or thead/tbody wrappers.
  assert.doesNotMatch(line, /<img/i);
  assert.doesNotMatch(line, /href=/i);
  assert.doesNotMatch(line, /class=/i);
  assert.doesNotMatch(line, /<\/?(?:thead|tbody)/i);
  // Kept: team names and the run totals.
  assert.match(line, /Acadiana Cane Cutters/);
  assert.match(line, /Lake Charles Gumbeaux Gators/);
  assert.match(line, /<td>5<\/td>/);
});

test('parseBoxscore: box html is cleaned, player names survive, <strong> -> <b>', () => {
  const { box } = parseBoxscore(HTML);
  const awayBatting = box.find(b => /Batting/.test(b.label)).html;
  assert.match(awayBatting, /Smith, John/);
  assert.doesNotMatch(awayBatting, /<a\b/i);
  assert.doesNotMatch(awayBatting, /<img/i);
  // <strong>(L)</strong> in the pitching table becomes <b>(L)</b>.
  const awayPitching = box.find(b => /Pitching/.test(b.label)).html;
  assert.match(awayPitching, /<b>\(L\)<\/b>/);
  assert.doesNotMatch(awayPitching, /<strong>/i);
});

test('parseBoxscore: empty input yields empty buckets, no crash', () => {
  const r = parseBoxscore('');
  assert.equal(r.line, null);
  assert.deepEqual(r.teams, []);
  assert.deepEqual(r.box, []);
  assert.deepEqual(r.pbp, []);
  assert.deepEqual(r.counts, { tables: 0, line: 0, batting: 0, pitching: 0, pbp: 0 });
});

test('parseBoxscore: drops the pitcher hitting row when there is a DH', () => {
  const html = `
    <table>
      <tr><th>Hitters</th><th>AB</th><th>H</th></tr>
      <tr><th><div><span>cf</span> Ayden Sunday</div></th><td>4</td><td>2</td></tr>
      <tr><th><div><span>dh</span> Easton Culp</div></th><td>4</td><td>1</td></tr>
      <tr><th><div><span>p</span> Jack Garcille</div></th><td>0</td><td>0</td></tr>
    </table>`;
  const batting = parseBoxscore(html).box.find(b => /Batting/.test(b.label)).html;
  assert.match(batting, /Ayden Sunday/);
  assert.match(batting, /Easton Culp/);
  assert.doesNotMatch(batting, /Jack Garcille/);
});

test('parseBoxscore: drops the pitcher even without an explicit DH row (TCL always uses a DH)', () => {
  const html = `
    <table>
      <tr><th>Hitters</th><th>AB</th></tr>
      <tr><th><div><span>cf</span> Ayden Sunday</div></th><td>4</td></tr>
      <tr><th><div><span>p</span> Jack Garcille</div></th><td>0</td></tr>
    </table>`;
  const batting = parseBoxscore(html).box.find(b => /Batting/.test(b.label)).html;
  assert.match(batting, /Ayden Sunday/);
  assert.doesNotMatch(batting, /Jack Garcille/);
});

test('parseBoxscore: drops a reliever from the Hitters table even with a blank position', () => {
  // Relievers who never bat list in the Hitters table with no position span and
  // a 0-for-0 line; the position filter misses them, so we match the Pitchers
  // table by name instead.
  const html = `
    <table>
      <tr><th>Hitters</th><th>AB</th><th>H</th></tr>
      <tr><th><div><span>cf</span> Ayden Sunday</div></th><td>4</td><td>2</td></tr>
      <tr><th><div>John Munnerlyn</div></th><td>0</td><td>0</td></tr>
      <tr><th><div>Brandon Levy</div></th><td>0</td><td>0</td></tr>
      <tr><th>Totals</th><td>4</td><td>2</td></tr>
    </table>
    <table>
      <tr><th>Pitchers</th><th>IP</th></tr>
      <tr><th><div>John Munnerlyn</div></th><td>2.0</td></tr>
      <tr><th><div>Brandon Levy (W, 1-0)</div></th><td>1.0</td></tr>
      <tr><th>Totals</th><td>3.0</td></tr>
    </table>`;
  const batting = parseBoxscore(html).box.find(b => /Batting/.test(b.label)).html;
  assert.match(batting, /Ayden Sunday/);
  assert.doesNotMatch(batting, /Munnerlyn/);
  assert.doesNotMatch(batting, /Brandon Levy/);
});

test('parseBoxscore: caption shows the mascot, not the full city name', () => {
  const html = `
    <table>
      <caption><h2> Lake Charles Gumbeaux Gators  <span>Batters</span></h2></caption>
      <tr><th>Hitters</th><th>AB</th></tr>
      <tr><th><div><span>cf</span> Ayden Sunday</div></th><td>4</td></tr>
    </table>
    <table>
      <caption><h2> Baton Rouge Rougarou  <span>Pitchers</span></h2></caption>
      <tr><th>Pitchers</th><th>IP</th></tr>
      <tr><th><div>Will Robinson</div></th><td>5.0</td></tr>
    </table>`;
  const { box } = parseBoxscore(html);
  const bat = box.find(b => /Batting/.test(b.label)).html;
  const pit = box.find(b => /Pitching/.test(b.label)).html;
  assert.match(bat, /<h2>Gators <span>Batters<\/span>/);
  assert.doesNotMatch(bat, /Lake Charles/);
  assert.match(pit, /<h2>Rougarou <span>Pitchers<\/span>/);
  assert.doesNotMatch(pit, /Baton Rouge/);
});

test('parseBoxscore: pulls 2B/3B/HR/SB/CS/E notes per team in batting order', () => {
  const html = `
    <table><caption><h2> Lake Charles Gumbeaux Gators <span>Batters</span></h2></caption>
      <tr><th>Hitters</th><th>AB</th></tr>
      <tr><th><div><span>cf</span> Ayden Sunday</div></th><td>4</td></tr>
    </table>
    <div class="stats-summary"><div class="caption">Batting</div>
      <div><strong>2B:</strong><span> James Reina , Connor Walker </span></div>
      <div><strong>3B:</strong><span> James Reina </span></div>
      <div><strong>RBI:</strong><span> Ayden Sunday </span></div></div>
    <div class="stats-summary"><div class="caption">Baserunning</div>
      <div><strong>SB:</strong><span> Bankston Lembcke </span></div>
      <div><strong>CS:</strong><span> Griffin Hebert , James Reina </span></div></div>
    <div class="stats-summary"><div class="caption">Fielding</div>
      <div><strong>E:</strong><span> Connor Walker </span></div></div>
    <table><caption><h2> Baton Rouge Rougarou <span>Batters</span></h2></caption>
      <tr><th>Hitters</th><th>AB</th></tr>
      <tr><th><div><span>2b</span> Brock Louque</div></th><td>4</td></tr>
    </table>
    <div class="stats-summary"><div class="caption">Batting</div>
      <div><strong>HR:</strong><span> Jacob Keys </span></div></div>`;
  const bats = parseBoxscore(html).box.filter(b => /Batting/.test(b.label));
  assert.deepEqual(bats[0].notes, { '2B': 'James Reina, Connor Walker', '3B': 'James Reina', 'SB': 'Bankston Lembcke', 'CS': 'Griffin Hebert, James Reina', 'E': 'Connor Walker' });
  assert.deepEqual(bats[1].notes, { 'HR': 'Jacob Keys' });
});

test('parseBoxscore: drops WP and AB columns from the pitching table', () => {
  // Pitching sections are emitted paired to their team's batting table, so the
  // fixture needs a Hitters table for the same team alongside the Pitchers table.
  const html = `
    <table><caption><h2> Gators <span>Batters</span></h2></caption>
      <tr><th>Hitters</th><th>AB</th></tr>
      <tr><th><div><span>cf</span> Ayden Sunday</div></th><td>4</td></tr>
    </table>
    <table><caption><h2> Gators <span>Pitchers</span></h2></caption>
      <tr><th>Pitchers</th><th>IP</th><th>BB</th><th>SO</th><th>HR</th><th>WP</th><th>BF</th><th>AB</th><th>NP</th></tr>
      <tr><th>Sawyer Simmons</th><td>4.0</td><td>2</td><td>7</td><td>0</td><td>1</td><td>18</td><td>15</td><td>74</td></tr>
    </table>`;
  const pit = parseBoxscore(html).box.find(b => /Pitching/.test(b.label)).html;
  assert.doesNotMatch(pit, />\s*WP\s*</);
  assert.doesNotMatch(pit, />\s*AB\s*</);
  // other columns and their values survive (SO is displayed as K, NP as #P)
  assert.match(pit, />\s*K\s*</);
  assert.match(pit, /<td>74<\/td>/); // NP value still present
  assert.doesNotMatch(pit, /<td>15<\/td>/); // AB value dropped
});

test('parseBoxscore: lists the Gators batting/pitching first even when they are the home team', () => {
  const tbl = (team, kind, who) => `<table><caption><h2> ${team} <span>${kind}</span></h2></caption>` +
    (kind === 'Batters'
      ? `<tr><th>Hitters</th><th>AB</th></tr><tr><th><div><span>cf</span> ${who}</div></th><td>1</td></tr></table>`
      : `<tr><th>Pitchers</th><th>IP</th></tr><tr><th>${who}</th><td>9</td></tr></table>`);
  // Document order: opponent (away) first, Gators (home) second.
  const html = tbl('Baton Rouge Rougarou', 'Batters', 'Opp') + tbl('Lake Charles Gumbeaux Gators', 'Batters', 'Gat') +
               tbl('Baton Rouge Rougarou', 'Pitchers', 'OppP') + tbl('Lake Charles Gumbeaux Gators', 'Pitchers', 'GatP');
  const { box } = parseBoxscore(html);
  const isGators = h => /gator/i.test(h);
  const bats = box.filter(b => /Batting/.test(b.label));
  const pits = box.filter(b => /Pitching/.test(b.label));
  assert.equal(isGators(bats[0].html), true);  // Gators batting on top
  assert.equal(isGators(bats[1].html), false);
  assert.equal(isGators(pits[0].html), true);  // Gators pitching before opponent
});

test('parseBoxscore: without a line score, box sections fall back to "Team N"', () => {
  const noLine = `
    <table><tr><th>Visitors Hitters</th></tr><tr><td>Player A</td></tr></table>
    <table><tr><th>Home Hitters</th></tr><tr><td>Player B</td></tr></table>`;
  const { teams, box } = parseBoxscore(noLine);
  assert.deepEqual(teams, []);
  assert.deepEqual(box.map(b => b.label), ['Team 1 ' + DASH + ' Batting', 'Team 2 ' + DASH + ' Batting']);
});

test('parseBoxscore: detects the line score when PrestoSports prefixes it with a "Line Score" caption', () => {
  // The 2026 boxscore pages wrap the R/H/E table in <caption class="offscreen">
  // Line Score</caption>, so its text reads "Line Score Final …" instead of
  // "Final …". Team names must still come through (the report finds the Gators
  // side by label), and the box sections must be labeled with the real teams.
  const html = `
    <table>
      <caption class="offscreen">Line Score</caption>
      <tr><th>Final</th><th>1</th><th>2</th><th>R</th><th>H</th><th>E</th></tr>
      <tr><th>Lake Charles Gumbeaux Gators</th><td>2</td><td>10</td><td>12</td><td>12</td><td>1</td></tr>
      <tr><th>Sherman Shadowcats</th><td>0</td><td>11</td><td>11</td><td>10</td><td>3</td></tr>
    </table>
    <table><tr><th>Hitters</th><th>AB</th></tr><tr><th><div><span>cf</span> Nathan McDonald</div></th><td>5</td></tr></table>
    <table><tr><th>Hitters</th><th>AB</th></tr><tr><th><div><span>ss</span> Zach Fjelstad</div></th><td>4</td></tr></table>`;
  const { teams, box } = parseBoxscore(html);
  assert.deepEqual(teams, ['Lake Charles Gumbeaux Gators', 'Sherman Shadowcats']);
  assert.deepEqual(box.map(b => b.label), [
    'Lake Charles Gumbeaux Gators ' + DASH + ' Batting',
    'Sherman Shadowcats ' + DASH + ' Batting',
  ]);
  assert.ok(box.some(b => /gator/i.test(b.label)), 'Gators side identifiable by label');
});

test('boxErrorResponse: rate-limit/gate statuses are retryable 503s, never a raw code', () => {
  for (const status of [429, 503, 502]) {
    const e = boxErrorResponse(status);
    assert.equal(e.status, 503, `status ${status} -> 503`);
    assert.equal(e.body.retry, true, `status ${status} flagged retryable`);
    // The viewer must never see a bare upstream status code in the message.
    assert.doesNotMatch(e.body.error, new RegExp(String(status)));
    assert.doesNotMatch(e.body.error, /box page/i);
  }
});

test('boxErrorResponse: a genuine failure is a non-retryable 502', () => {
  const e = boxErrorResponse(404);
  assert.equal(e.status, 502);
  assert.equal(e.body.retry, false);
  assert.doesNotMatch(e.body.error, /404/);
});

test('parseBoxscore: attaches each batting section\'s hitter-name -> Presto-slug map (for opponents\' box-score AVG)', () => {
  const html = `
    <table><caption><h2> Baton Rouge Rougarou <span>Batters</span></h2></caption>
      <tr><th>Hitters</th><th>AB</th></tr>
      <tr><th><div><span>cf</span> <a href="/sports/bsb/2026/players/joeyduran9x">Duran, Joey</a></div></th><td>4</td></tr>
    </table>`;
  const { box } = parseBoxscore(html);
  const bat = box.find(b => /Batting/.test(b.label));
  assert.deepEqual(bat.slugs, { 'joey duran': 'joeyduran9x' });
  // The link itself is still stripped from the rendered table (bsClean runs as before).
  assert.doesNotMatch(bat.html, /<a\b/i);
});
