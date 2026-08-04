'use strict';
// A two-way player bats on days he also pitches. The Hitters table used to lose
// his line because every name in the Pitchers table was dropped from it, which
// erased those plate appearances from the box and from his season card
// (Griffin Hebert 6, Jack Garcille 5, Lane Sparks 4, Marco Bandiero 4).
// A pitcher's row is now dropped only when it is an empty 0-for-0 artifact.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseBoxscore } = require('../server');

const page = (hitterRows) => `
<table><caption>Line Score</caption>
  <tr><th>Final</th><th>1</th><th>R</th><th>H</th><th>E</th></tr>
  <tr><th>Lake Charles Gumbeaux Gators</th><td>1</td><td>1</td><td>4</td><td>0</td></tr>
  <tr><th>Sherman Shadowcats</th><td>0</td><td>0</td><td>2</td><td>1</td></tr>
</table>
<table><caption><h2>Gators <span>Batters</span></h2></caption>
  <tr><th>Hitters</th><th>AB</th><th>R</th><th>H</th><th>RBI</th><th>BB</th><th>K</th><th>LOB</th></tr>
  ${hitterRows}
</table>
<table><caption><h2>Gators <span>Pitchers</span></h2></caption>
  <tr><th>Pitchers</th><th>IP</th><th>H</th><th>R</th><th>ER</th><th>BB</th><th>K</th></tr>
  <tr><th><div>Marco Bandiero</div></th><td>1.0</td><td>2</td><td>1</td><td>1</td><td>0</td><td>3</td></tr>
</table>`;

const battingRows = (html) => {
  const sec = parseBoxscore(html).box.find(b => /Batting/.test(b.label));
  return (sec.html.match(/<tr\b[\s\S]*?<\/tr>/gi) || []).map(r => r.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
};

test('a two-way player keeps his hitting line on a day he also pitched', () => {
  const rows = battingRows(page(`
    <tr><th><div><span>cf</span> Ayden Sunday</div></th><td>4</td><td>1</td><td>2</td><td>1</td><td>0</td><td>1</td><td>2</td></tr>
    <tr><th><div><span>1b</span> Marco Bandiero</div></th><td>3</td><td>0</td><td>1</td><td>0</td><td>1</td><td>1</td><td>0</td></tr>`));
  assert.ok(rows.some(r => r.includes('Marco Bandiero')), 'his batting line must survive');
  assert.ok(rows.some(r => r.includes('Ayden Sunday')));
});

test('an empty 0-for-0 pitcher line is still dropped', () => {
  const rows = battingRows(page(`
    <tr><th><div><span>cf</span> Ayden Sunday</div></th><td>4</td><td>1</td><td>2</td><td>1</td><td>0</td><td>1</td><td>2</td></tr>
    <tr><th><div>Marco Bandiero</div></th><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>`));
  assert.ok(!rows.some(r => r.includes('Marco Bandiero')), 'an all-zero pitcher row is an artifact');
});

test('a row whose position reads "p" is dropped when empty, kept when he hit', () => {
  const dropped = battingRows(page(
    `<tr><th><div><span>p</span> Marco Bandiero</div></th><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>`));
  assert.equal(dropped.filter(r => r.includes('Bandiero')).length, 0);
  const kept = battingRows(page(
    `<tr><th><div><span>p</span> Marco Bandiero</div></th><td>2</td><td>0</td><td>1</td><td>0</td><td>0</td><td>0</td><td>0</td></tr>`));
  assert.equal(kept.filter(r => r.includes('Bandiero')).length, 1);
});
