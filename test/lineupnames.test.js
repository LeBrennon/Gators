'use strict';
// Regression tests for live-lineup player names.
//
// The batting-order entry's name (o.name) that PrestoSports sends is unreliable:
// some players come through garbled or as a bare initial. The player record's
// revname ("Lembcke, Bankston") is canonical, so lineupsFromFeed derives a clean
// full name from it (kept on `full` for profile links + current-batter matching)
// and formats the display `name` server-side as ESPN-style "F. Last" so a stale
// browser can't render it wrong.
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

test('lineupsFromFeed: display name is server-formatted "F. Last"; full name is kept', () => {
  const r = lineupsFromFeed(feedWith({
    uni: '21', name: 'B. ton Lembcke', revname: 'Lembcke, Bankston', hitting: { ab: '2', h: '0' },
  }))[0].rows[0];
  assert.equal(r.name, 'B. Lembcke');        // what the page prints
  assert.equal(r.full, 'Bankston Lembcke');  // for profile link + current-batter match
});

test('lineupsFromFeed: a bare-initial order name is recovered from revname', () => {
  const r = lineupsFromFeed(feedWith({
    uni: '7', name: 'G.', revname: 'Garcia, Gabe', hitting: { ab: '3', h: '0' },
  }))[0].rows[0];
  assert.equal(r.name, 'G. Garcia');
  assert.equal(r.full, 'Gabe Garcia');
});

test('lineupsFromFeed: falls back to p.name when there is no revname', () => {
  const r = lineupsFromFeed(feedWith({
    uni: '9', name: 'Reid Snider', hitting: { ab: '1', h: '1' },
  }))[0].rows[0];
  assert.equal(r.name, 'R. Snider');
  assert.equal(r.full, 'Reid Snider');
});

test('lineupsFromFeed: drops a trailing generational suffix when abbreviating', () => {
  const r = lineupsFromFeed(feedWith({
    uni: '5', name: 'Ken Griffey Jr.', revname: 'Griffey, Ken', hitting: { ab: '2', h: '1' },
  }))[0].rows[0];
  assert.equal(r.name, 'K. Griffey');
});
