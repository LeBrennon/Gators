'use strict';
// The live lineup carries the same MLB-style alphabet substitution ledger the
// box score does: each pinch hitter/runner or defensive sub gets a reference
// letter (a-, b-…) and a legend entry saying WHEN he entered, enriched from the
// play-by-play — so the gamecast lineup shows when a pinch hit happened, not just
// that the batter is a sub.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lineupsFromFeed, attachLineupSubLegend } = require('../server');

// A team with a starter (Snider, 3B, spot 3) and the pinch hitter who took his
// spot (Bandiero, PH, spot 3) — the case in the screenshot.
const feed = {
  team: [{
    vh: 'H', teamId: 'gators-2024', name: 'Gumbeaux Gators',
    player: [
      { uni: '25', name: 'Reid Snider', revname: 'Snider, Reid', hitting: { ab: '2', h: '0' } },
      { uni: '48', name: 'Matthew Bandiero', revname: 'Bandiero, Matthew', hitting: { ab: '1', h: '1' } },
    ],
    batords: { batord: [
      { uni: '25', spot: '3', pos: '3B', name: 'Reid Snider' },
      { uni: '48', spot: '3', pos: 'PH', name: 'Matthew Bandiero' },
    ] },
  }],
};

test('lineupsFromFeed: a pinch hitter is flagged as a sub and gets an alphabet letter', () => {
  const team = lineupsFromFeed(feed)[0];
  const [starter, ph] = team.rows;
  assert.equal(starter.sub, false);
  assert.equal(starter.letter, '');
  assert.equal(ph.sub, true);
  assert.equal(ph.letter, 'a');
  // Legend is seeded with a "for <player above>" fallback keyed to the letter.
  assert.equal(team.subLegend.length, 1);
  assert.equal(team.subLegend[0].letter, 'a');
  assert.equal(team.subLegend[0].name, 'Matthew Bandiero');
  assert.equal(team.subLegend[0].forName, 'Reid Snider');
  assert.match(team.subLegend[0].text, /pinch-hit for Reid Snider/);
});

test('attachLineupSubLegend: enriches the legend with the result + inning from the plays', () => {
  const lineups = lineupsFromFeed(feed);
  const plays = [
    { inning: 7, half: 'bot', text: 'Matthew Bandiero pinch hit for Reid Snider.' },
    { inning: 7, half: 'bot', text: 'Matthew Bandiero singled through the left side (1-1 BK).' },
  ];
  attachLineupSubLegend(lineups, plays);
  assert.equal(lineups[0].subLegend[0].text, 'singled through the left side for Reid Snider in the 7th');
});

test('attachLineupSubLegend: pinch runner reads "ran for X in the Nth"', () => {
  const prFeed = {
    team: [{
      vh: 'H', teamId: 'gators-2024', name: 'Gumbeaux Gators',
      player: [
        { uni: '10', name: 'Kash Martin', revname: 'Martin, Kash', hitting: { ab: '2', h: '1' } },
        { uni: '4', name: 'Speedy Jones', revname: 'Jones, Speedy', hitting: { ab: '0', h: '0' } },
      ],
      batords: { batord: [
        { uni: '10', spot: '7', pos: '2B', name: 'Kash Martin' },
        { uni: '4', spot: '7', pos: 'PR', name: 'Speedy Jones' },
      ] },
    }],
  };
  const lineups = lineupsFromFeed(prFeed);
  attachLineupSubLegend(lineups, [
    { inning: 8, half: 'bot', text: 'Speedy Jones pinch ran for Kash Martin.' },
  ]);
  assert.equal(lineups[0].rows[1].letter, 'a');
  assert.equal(lineups[0].subLegend[0].text, 'ran for Kash Martin in the 8th');
});

test('attachLineupSubLegend: falls back to the seeded text when there is no announcement', () => {
  const lineups = lineupsFromFeed(feed);
  attachLineupSubLegend(lineups, [{ inning: 3, half: 'bot', text: 'Somebody Else flied out to center.' }]);
  assert.match(lineups[0].subLegend[0].text, /pinch-hit for Reid Snider/);
});
