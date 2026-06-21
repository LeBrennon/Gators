'use strict';
// Tests for parseReplayList(): turning the league's Vewbie VOD list into an
// index keyed by game date + opponent team id, keeping the longest clip per game
// (the full broadcast). Must handle both slug naming styles and only index
// Gators games.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseReplayList } = require('../server');

// Team ids (from TEAMS), used as the index keys.
const BOMBERS = 'z7w5th537gur3z15';
const ROUGAROU = 'z10kgms3gvy1eszs';
const MONSTERS = 'do9ibktaduhyld7f';
const CANE = 'cz8qei0rxijys6nm';
const SHADOWCATS = 'w43rx8i07fn44cyl';

// 2024/25 slugs use team names + "Gumbeaux Gators".
const OLD = {
  categories_medias: [
    { type: 'VIDEO', is_live: false, duration: '01:17:00', media_slug: 'Gumbeaux-Gators-Brazos-Valley-Bombers-Sun-Jul-27-2025-722-PM-to-839-PM' },
    { type: 'VIDEO', is_live: false, duration: '00:08:00', media_slug: 'Gumbeaux-Gators-Brazos-Valley-Bombers-Sun-Jul-27-2025-649-PM-to-657-PM' },
    { type: 'VIDEO', is_live: false, duration: '03:16:00', media_slug: 'Baton-Rouge-Rougarou-Gumbeaux-Gators-Fri-Jul-25-2025-650-PM-to-1006-PM' },
    { type: 'VIDEO', is_live: false, duration: '03:34:00', media_slug: 'Seguin-River-Monsters-Gumbeaux-Gators-Sat-Jul-19-2025-651-PM-to-1025-PM' },
  ],
};

// 2026+ slugs use city + "At" + "Lake Charles".
const NEW = {
  categories_medias: [
    { type: 'VIDEO', is_live: false, duration: '03:54:02', media_slug: 'Lake-Charles-At-Acadiana-Thu-Jun-18-2026-645-PM-to-1039-PM' },
    { type: 'VIDEO', is_live: false, duration: '03:27:23', media_slug: 'Lake-Charles-At-Sherman-Sat-Jun-20-2026-641-PM-to-1009-PM' },
    { type: 'VIDEO', is_live: false, duration: '00:00:00', media_slug: 'Lake-Charles-At-Sherman-Sat-Jun-20-2026-557-PM-to-557-PM' },
    // a non-Gators game in the same league category must be ignored
    { type: 'VIDEO', is_live: false, duration: '04:02:00', media_slug: 'San-Antonio-At-Victoria-Sat-Jun-20-2026-648-PM-to-1050-PM' },
  ],
};

test('parseReplayList: indexes 2024/25 team-name slugs by opponent id', () => {
  const idx = parseReplayList(OLD);
  assert.ok(idx['20250727|' + BOMBERS]);
  assert.ok(idx['20250725|' + ROUGAROU]);
  assert.ok(idx['20250719|' + MONSTERS]); // Seguin River Monsters -> token "monsters"
});

test('parseReplayList: indexes 2026 city+At slugs by opponent id', () => {
  const idx = parseReplayList(NEW);
  assert.ok(idx['20260618|' + CANE]);      // Lake-Charles-At-Acadiana -> Acadiana
  assert.ok(idx['20260620|' + SHADOWCATS]); // Lake-Charles-At-Sherman -> Sherman
});

test('parseReplayList: builds the texascollegiateleague.live /video/ URL', () => {
  const idx = parseReplayList(NEW);
  assert.equal(
    idx['20260618|' + CANE].url,
    'https://texascollegiateleague.live/video/Lake-Charles-At-Acadiana-Thu-Jun-18-2026-645-PM-to-1039-PM'
  );
});

test('parseReplayList: keeps the longest clip per game (full broadcast)', () => {
  const idxOld = parseReplayList(OLD);
  assert.match(idxOld['20250727|' + BOMBERS].url, /722-PM-to-839-PM$/); // 1h17m over 8m fragment
  const idxNew = parseReplayList(NEW);
  assert.match(idxNew['20260620|' + SHADOWCATS].url, /641-PM-to-1009-PM$/); // 3h27m over 0m fragment
});

test('parseReplayList: ignores non-Gators games in the league category', () => {
  const idx = parseReplayList(NEW);
  // San-Antonio @ Victoria has no Gators side, so neither team gets indexed for it
  assert.equal(idx['20260620|' + MONSTERS], undefined);
  assert.equal(idx['20260620|jm9r4btii24hhtfp'], undefined); // Victoria
});

test('parseReplayList: skips live entries and accepts a bare array', () => {
  const idx = parseReplayList([
    { type: 'LIVE', is_live: true, duration: '00:00:00', media_slug: 'Lake-Charles-At-Victoria-Mon-Jun-23-2026-700-PM-to-700-PM' },
    { type: 'VIDEO', is_live: false, duration: '02:30:00', media_slug: 'Lake-Charles-At-Victoria-Sun-Jun-22-2026-700-PM-to-930-PM' },
  ]);
  assert.equal(idx['20260623|jm9r4btii24hhtfp'], undefined);
  assert.ok(idx['20260622|jm9r4btii24hhtfp']);
});

test('parseReplayList: ignores malformed entries and empty payloads', () => {
  assert.deepEqual(parseReplayList({ categories_medias: [{ type: 'VIDEO', media_slug: 'no-date-here' }] }), {});
  assert.deepEqual(parseReplayList({}), {});
  assert.deepEqual(parseReplayList(null), {});
});
