'use strict';
// Tests for feedGameOver(): detecting a finished game from the live feed before
// PrestoSports flips its "complete" flag or the schedule text says "Final".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { feedGameOver } = require('../server');

const L = (over) => Object.assign({ complete: false, inning: '9', schedInn: 9, half: 'Bottom', outs: 3 }, over);

test('feedGameOver: the real stuck case — 3 outs, bottom 11th, away ahead', () => {
  assert.equal(feedGameOver({ complete: false, inning: '11', schedInn: 9, half: 'Bottom', outs: 3 }, 12, 11), true);
});

test('feedGameOver: complete flag short-circuits to true', () => {
  assert.equal(feedGameOver({ complete: true, inning: '3', schedInn: 9, half: 'Top', outs: 1 }, 0, 0), true);
});

test('feedGameOver: mid-game three outs before the final inning is not over', () => {
  assert.equal(feedGameOver(L({ inning: '5', outs: 3 }), 4, 2), false);
});

test('feedGameOver: fewer than three outs is not over', () => {
  assert.equal(feedGameOver(L({ inning: '9', outs: 2 }), 5, 4), false);
});

test('feedGameOver: tied in the final inning keeps playing (extra innings)', () => {
  assert.equal(feedGameOver(L({ inning: '9', half: 'Bottom', outs: 3 }), 5, 5), false);
});

test('feedGameOver: bottom-half 3rd out while home is behind ends it (away wins)', () => {
  assert.equal(feedGameOver(L({ inning: '9', half: 'Bottom', outs: 3 }), 6, 3), true);
});

test('feedGameOver: bottom-half 3rd out but away is behind is not over via outs', () => {
  // home leads in the bottom — a walk-off would carry the complete flag instead
  assert.equal(feedGameOver(L({ inning: '9', half: 'Bottom', outs: 3 }), 3, 6), false);
});

test('feedGameOver: top-half 3rd out with home ahead ends it (home wins, no bottom)', () => {
  assert.equal(feedGameOver(L({ inning: '9', half: 'Top', outs: 3 }), 2, 5), true);
});

test('feedGameOver: top-half 3rd out with away ahead is not over (home still bats)', () => {
  assert.equal(feedGameOver(L({ inning: '9', half: 'Top', outs: 3 }), 5, 2), false);
});

test('feedGameOver: respects a 7-inning scheduled game', () => {
  assert.equal(feedGameOver(L({ inning: '7', schedInn: 7, half: 'Bottom', outs: 3 }), 8, 1), true);
});

test('feedGameOver: null live returns false', () => {
  assert.equal(feedGameOver(null, 1, 0), false);
});
