'use strict';
// Tests for normalizeFeatured(): turning a parsed schedule game into the shape
// the client consumes (status, inning label, location, per-team runs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFeatured } = require('../server');

const GATORS = 'et1bt9sixrz5lnnl';
const CANE   = 'cz8qei0rxijys6nm';

// Shaped like an element of parseSchedule()'s output.
function game(overrides) {
  return Object.assign({
    id: '20260621_cccc', date: '20260621', dateLabel: 'Sun 6/21',
    state: 'final', status: 'Final', gatorsHome: true,
    opponent: { name: 'Acadiana Cane Cutters', short: 'Cane Cutters', logo: 'x' },
    away: { id: CANE, name: 'Acadiana Cane Cutters', short: 'Cane Cutters', logo: 'x', score: 3 },
    home: { id: GATORS, name: 'Lake Charles Gumbeaux Gators', short: 'Gators', logo: 'y', score: 5 },
  }, overrides);
}

test('normalizeFeatured: final home game', () => {
  const n = normalizeFeatured(game());
  assert.equal(n.status, 'final');
  assert.equal(n.statusText, 'Final');
  assert.equal(n.inningLabel, 'Final');
  assert.equal(n.gatorsHome, true);
  assert.equal(n.location, 'Home, Joe Miller Ballpark');
  assert.equal(n.away.runs, 3);
  assert.equal(n.home.runs, 5);
  assert.equal(n.watchUrl, null);          // no live/scheduled stream for a final
});

test('normalizeFeatured: live game keeps the inning label and derives half/number', () => {
  const n = normalizeFeatured(game({ state: 'live', status: 'Bottom of 7th' }));
  assert.equal(n.status, 'live');
  assert.equal(n.inningLabel, 'Bottom of 7th');
  assert.equal(n.inning, 7);
  assert.equal(n.half, 'bottom');
});

test('normalizeFeatured: scheduled game maps to pregame, runs default to 0', () => {
  const n = normalizeFeatured(game({
    state: 'scheduled', status: '7:05 PM CT',
    away: { id: CANE, name: 'Acadiana Cane Cutters', short: 'Cane Cutters', logo: 'x' },
    home: { id: GATORS, name: 'Lake Charles Gumbeaux Gators', short: 'Gators', logo: 'y' },
  }));
  assert.equal(n.status, 'pregame');
  assert.equal(n.inningLabel, '7:05 PM CT');
  assert.equal(n.away.runs, 0);
  assert.equal(n.home.runs, 0);
});

test('normalizeFeatured: away game reports the road location', () => {
  const n = normalizeFeatured(game({
    gatorsHome: false,
    opponent: { name: 'Acadiana Cane Cutters', short: 'Cane Cutters', logo: 'x' },
    away: { id: GATORS, name: 'Lake Charles Gumbeaux Gators', short: 'Gators', logo: 'y', score: 4 },
    home: { id: CANE, name: 'Acadiana Cane Cutters', short: 'Cane Cutters', logo: 'x', score: 2 },
  }));
  assert.equal(n.location, 'Away @ Acadiana');
});
