'use strict';
// Tests for the end-of-inning / end-of-game text-alert wording (the SMS body
// sent to a carrier email-to-SMS gateway). Only the text builders are covered;
// the send/dedupe plumbing is exercised in the live game loop.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inningAlertText, finalAlertText } = require('../server');

// A Gators home win, 9–7 over San Antonio, with a full 9-inning line score.
const norm = {
  id: '20260703_abcd',
  gatorsHome: true,
  status: 'final',
  inning: 9,
  home: { runs: 9 },
  away: { runs: 7 },
  opponent: { short: 'San Antonio' },
  lineScore: [
    { vh: 'V', isGators: false, name: 'San Antonio', innings: [0, 0, 0, 0, 0, 2, 0, 1, 4] },
    { vh: 'H', isGators: true, name: 'Gators', innings: [1, 3, 0, 0, 0, 0, 5, 0, 0] },
  ],
};

test('inningAlertText: end-of-3rd shows the score and only the first 3 innings', () => {
  assert.equal(
    inningAlertText(norm, 3),
    'End of 3rd: Gators 9-7 San Antonio\nSan Antonio 0 0 0\nGators 1 3 0'
  );
});

test('inningAlertText: end-of-6th slices to six innings', () => {
  assert.equal(
    inningAlertText(norm, 6),
    'End of 6th: Gators 9-7 San Antonio\nSan Antonio 0 0 0 0 0 2\nGators 1 3 0 0 0 0'
  );
});

test('finalAlertText: W tag, final score, and the full line score', () => {
  assert.equal(
    finalAlertText(norm),
    'FINAL (W): Gators 9-7 San Antonio\nSan Antonio 0 0 0 0 0 2 0 1 4\nGators 1 3 0 0 0 0 5 0 0'
  );
});

test('finalAlertText: a loss flips the tag and the score orientation', () => {
  const loss = { ...norm, home: { runs: 3 }, away: { runs: 9 } };
  assert.equal(finalAlertText(loss).split('\n')[0], 'FINAL (L): Gators 3-9 San Antonio');
});

test('finalAlertText: away game reads the Gators runs from the away side', () => {
  const away = {
    ...norm,
    gatorsHome: false,
    home: { runs: 4 },   // opponent
    away: { runs: 5 },   // Gators
    lineScore: [
      { vh: 'V', isGators: true, name: 'Gators', innings: [2, 0, 3, 0, 0] },
      { vh: 'H', isGators: false, name: 'San Antonio', innings: [0, 4, 0, 0, 0] },
    ],
  };
  assert.equal(finalAlertText(away).split('\n')[0], 'FINAL (W): Gators 5-4 San Antonio');
});
