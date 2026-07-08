'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildRecord, lineIsShowable } = require('../server');

// Presto leaves a recently-added player's page season aggregate as an empty
// placeholder ({pa:0,tb:0} — no AB/AVG) for a while after his first game, even
// though his game-by-game log already lists that game. buildRecord must not let
// that unshowable placeholder win: when a game log is present it should fall
// back to the game-log aggregate so the card + lineup show a real AVG, not N/A.
// (Regression: Marco Bandiero's lineup AVG read N/A after he'd already played.)

test('buildRecord: placeholder batting aggregate + game log yields a real AVG', () => {
  const primary = {
    kind: 'batting',
    map: { pa: { v: '0' }, tb: { v: '0' } }, // Presto's empty placeholder line
    glBat: [
      { date: 'Jul 4', ab: '2', h: '1', hr: '-', rbi: '0', bb: '2', k: '-' },
    ],
    glPit: [],
  };
  const rec = buildRecord('marcobandieroddnu', primary, null, null);
  assert.ok(lineIsShowable({ hit: rec.hit }), 'hit line should be showable');
  assert.equal(rec.hit.ab, '2');
  assert.equal(rec.hit.h, '1');
  assert.equal(rec.hit.avg, '.500'); // 1-for-2
});

test('buildRecord: a real page batting aggregate is kept as-is', () => {
  const primary = {
    kind: 'batting',
    map: { ab: { v: '68' }, h: { v: '20' }, avg: { v: '.294', r: '27th' } },
    glBat: [{ date: 'Jun 1', ab: '4', h: '1', hr: '-', rbi: '0', bb: '0', k: '1' }],
    glPit: [],
  };
  const rec = buildRecord('somebody', primary, null, null);
  assert.equal(rec.hit.avg, '.294'); // page value, not the 1-game log
  assert.equal(rec.hitRanks.avg, '27th'); // ranks preserved when page line stands
});

test('buildRecord: placeholder pitching aggregate + game log yields a real ERA', () => {
  const primary = {
    kind: 'pitching',
    map: { app: { v: '0' } }, // unshowable placeholder (no ip/era)
    glBat: [],
    glPit: [{ date: 'Jul 4', ip: '2.0', h: '1', r: '0', er: '0', bb: '1', k: '3' }],
  };
  const rec = buildRecord('somepitcher', primary, null, null);
  assert.ok(lineIsShowable({ pit: rec.pit }), 'pit line should be showable');
  assert.equal(rec.pit.ip, '2.0');
  assert.equal(rec.pit.era, '0.00');
});
