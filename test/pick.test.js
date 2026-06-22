'use strict';
// Tests for pick(): which game is featured. A finished game stays featured
// until 10am Central the day after it was played, then the next scheduled
// game takes over. A live game always wins; a pinned game (not exercised here)
// wins above all.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pick, finalIsFresh, nextYmd } = require('../server');

const final = (id, date) => ({ id, date, sortKey: +date, state: 'final', away: {}, home: {} });
const sched = (id, date) => ({ id, date, sortKey: +date, state: 'scheduled', away: {}, home: {} });
const live  = (id, date) => ({ id, date, sortKey: +date, state: 'live', away: {}, home: {} });

test('nextYmd: rolls day, month, and year', () => {
  assert.equal(nextYmd('20260621'), '20260622');
  assert.equal(nextYmd('20260630'), '20260701');
  assert.equal(nextYmd('20261231'), '20270101');
});

test('finalIsFresh: same day the game was played', () => {
  assert.equal(finalIsFresh('20260621', { ymd: '20260621', hour: 23 }), true);
});

test('finalIsFresh: next day before 10am is still fresh', () => {
  assert.equal(finalIsFresh('20260621', { ymd: '20260622', hour: 9 }), true);
});

test('finalIsFresh: next day at/after 10am is stale', () => {
  assert.equal(finalIsFresh('20260621', { ymd: '20260622', hour: 10 }), false);
  assert.equal(finalIsFresh('20260621', { ymd: '20260622', hour: 14 }), false);
});

test('finalIsFresh: two days later is stale', () => {
  assert.equal(finalIsFresh('20260621', { ymd: '20260623', hour: 1 }), false);
});

test('pick: keeps the final featured the night it ends, over an upcoming game', () => {
  const list = [final('f1', '20260621'), sched('s1', '20260623')];
  const chosen = pick(list, { ymd: '20260621', hour: 22 });
  assert.equal(chosen.id, 'f1');
});

test('pick: still shows the final next morning before 10am', () => {
  const list = [final('f1', '20260621'), sched('s1', '20260623')];
  const chosen = pick(list, { ymd: '20260622', hour: 8 });
  assert.equal(chosen.id, 'f1');
});

test('pick: switches to the upcoming game at 10am the next day', () => {
  const list = [final('f1', '20260621'), sched('s1', '20260623')];
  const chosen = pick(list, { ymd: '20260622', hour: 10 });
  assert.equal(chosen.id, 's1');
});

test('pick: a live game beats a sticky final', () => {
  const list = [final('f1', '20260621'), live('lv', '20260622')];
  const chosen = pick(list, { ymd: '20260622', hour: 9 });
  assert.equal(chosen.id, 'lv');
});

test('pick: the most recent fresh final wins among several', () => {
  const list = [final('old', '20260620'), final('new', '20260621')];
  const chosen = pick(list, { ymd: '20260621', hour: 20 });
  assert.equal(chosen.id, 'new');
});

test('pick: falls back to the latest final when nothing is scheduled and all are stale', () => {
  const list = [final('f1', '20260601'), final('f2', '20260602')];
  const chosen = pick(list, { ymd: '20260620', hour: 12 });
  assert.equal(chosen.id, 'f2');
});
