'use strict';
// Tests for msUntilNextCentralMidnight(): the delay used to run the once-a-day
// player-stats scrape at local (Central) midnight.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { msUntilNextCentralMidnight } = require('../server');

test('msUntilNextCentralMidnight: within (0, 24h]', () => {
  const ms = msUntilNextCentralMidnight();
  assert.ok(ms > 0, 'must be positive');
  assert.ok(ms <= 24 * 60 * 60 * 1000, 'must not exceed 24h');
});

test('msUntilNextCentralMidnight: lands on a whole second to a Central midnight', () => {
  const ms = msUntilNextCentralMidnight();
  // Add the delay to now and confirm it is midnight in America/Chicago.
  const at = new Date(Date.now() + ms);
  const hm = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour12: false,
    hour: '2-digit', minute: '2-digit' }).format(at);
  assert.ok(hm === '00:00' || hm === '24:00', 'expected Central midnight, got ' + hm);
});
