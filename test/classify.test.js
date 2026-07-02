'use strict';
// Tests for classify(): mapping schedule-row text to { state, status }.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../server');

test('classify: postponed / suspended / cancelled', () => {
  assert.deepEqual(classify('Game Postponed'), { state: 'postponed', status: 'Postponed' });
  assert.deepEqual(classify('Suspended'), { state: 'suspended', status: 'Suspended' });
  // Accepts both "Canceled" and "Cancelled" spellings.
  assert.deepEqual(classify('Canceled'), { state: 'cancelled', status: 'Cancelled' });
  assert.deepEqual(classify('Cancelled'), { state: 'cancelled', status: 'Cancelled' });
});

test('classify: forfeit counts as final', () => {
  assert.deepEqual(classify('Forfeit'), { state: 'final', status: 'Forfeit' });
});

test('classify: final, with and without a non-regulation innings annotation', () => {
  // No annotation, or an explicit 9, both mean a regulation 9-inning game.
  assert.deepEqual(classify('Final'), { state: 'final', status: 'Final' });
  assert.deepEqual(classify('Final 9 innings'), { state: 'final', status: 'Final' });
  // Extra innings and a mercy-rule/rain-shortened game both get annotated.
  assert.deepEqual(classify('Final 10 innings'), { state: 'final', status: 'Final/10' });
  assert.deepEqual(classify('Final 7 innings'), { state: 'final', status: 'Final/7' });
});

test('classify: live half-inning states', () => {
  assert.deepEqual(classify('Top 3'), { state: 'live', status: 'Top of 3rd' });
  assert.deepEqual(classify('Bottom of 7th'), { state: 'live', status: 'Bottom of 7th' });
  assert.deepEqual(classify('Middle 5'), { state: 'live', status: 'Mid of 5th' });
  assert.deepEqual(classify('End of 8'), { state: 'live', status: 'End of 8th' });
});

test('classify: delay is treated as live', () => {
  assert.deepEqual(classify('Delayed'), { state: 'live', status: 'Delay' });
});

test('classify: scheduled with a start time, else generic Scheduled', () => {
  assert.deepEqual(classify('7:05 PM CT'), { state: 'scheduled', status: '7:05 PM CT' });
  assert.deepEqual(classify('nothing useful here'), { state: 'scheduled', status: 'Scheduled' });
});

test('classify: Final takes precedence over a time also present', () => {
  assert.equal(classify('Final 7:05 PM').state, 'final');
});
