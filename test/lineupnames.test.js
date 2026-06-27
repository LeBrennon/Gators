'use strict';
// Regression tests for live-lineup player names.
//
// The batting-order entry's name (o.name) that PrestoSports sends is unreliable:
// some players come through garbled ("B. ton Lembcke") or as a bare initial
// ("G."). The player record's revname ("Lembcke, Bankston") is canonical, so
// lineupsFromFeed must derive the display name from it. The client then renders
// "First Last" as "F. Last" via abbrName (defined in the embedded page script).
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lineupsFromFeed } = require('../server');

const feedWith = player => ({
  team: [{
    vh: 'V', teamId: 'opp', name: 'Bombers',
    player: [player],
    batords: { batord: [{ uni: player.uni, spot: '3', pos: '1B', name: player.name }] },
  }],
});

test('lineupsFromFeed: rebuilds a clean name from revname, not the garbled order name', () => {
  const rows = lineupsFromFeed(feedWith({
    uni: '21', name: 'B. ton Lembcke', revname: 'Lembcke, Bankston', hitting: { ab: '2', h: '0' },
  }))[0].rows;
  assert.equal(rows[0].name, 'Bankston Lembcke');
});

test('lineupsFromFeed: a bare-initial order name is replaced by the full revname', () => {
  const rows = lineupsFromFeed(feedWith({
    uni: '7', name: 'G.', revname: 'Garcia, Gabe', hitting: { ab: '3', h: '0' },
  }))[0].rows;
  assert.equal(rows[0].name, 'Gabe Garcia');
});

test('lineupsFromFeed: falls back to p.name when there is no revname', () => {
  const rows = lineupsFromFeed(feedWith({
    uni: '9', name: 'Reid Snider', hitting: { ab: '1', h: '1' },
  }))[0].rows;
  assert.equal(rows[0].name, 'Reid Snider');
});

// The client-side abbrName lives inside the APP template string, so pull it out
// of the source and evaluate it to guard its behavior.
test('abbrName: first initial + last name, handling all the real-world shapes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const m = src.match(/function abbrName\(n\)\{[\s\S]*?\n\}/);
  assert.ok(m, 'abbrName function not found in server.js');
  // eslint-disable-next-line no-eval
  const abbrName = eval('(' + m[0] + ')');
  assert.equal(abbrName('Bankston Lembcke'), 'B. Lembcke');
  assert.equal(abbrName('Nathan McDonald'), 'N. McDonald');
  assert.equal(abbrName('Jaxon Landreneau'), 'J. Landreneau');
  assert.equal(abbrName('Lembcke, Bankston'), 'B. Lembcke');  // Last, First
  assert.equal(abbrName('L. Dunn'), 'L. Dunn');               // already short
  assert.equal(abbrName('Ken Griffey Jr.'), 'K. Griffey');    // trailing suffix
  assert.equal(abbrName('Madonna'), 'Madonna');               // single token
  assert.equal(abbrName(''), '');
});
