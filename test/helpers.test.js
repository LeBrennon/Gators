'use strict';
// Unit tests for the small pure helpers in server.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ordinal, cap, shortName, fullName, scoreBetween, inningParts, dateFromId } = require('../server');

test('ordinal: standard suffixes', () => {
  assert.equal(ordinal(1), '1st');
  assert.equal(ordinal(2), '2nd');
  assert.equal(ordinal(3), '3rd');
  assert.equal(ordinal(4), '4th');
});

test('ordinal: 11/12/13 are "th" not "st/nd/rd"', () => {
  assert.equal(ordinal(11), '11th');
  assert.equal(ordinal(12), '12th');
  assert.equal(ordinal(13), '13th');
  assert.equal(ordinal(21), '21st');
});

test('cap: title-cases a single word and tolerates empty', () => {
  assert.equal(cap('top'), 'Top');
  assert.equal(cap('BOTTOM'), 'Bottom');
  assert.equal(cap(''), '');
});

test('fullName: known id wins, falls back to scraped name, then TBD', () => {
  // Lake Charles Gumbeaux Gators id from the TEAMS map.
  assert.equal(fullName('et1bt9sixrz5lnnl', 'whatever'), 'Lake Charles Gumbeaux Gators');
  assert.equal(fullName('unknownid', '  Some Town Sluggers '), 'Some Town Sluggers');
  assert.equal(fullName('unknownid', ''), 'TBD');
});

test('shortName: known id wins, else last two words of scraped name', () => {
  assert.equal(shortName('et1bt9sixrz5lnnl', 'ignored'), 'Gators');
  assert.equal(shortName('unknownid', 'Some Town Sluggers'), 'Town Sluggers');
  assert.equal(shortName('unknownid', 'Sluggers'), 'Sluggers');
  assert.equal(shortName('unknownid', ''), 'TBD');
});

test('scoreBetween: first plausible run total in a range, else null', () => {
  const s = '<td>5</td><td>3</td>';
  assert.equal(scoreBetween(s, 0), 5);
  // A value above the 0..50 sanity cap is skipped.
  assert.equal(scoreBetween('<td>999</td><td>7</td>', 0), 7);
  assert.equal(scoreBetween('<td>no digits here</td>', 0), null);
});

test('inningParts: derives inning number and half from status text', () => {
  assert.deepEqual(inningParts('Top of 3rd'), { inning: 3, half: 'top' });
  assert.deepEqual(inningParts('Bottom of 7th'), { inning: 7, half: 'bottom' });
  assert.deepEqual(inningParts('Mid of 5th'), { inning: 5, half: 'top' });
  assert.deepEqual(inningParts('Final'), { inning: 0, half: 'bottom' });
});

test('dateFromId: parses YYYYMMDD into iso/label/sortKey', () => {
  const d = dateFromId('20260621');
  assert.equal(d.iso, '2026-06-21');
  assert.equal(d.sortKey, 20260621);
  // 2026-06-21 is a Sunday; label is "<DOW> M/D".
  assert.equal(d.label, 'Sun 6/21');
});
