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

test('atBoxPrestage: a 9-inning game starts retaining in the 8th', () => {
  const g = inn => ({ inning: inn, live: { schedInn: 9 } });
  assert.equal(atBoxPrestage(g(7)), false);
  assert.equal(atBoxPrestage(g(8)), true);
  assert.equal(atBoxPrestage(g(9)), true);
  assert.equal(atBoxPrestage(g(10)), true); // extra innings
});

test('atBoxPrestage: a 7-inning game (doubleheader) starts in the 6th', () => {
  const g = inn => ({ inning: inn, live: { schedInn: 7 } });
  assert.equal(atBoxPrestage(g(5)), false);
  assert.equal(atBoxPrestage(g(6)), true);
  assert.equal(atBoxPrestage(g(7)), true);
});

test('atBoxPrestage: defaults to a 9-inning game when schedInn is unknown', () => {
  assert.equal(atBoxPrestage({ inning: 8 }), true);
  assert.equal(atBoxPrestage({ inning: 7 }), false);
  assert.equal(atBoxPrestage({}), false);      // pregame / no inning
  assert.equal(atBoxPrestage(null), false);
});
