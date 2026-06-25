'use strict';
// Tests for batterPriorPAs(): pulling a batter's completed plate appearances
// out of the live play-by-play so the at-bat card can show "what they've done
// today". Narratives use the real live-feed shape (name leads, count in parens).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { batterPriorPAs } = require('../server');

const play = (inning, text) => ({ inning, half: inning % 2 ? 'top' : 'bot', team: 'X', outs: 0, text });

// A real half-inning's worth of plays (Gators batting, from the live feed).
const PLAYS = [
  play(1, 'Bankston Lembcke struck out swinging (1-2 KFFS).'),
  play(3, 'Bankston Lembcke lined out to cf (0-1 K).'),
  play(3, 'Kasen Bellard singled to left field (3-1 BFBB).'),
  play(3, 'Reid Snider popped up to 3b (0-1 F).'),
  play(3, 'Kasen Bellard stole second.'),
  play(3, 'Ayden Sunday singled to first base, RBI (1-2 KFB); Kasen Bellard scored.'),
];

test('batterPriorPAs: lists a batter\'s plate appearances in order, cleaned up', () => {
  const prev = batterPriorPAs(PLAYS, 'Bankston Lembcke');
  assert.deepEqual(prev, [
    { inn: '1st', res: 'Struck out swinging' },
    { inn: '3rd', res: 'Lined out to center' },
  ]);
});

test('batterPriorPAs: skips baserunning sub-rows (stole/scored), keeps the at-bat', () => {
  const prev = batterPriorPAs(PLAYS, 'Kasen Bellard');
  // The single counts; "stole second" and being a scoring runner do not.
  assert.deepEqual(prev, [{ inn: '3rd', res: 'Singled to left' }]);
});

test('batterPriorPAs: a runner named only mid-narrative is not credited a PA', () => {
  // "Kasen Bellard scored" appears inside Ayden Sunday's line; it is not Sunday's
  // doing and must not show up for Bellard as an extra PA (already covered above),
  // nor should Sunday's own single drop because of the trailing runner clause.
  const prev = batterPriorPAs(PLAYS, 'Ayden Sunday');
  // The ", RBI" and trailing "; Kasen Bellard scored" clauses are dropped.
  assert.deepEqual(prev, [{ inn: '3rd', res: 'Singled to first base' }]);
});

test('batterPriorPAs: no prior at-bats yields an empty list', () => {
  assert.deepEqual(batterPriorPAs(PLAYS, 'Gene Trujillo'), []);
  assert.deepEqual(batterPriorPAs([], 'Anyone'), []);
  assert.deepEqual(batterPriorPAs(PLAYS, ''), []);
});
