'use strict';
// The box-score pre-stage (server.js) retains the live pitching feed from the 8th
// inning on so the finished box still reconciles after Presto empties the feed at
// the last out. Lock the two decisions that gate it: which feeds are usable
// (feedHasPitching) and when retention/serving kicks in (atBoxPrestage). Getting
// feedHasPitching wrong would either drop good pitching or overwrite it with an
// empty post-final feed; getting atBoxPrestage wrong would start too early/late.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { feedHasPitching, atBoxPrestage } = require('../server');

test('feedHasPitching: true only when a side still carries pitcher rows', () => {
  assert.equal(feedHasPitching([{ isGators: true, rows: [{ name: 'Kotlarz', ip: '7.0' }] }]), true);
  assert.equal(feedHasPitching([{ rows: [] }, { rows: [{ name: 'X' }] }]), true); // one side is enough
});

test('feedHasPitching: false for empty / degenerate feeds (never overwrite good data)', () => {
  assert.equal(feedHasPitching(null), false);
  assert.equal(feedHasPitching(undefined), false);
  assert.equal(feedHasPitching([]), false);
  assert.equal(feedHasPitching([{}]), false);
  assert.equal(feedHasPitching([{ rows: [] }]), false);
  assert.equal(feedHasPitching([{ rows: [] }, { rows: [] }]), false); // post-final: feed went dark
});

test('atBoxPrestage: a 9-inning game starts retaining at the bottom (middle) of the 8th', () => {
  const g = (inn, half) => ({ inning: inn, half, live: { schedInn: 9 } });
  assert.equal(atBoxPrestage(g(7, 'bottom')), false);
  assert.equal(atBoxPrestage(g(8, 'top')), false);     // top of 8th: not yet the middle
  assert.equal(atBoxPrestage(g(8, 'bottom')), true);   // bottom of 8th: the middle
  assert.equal(atBoxPrestage(g(9, 'top')), true);      // into the final scheduled inning
  assert.equal(atBoxPrestage(g(10, 'top')), true);     // extra innings
});

test('atBoxPrestage: a 7-inning game (doubleheader) starts at the bottom of the 6th', () => {
  const g = (inn, half) => ({ inning: inn, half, live: { schedInn: 7 } });
  assert.equal(atBoxPrestage(g(5, 'bottom')), false);
  assert.equal(atBoxPrestage(g(6, 'top')), false);
  assert.equal(atBoxPrestage(g(6, 'bottom')), true);
  assert.equal(atBoxPrestage(g(7, 'top')), true);
});

test('atBoxPrestage: defaults to a 9-inning game when schedInn is unknown', () => {
  assert.equal(atBoxPrestage({ inning: 8, half: 'bottom' }), true);
  assert.equal(atBoxPrestage({ inning: 8, half: 'top' }), false);
  assert.equal(atBoxPrestage({ inning: 7, half: 'bottom' }), false);
  assert.equal(atBoxPrestage({}), false);      // pregame / no inning
  assert.equal(atBoxPrestage(null), false);
});
