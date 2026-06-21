'use strict';
// Tests for parseReplayList(): turning the Gators' TCL TV category page (VOD
// links) into an index keyed by game date + opponent token, keeping the longest
// clip per game so a finished game links to the full broadcast, not a fragment.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseReplayList } = require('../server');

// Real-shaped /video/ slugs: <teams>-<Day>-<Mon>-<DD>-<YYYY>-<start>-to-<end>.
const HTML = `
<a href="/video/Gumbeaux-Gators-Brazos-Valley-Bombers-Sun-Jul-27-2025-722-PM-to-839-PM">x</a>
<a href="/video/Gumbeaux-Gators-Brazos-Valley-Bombers-Sun-Jul-27-2025-649-PM-to-657-PM">x</a>
<a href="/video/Baton-Rouge-Rougarou-Gumbeaux-Gators-Fri-Jul-25-2025-650-PM-to-1006-PM">x</a>
<a href="/video/Seguin-River-Monsters-Gumbeaux-Gators-Sat-Jul-19-2025-651-PM-to-1025-PM">x</a>
<a href="/video/Acadiana-Cane-Cutters-Gumbeaux-Gators-Sat-Jul-12-2025-650-PM-to-938-PM">x</a>`;

test('parseReplayList: keys VODs by date + opponent token', () => {
  const idx = parseReplayList(HTML);
  assert.ok(idx['20250727|bombers']);
  assert.ok(idx['20250725|rougarou']);
  assert.ok(idx['20250719|monsters']); // Seguin River Monsters still maps to monsters
  assert.ok(idx['20250712|cane']);
});

test('parseReplayList: keeps the longest clip per game (full broadcast)', () => {
  const idx = parseReplayList(HTML);
  // Jul 27 had a 8-min fragment (649-657) and the full game (722-839); keep full.
  assert.match(idx['20250727|bombers'].url, /722-PM-to-839-PM$/);
  assert.equal(idx['20250727|bombers'].mins, 77);
});

test('parseReplayList: parses PM time ranges crossing the 12-hour boundary', () => {
  const idx = parseReplayList(HTML);
  // 6:50 PM -> 10:06 PM = 196 minutes
  assert.equal(idx['20250725|rougarou'].mins, 196);
});

test('parseReplayList: ignores non-VOD or malformed links', () => {
  const idx = parseReplayList('<a href="/live/Lake-Charles-At-Abilene">x</a><a href="/video/no-date-here">y</a>');
  assert.deepEqual(idx, {});
});
