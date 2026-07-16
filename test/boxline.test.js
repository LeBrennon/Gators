'use strict';
// lineScoreFromPbp()/resolveGenericLabels()/ensureLineScore(): build the box's
// line score (and recover the box sections' real team names) from the play-by-play
// when PrestoSports hasn't rendered its own line-score table yet — the lag that
// otherwise blocks a box built right after the last out. Modeled on a real game:
// Gators (visitor) 2, Baton Rouge Rougarou (home) 9, home team not batting the 9th.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lineScoreFromPbp, resolveGenericLabels, ensureLineScore, omittedBatter } = require('../scripts/box-score');

// A half-inning entry as /api/boxscore delivers it: a title with the batting team
// + Top/Bottom + inning, and an html body ending in the "Inning Summary" line.
const half = (team, side, inn, r, h, e, batters) =>
  ({ title: `${team} ${side} of ${inn}${inn === 1 ? 'st' : inn === 2 ? 'nd' : inn === 3 ? 'rd' : 'th'} Inning`,
     html: `<div>${(batters || []).map(b => `${b} singled.`).join(' ')} Inning Summary: ${r} Runs , ${h} Hits , ${e} Errors , 0 LOB</div>` });

const GATORS = 'Lake Charles Gumbeaux Gators';
const ROUGAROU = 'Baton Rouge Rougarou';

function sampleData() {
  const pbp = [
    half(GATORS, 'Top', 1, 0, 0, 0, ['Lane Sparks', 'Ayden Sunday']),
    half(ROUGAROU, 'Bottom', 1, 1, 1, 0, ['Dathan Cummings', 'Ty Simonelli']),
    half(GATORS, 'Top', 2, 2, 2, 0, ['Reid Snider']),
    half(ROUGAROU, 'Bottom', 2, 0, 0, 1, ['Trip Dobson']),
    // Gators bat the 3rd (top); home team already leads, no bottom of the 3rd.
    half(GATORS, 'Top', 3, 0, 0, 0, ['Kash Martin']),
  ];
  const box = [
    { label: 'Team 1 — Batting', html: '<table><tr><th>Hitters</th></tr><tr><th>Lane Sparks</th></tr><tr><th>Ayden Sunday</th></tr><tr><th>Reid Snider</th></tr><tr><th>Kash Martin</th></tr></table>' },
    { label: 'Team 1 — Pitching', html: '<table><tr><th>Pitchers</th></tr><tr><th>Kale Cropper</th></tr></table>' },
    { label: 'Team 2 — Batting', html: '<table><tr><th>Hitters</th></tr><tr><th>Dathan Cummings</th></tr><tr><th>Ty Simonelli</th></tr><tr><th>Trip Dobson</th></tr></table>' },
    { label: 'Team 2 — Pitching', html: '<table><tr><th>Pitchers</th></tr><tr><th>Michael Sutton</th></tr></table>' },
  ];
  return { line: '', box, pbp };
}

test('lineScoreFromPbp: builds the runs-by-inning grid with R/H/E and an X for the un-batted half', () => {
  const line = lineScoreFromPbp(sampleData());
  assert.match(line, /<table>/);
  // Visitor (Gators) row: 0, 2, 0 across three innings, R=2 H=2. Errors charge to
  // the fielding side, so the home team's Bottom-2nd error lands on the Gators: E=1.
  assert.match(line, new RegExp(`<th>${GATORS}</th><td>0</td><td>2</td><td>0</td><td>2</td><td>2</td><td>1</td>`));
  // Home (Rougarou) row: batted the 1st and 2nd only; the 3rd is 'X'. R=1 H=1 E=0.
  assert.match(line, new RegExp(`<th>${ROUGAROU}</th><td>1</td><td>0</td><td>X</td><td>1</td><td>1</td><td>0</td>`));
});

test('lineScoreFromPbp: the fielding side is charged the errors, not the batting side', () => {
  const line = lineScoreFromPbp(sampleData());
  // Visitor E column (last <td> of its row) is 1 — the error committed while the
  // home team batted the 2nd. Home E is 0.
  assert.match(line, new RegExp(`<th>${GATORS}</th>(?:<td>[^<]*</td>)*<td>1</td></tr>`));
  assert.match(line, new RegExp(`<th>${ROUGAROU}</th>(?:<td>[^<]*</td>)*<td>0</td></tr>`));
});

test('resolveGenericLabels: renames Team 1/Team 2 to the real teams via pbp batter matching', () => {
  const data = sampleData();
  resolveGenericLabels(data);
  const labels = data.box.map(b => b.label);
  assert.deepEqual(labels, [
    `${GATORS} — Batting`, `${GATORS} — Pitching`,
    `${ROUGAROU} — Batting`, `${ROUGAROU} — Pitching`,
  ]);
});

test('resolveGenericLabels: leaves already-named sections untouched', () => {
  const data = { line: '', pbp: sampleData().pbp,
    box: [{ label: `${GATORS} — Batting`, html: '<table></table>' }] };
  resolveGenericLabels(data);
  assert.equal(data.box[0].label, `${GATORS} — Batting`);
});

test('omittedBatter: reports the Totals-minus-rows gap when the source drops a batter', () => {
  // 2 listed hitters (AB 4+3=7, K 1+2=3) but Totals say AB 10, K 4 — one 3-AB, 1-K
  // batter (the pitcher's spot after a forfeited DH) was dropped by the source.
  const html = `<table>
    <tr><th>Hitters</th><th>AB</th><th>R</th><th>H</th><th>RBI</th><th>BB</th><th>K</th><th>LOB</th></tr>
    <tr><th>Lane Sparks</th><td>4</td><td>1</td><td>1</td><td>0</td><td>0</td><td>1</td><td>1</td></tr>
    <tr><th>Shyler Smith</th><td>3</td><td>0</td><td>0</td><td>0</td><td>0</td><td>2</td><td>0</td></tr>
    <tr><th>Totals</th><td>10</td><td>1</td><td>1</td><td>0</td><td>0</td><td>4</td><td>1</td></tr>
  </table>`;
  assert.deepEqual(omittedBatter(html), { AB: 3, R: 0, H: 0, RBI: 0, BB: 0, K: 1 });
});

test('omittedBatter: returns null when the rows already sum to the Totals', () => {
  const html = `<table>
    <tr><th>Hitters</th><th>AB</th><th>R</th><th>H</th><th>RBI</th><th>BB</th><th>K</th><th>LOB</th></tr>
    <tr><th>Lane Sparks</th><td>4</td><td>1</td><td>1</td><td>0</td><td>0</td><td>1</td><td>1</td></tr>
    <tr><th>Shyler Smith</th><td>3</td><td>0</td><td>0</td><td>0</td><td>0</td><td>2</td><td>0</td></tr>
    <tr><th>Totals</th><td>7</td><td>1</td><td>1</td><td>0</td><td>0</td><td>3</td><td>1</td></tr>
  </table>`;
  assert.equal(omittedBatter(html), null);
});

test('ensureLineScore: fills a missing line score and resolves labels; no-op when one exists', () => {
  const data = sampleData();
  ensureLineScore(data);
  assert.ok(data.line && /<table>/.test(data.line), 'line score synthesized');
  assert.match(data.box[0].label, new RegExp(GATORS));

  const withLine = { line: '<table><tr><th>Final</th></tr></table>', box: sampleData().box, pbp: sampleData().pbp };
  const before = withLine.line;
  ensureLineScore(withLine);
  assert.equal(withLine.line, before, 'existing line score left as-is');
  assert.match(withLine.box[0].label, /^Team 1/, 'labels untouched when a real line score is present');
});
