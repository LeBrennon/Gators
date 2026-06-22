'use strict';
// Fixture-based tests for parseBoxscore(): bucketing the boxscore page's tables
// into line score / batting / pitching / play-by-play, naming the box sections
// from the line-score teams, and stripping markup noise via bsClean.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseBoxscore } = require('../server');

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

test('parseBoxscore: builds labeled box sections (batting then pitching)', () => {
  const { box } = parseBoxscore(HTML);
  assert.equal(box.length, 3);
  assert.deepEqual(box.map(b => b.label), [
    'Acadiana Cane Cutters ' + DASH + ' Batting',
    'Lake Charles Gumbeaux Gators ' + DASH + ' Batting',
    'Acadiana Cane Cutters ' + DASH + ' Pitching',
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
  const awayBatting = box[0].html;
  assert.match(awayBatting, /Smith, John/);
  assert.doesNotMatch(awayBatting, /<a\b/i);
  assert.doesNotMatch(awayBatting, /<img/i);
  // <strong>(L)</strong> in the pitching table becomes <b>(L)</b>.
  const awayPitching = box[2].html;
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

test('parseBoxscore: keeps the pitcher hitting row when there is no DH (pitcher batted)', () => {
  const html = `
    <table>
      <tr><th>Hitters</th><th>AB</th></tr>
      <tr><th><div><span>cf</span> Ayden Sunday</div></th><td>4</td></tr>
      <tr><th><div><span>p</span> Jack Garcille</div></th><td>3</td></tr>
    </table>`;
  const batting = parseBoxscore(html).box.find(b => /Batting/.test(b.label)).html;
  assert.match(batting, /Jack Garcille/);
});

test('parseBoxscore: without a line score, box sections fall back to "Team N"', () => {
  const noLine = `
    <table><tr><th>Visitors Hitters</th></tr><tr><td>Player A</td></tr></table>
    <table><tr><th>Home Hitters</th></tr><tr><td>Player B</td></tr></table>`;
  const { teams, box } = parseBoxscore(noLine);
  assert.deepEqual(teams, []);
  assert.deepEqual(box.map(b => b.label), ['Team 1 ' + DASH + ' Batting', 'Team 2 ' + DASH + ' Batting']);
});
