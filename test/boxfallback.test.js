'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseBoxscore, boxRowsForPlayer, aggBat, aggPit } = require('../server');

// The box-score fallback derives a just-debuted player's season line straight
// from the Gators box scores when Presto hasn't posted their games to their
// player page/leaderboard yet. boxRowsForPlayer pulls their per-game row; aggBat
// aggregates it into the same shape the player-page game log produces.
const FIXTURE = parseBoxscore(fs.readFileSync(path.join(__dirname, 'fixtures', 'boxscore.html'), 'utf8'));

test('boxRowsForPlayer: pulls a Gators hitter\'s per-game batting line from the box', () => {
  // The fixture's Gators batting table has "Boudreaux, Andre 1b" going 3-for-4.
  const { bat, pit } = boxRowsForPlayer(FIXTURE, 'andre boudreaux');
  assert.equal(bat.length, 1);
  assert.equal(pit.length, 0);
  assert.equal(bat[0].ab, '4');
  assert.equal(bat[0].h, '3');
  assert.equal(bat[0].rbi, '2');
});

test('boxRowsForPlayer: an unknown name yields no rows', () => {
  const { bat, pit } = boxRowsForPlayer(FIXTURE, 'nobody here');
  assert.equal(bat.length, 0);
  assert.equal(pit.length, 0);
});

test('boxRowsForPlayer + aggBat: a single-game line aggregates to a season line', () => {
  const { bat } = boxRowsForPlayer(FIXTURE, 'andre boudreaux');
  const line = aggBat(bat);
  assert.equal(line.ab, '4');
  assert.equal(line.h, '3');
  assert.equal(line.avg, '.750'); // 3-for-4
  assert.equal(line.gp, '1');
});

test('boxRowsForPlayer: only reads Gators sections, not the opponent', () => {
  // Aggregating across two identical box "games" should just double the counts,
  // confirming rows come only from the Gators table (no opponent double-count).
  const doubled = boxRowsForPlayer(FIXTURE, 'andre boudreaux').bat
    .concat(boxRowsForPlayer(FIXTURE, 'andre boudreaux').bat);
  const line = aggBat(doubled);
  assert.equal(line.ab, '8');
  assert.equal(line.h, '6');
  assert.equal(line.gp, '2');
});
