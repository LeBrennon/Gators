'use strict';
// Tests for strikeCounts(): reading per-at-bat pitch strings out of play-by-play
// text to tally pitches and strikes for the season strike% aggregate. Pitch
// strings and counts here mirror the real PrestoSports format (e.g. "(2-2 KBKBK)").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { strikeCounts } = require('../server');

test('strikeCounts: a strikeout sequence — B/H/P are balls, the rest strikes', () => {
  // KBKBK = 3 strikes (K), 2 balls (B); 5 pitches.
  assert.deepEqual(strikeCounts('struck out looking (2-2 KBKBK). (2 out)'), { pitches: 5, strikes: 3 });
});

test('strikeCounts: fouls count as strikes; a walk is all balls', () => {
  assert.deepEqual(strikeCounts('flied out to lf (1-2 KKBF).'), { pitches: 4, strikes: 3 }); // K,K,F strikes; B ball
  assert.deepEqual(strikeCounts('walked (3-1 BBKB).'), { pitches: 4, strikes: 1 });          // one K, three B
});

test('strikeCounts: hit-by-pitch (H) counts as a ball', () => {
  // KFFH -> K,F,F strikes (3), H ball (1)
  assert.deepEqual(strikeCounts('hit by pitch (1-2 KFFH).'), { pitches: 4, strikes: 3 });
});

test('strikeCounts: a bare (0-0) is a first-pitch ball in play — one strike', () => {
  assert.deepEqual(strikeCounts('flied out to rf (0-0). (3 out)'), { pitches: 1, strikes: 1 });
});

test('strikeCounts: tallies multiple at-bats in one chunk', () => {
  const html = '<td>singled (0-1 K).</td><td>doubled (2-2 BKFB).</td><td>grounded out (0-0).</td>';
  // (0-1 K): 1 pitch/1 strike; (2-2 BKFB): 4 pitches, B,B balls -> 2 strikes; (0-0): 1/1
  assert.deepEqual(strikeCounts(html), { pitches: 6, strikes: 4 });
});

test('strikeCounts: ignores fielding notations that look like a count (6-3)', () => {
  // "6-3" is not a valid baseball count (max 3-2), so it must not be read as one.
  assert.deepEqual(strikeCounts('grounded into a double play (6-3).'), { pitches: 0, strikes: 0 });
});

test('strikeCounts: empty / no pitch data', () => {
  assert.deepEqual(strikeCounts(''), { pitches: 0, strikes: 0 });
  assert.deepEqual(strikeCounts('Smith to p for Jones.'), { pitches: 0, strikes: 0 });
});
