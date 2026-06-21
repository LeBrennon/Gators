'use strict';
// Tests for parseReplayList(): turning the Gators' Vewbie category VOD list into
// an index keyed by game date + opponent token, keeping the longest clip per
// game so a finished game links to the full broadcast, not a fragment.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseReplayList } = require('../server');

// Real-shaped API items: media_slug carries the local date/times, duration is
// HH:MM:SS, type/is_live distinguish VODs from live entries.
const PAYLOAD = {
  categories_medias: [
    { type: 'VIDEO', is_live: false, duration: '01:17:00', media_slug: 'Gumbeaux-Gators-Brazos-Valley-Bombers-Sun-Jul-27-2025-722-PM-to-839-PM' },
    { type: 'VIDEO', is_live: false, duration: '00:08:00', media_slug: 'Gumbeaux-Gators-Brazos-Valley-Bombers-Sun-Jul-27-2025-649-PM-to-657-PM' },
    { type: 'VIDEO', is_live: false, duration: '03:16:00', media_slug: 'Baton-Rouge-Rougarou-Gumbeaux-Gators-Fri-Jul-25-2025-650-PM-to-1006-PM' },
    { type: 'VIDEO', is_live: false, duration: '03:34:00', media_slug: 'Seguin-River-Monsters-Gumbeaux-Gators-Sat-Jul-19-2025-651-PM-to-1025-PM' },
    { type: 'VIDEO', is_live: false, duration: '02:48:00', media_slug: 'Acadiana-Cane-Cutters-Gumbeaux-Gators-Sat-Jul-12-2025-650-PM-to-938-PM' },
  ],
};

test('parseReplayList: keys VODs by date + opponent token', () => {
  const idx = parseReplayList(PAYLOAD);
  assert.ok(idx['20250727|bombers']);
  assert.ok(idx['20250725|rougarou']);
  assert.ok(idx['20250719|monsters']); // Seguin River Monsters still maps to monsters
  assert.ok(idx['20250712|cane']);
});

test('parseReplayList: builds the new texascollegiateleague.live /video/ URL', () => {
  const idx = parseReplayList(PAYLOAD);
  assert.equal(
    idx['20250712|cane'].url,
    'https://texascollegiateleague.live/video/Acadiana-Cane-Cutters-Gumbeaux-Gators-Sat-Jul-12-2025-650-PM-to-938-PM'
  );
});

test('parseReplayList: keeps the longest clip per game (full broadcast)', () => {
  const idx = parseReplayList(PAYLOAD);
  // Jul 27 had an 8-min fragment and the 1h17m full game; keep the full game.
  assert.match(idx['20250727|bombers'].url, /722-PM-to-839-PM$/);
  assert.equal(idx['20250727|bombers'].secs, 77 * 60);
});

test('parseReplayList: skips live entries and accepts a bare array', () => {
  const idx = parseReplayList([
    { type: 'LIVE', is_live: true, duration: '00:00:00', media_slug: 'Gumbeaux-Gators-Victoria-Generals-Mon-Jun-23-2025-700-PM-to-700-PM' },
    { type: 'VIDEO', is_live: false, duration: '02:30:00', media_slug: 'Gumbeaux-Gators-Victoria-Generals-Sun-Jun-22-2025-700-PM-to-930-PM' },
  ]);
  assert.equal(idx['20250623|generals'], undefined);
  assert.ok(idx['20250622|generals']);
});

test('parseReplayList: ignores malformed entries and empty payloads', () => {
  assert.deepEqual(parseReplayList({ categories_medias: [{ type: 'VIDEO', media_slug: 'no-date-here' }] }), {});
  assert.deepEqual(parseReplayList({}), {});
  assert.deepEqual(parseReplayList(null), {});
});
