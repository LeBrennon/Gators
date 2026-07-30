'use strict';
// A live league game the Gators aren't in can take the gamecast — on a night the
// other semifinal decides their next opponent, that game is the story. These
// cover the reshaping that lets it, and the Gators-specific framing it has to
// drop on the way: no home/away, no Gators stream fallback, no series line.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { leagueGameRow, gameLocation, watchUrlFor, neutralPlayoffInfo, PLAYOFF_SERIES } = require('../server');

const GAT = 'et1bt9sixrz5lnnl'; // Gators
const VIC = 'jm9r4btii24hhtfp'; // Generals (Victoria)
const BOM = 'z7w5th537gur3z15'; // Bombers (Brazos Valley)

// A parseLeagueScoreboard() board row.
function boardRow(state) {
  return { id: '20260730_ab12', date: '20260730', state: state || 'live', status: 'Top of 3rd',
    isGators: false, url: 'https://example/box',
    away: { id: BOM, short: 'Bombers', logo: 'b.png', score: 2 },
    home: { id: VIC, short: 'Generals', logo: 'v.png', score: 1 } };
}

test('leagueGameRow reshapes a board row into a schedule-shaped game', () => {
  const g = leagueGameRow(boardRow());
  assert.equal(g.id, '20260730_ab12');
  assert.equal(g.date, '20260730');
  assert.equal(g.dateLabel, 'Thu 7/30');
  assert.equal(g.sortKey, 20260730);
  assert.equal(g.state, 'live');
  assert.equal(g.away.id, BOM);
  assert.equal(g.home.id, VIC);
  assert.equal(g.away.score, 2);
  assert.equal(g.home.score, 1);
  // Full names get filled in from the team table, not carried from the board.
  assert.equal(g.away.name, 'Brazos Valley Bombers');
  assert.equal(g.home.name, 'Victoria Generals');
});

test('leagueGameRow marks the game neutral and refuses to pick a side', () => {
  const g = leagueGameRow(boardRow());
  assert.equal(g.neutral, true);
  // null, not false — false would claim the Gators are the away team.
  assert.equal(g.gatorsHome, null);
  assert.notEqual(g.gatorsHome, false);
  assert.equal(g.away.id === GAT || g.home.id === GAT, false);
});

test('gameLocation names the host instead of framing it as home or away', () => {
  assert.equal(gameLocation(leagueGameRow(boardRow())), 'At Victoria');
  // A Gators game is unaffected.
  assert.equal(gameLocation({ gatorsHome: true, home: { id: GAT } }), 'Home, Joe Miller Ballpark');
  assert.equal(gameLocation({ gatorsHome: false, home: { id: VIC }, opponent: { short: 'Generals' } }), 'Away @ Victoria');
});

test('a neutral game gets no watch link unless its own stream matched', () => {
  // The fallback is the Gators' own TCL TV category — wrong for anybody else.
  assert.equal(watchUrlFor(leagueGameRow(boardRow())), null);
  // A Gators game still falls back to their category.
  const ours = { state: 'live', date: '20260730', away: { id: GAT }, home: { id: VIC } };
  assert.match(String(watchUrlFor(ours)), /gumbeaux-gators/);
});

test('neutralPlayoffInfo keeps the date tag and says what the game means for us', () => {
  const decided = { w: 2, l: 0 };
  const p = neutralPlayoffInfo('20260730', decided);
  assert.equal(p.tag, PLAYOFF_SERIES['20260730'].tag);   // "Game 3" is their game too
  assert.match(p.note, /Winner meets the Gators/);
  // With our own semifinal still alive there's no championship claim to make.
  assert.equal(neutralPlayoffInfo('20260730', { w: 1, l: 0 }).note, null);
  assert.equal(neutralPlayoffInfo('20260730', null).note, null);
  // A date with no playoff block still gets a usable tag.
  assert.equal(neutralPlayoffInfo('20260615', decided).tag, 'TCL Playoffs');
});
