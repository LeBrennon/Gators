'use strict';
// Tests for pick(): which game is featured. A finished game stays featured for
// 10 hours after it ended — anchored to the earlier of when we first observe it
// final and an assumed ~10pm Central end on the game date. A live game always
// wins.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pick, finalIsFresh, noteFinals, finalSeenAt, assumedEndMs } = require('../server');

const HOUR = 3600 * 1000;
const final = (id, date) => ({ id, date, sortKey: +date, state: 'final', away: {}, home: {} });
const sched = (id, date) => ({ id, date, sortKey: +date, state: 'scheduled', away: {}, home: {} });
const live  = (id, date) => ({ id, date, sortKey: +date, state: 'live', away: {}, home: {} });
function reset() { for (const k of Object.keys(finalSeenAt)) delete finalSeenAt[k]; }

test('assumedEndMs: ~10pm CDT is 03:00 UTC next day', () => {
  assert.equal(assumedEndMs('20260621'), Date.UTC(2026, 5, 22, 3, 0, 0));
});

test('finalIsFresh: within 10h of the observed end is fresh', () => {
  reset();
  const end = Date.UTC(2026, 5, 22, 2, 0, 0); // 9pm CDT
  finalSeenAt['g'] = end;
  assert.equal(finalIsFresh(final('g', '20260621'), end + 9 * HOUR), true);
  assert.equal(finalIsFresh(final('g', '20260621'), end + 10 * HOUR), false);
  assert.equal(finalIsFresh(final('g', '20260621'), end + 10 * HOUR - 1), true);
});

test('finalIsFresh: with no stamp, falls back to assumed ~10pm end', () => {
  reset();
  const g = final('g', '20260621');
  const end = assumedEndMs('20260621');
  assert.equal(finalIsFresh(g, end + 5 * HOUR), true);
  assert.equal(finalIsFresh(g, end + 11 * HOUR), false);
});

test('noteFinals: stamps the first time a game is seen final, then leaves it', () => {
  reset();
  const list = [final('g', '20260621')];
  noteFinals(list, 1000);
  noteFinals(list, 5000); // later observation must not overwrite
  assert.equal(finalSeenAt['g'], 1000);
});

test('pick: keeps the final featured right after it ends, over an upcoming game', () => {
  reset();
  const list = [final('f1', '20260621'), sched('s1', '20260623')];
  const end = Date.UTC(2026, 5, 22, 2, 0, 0);
  noteFinals(list, end);
  assert.equal(pick(list, end + 2 * HOUR).id, 'f1');
});

test('pick: switches to the upcoming game 10 hours after the final', () => {
  reset();
  const list = [final('f1', '20260621'), sched('s1', '20260623')];
  const end = Date.UTC(2026, 5, 22, 2, 0, 0);
  noteFinals(list, end);
  assert.equal(pick(list, end + 10 * HOUR).id, 's1');
});

test('pick: a live game beats a sticky final', () => {
  reset();
  const list = [final('f1', '20260621'), live('lv', '20260622')];
  const end = Date.UTC(2026, 5, 22, 2, 0, 0);
  noteFinals(list, end);
  assert.equal(pick(list, end + 1 * HOUR).id, 'lv');
});

test('pick: the most recent fresh final wins among several', () => {
  reset();
  const list = [final('old', '20260620'), final('new', '20260621')];
  const t = Date.UTC(2026, 5, 22, 1, 0, 0);
  noteFinals(list, t);
  assert.equal(pick(list, t + 1 * HOUR).id, 'new');
});

test('pick: a restart that stamps an old final with "now" does not refresh its 10h window', () => {
  reset();
  const list = [final('f1', '20260621'), sched('s1', '20260623')];
  // Simulate a restart at ~1pm CDT on 6/22: noteFinals stamps the already-final
  // 6/21 game with the restart time, hours after it actually ended the night
  // before. The anchor must fall back to the assumed ~10pm end, so the game is
  // already stale and the next scheduled game takes over.
  const restart = Date.UTC(2026, 5, 22, 18, 0, 0);
  noteFinals(list, restart);
  assert.equal(pick(list, restart).id, 's1');
});

test('pick: cold-start fallback keeps a recent final up without a stamp', () => {
  reset(); // no noteFinals — simulates a restart
  const list = [final('f1', '20260621'), sched('s1', '20260623')];
  const end = assumedEndMs('20260621');
  assert.equal(pick(list, end + 3 * HOUR).id, 'f1'); // still within 10h
  assert.equal(pick(list, end + 11 * HOUR).id, 's1'); // past the window
});
