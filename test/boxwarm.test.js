'use strict';
// The box-score pre-warm (warmFinalBox) leans on boxLooksComplete to tell a real
// finished box apart from a bot-gate/challenge stub: a complete box has both
// teams' tables, while the gate page parses to an empty box. Getting this wrong
// would either poison the cache with a stub (button shows nothing) or never mark
// the warm done (retries the source forever). Lock the discriminator against the
// real parseBoxscore output.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseBoxscore, boxLooksComplete } = require('../server');

const HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'boxscore.html'), 'utf8');

test('boxLooksComplete: a real finished box counts as complete', () => {
  assert.equal(boxLooksComplete(parseBoxscore(HTML)), true);
});

test('boxLooksComplete: a bot-gate/challenge page is not complete', () => {
  const stub = parseBoxscore('<html><body><h1>Checking your browser…</h1></body></html>');
  assert.equal(boxLooksComplete(stub), false);
});

test('boxLooksComplete: an empty response is not complete', () => {
  assert.equal(boxLooksComplete(parseBoxscore('')), false);
});

test('boxLooksComplete: guards missing/degenerate box data', () => {
  assert.equal(boxLooksComplete(null), false);
  assert.equal(boxLooksComplete({}), false);
  assert.equal(boxLooksComplete({ box: [] }), false);
  assert.equal(boxLooksComplete({ box: [{}] }), false); // one team only
  assert.equal(boxLooksComplete({ box: [{}, {}] }), true);
});
