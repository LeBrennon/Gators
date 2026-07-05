'use strict';
// Tests for the live-situation feed parsers: extractEventAuth (pull the feed's
// event id + access hash out of a boxscore page), summarizeLive (boil the status
// block down), and teamLineScores (per-team runs/hits/errors).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractEventAuth, summarizeLive, teamLineScores, summarizePlays, pitchersFromFeed, applyLivePitchCount, applyPitcherOverrides, pitchingTotals } = require('../server');

const GATORS = 'et1bt9sixrz5lnnl';

test('extractEventAuth: reads e + h from a liveupdate URL (HTML-escaped &)', () => {
  const html = `<iframe src="/action/sports/liveupdate?e=abc123def456&amp;h=XyZ_-789hash"></iframe>`;
  assert.deepEqual(extractEventAuth(html), { e: 'abc123def456', h: 'XyZ_-789hash', how: 'liveupdate-url' });
});

test('extractEventAuth: reads e + h from separate token fields', () => {
  const html = `var cfg = { eventId: "abc123def456gh", liveHash: "ABCdef0123456789hashx" };`;
  const out = extractEventAuth(html);
  assert.equal(out.e, 'abc123def456gh');
  assert.equal(out.h, 'ABCdef0123456789hashx');
  assert.equal(out.how, 'gameday-conf');
});

test('extractEventAuth: reads the 2026 PrestoSports gameday conf format', () => {
  // Real shape: conf.eventId then conf.eventIdHashCode (the latter must not be
  // captured as the event id).
  const html = "conf.gamedayServiceEntryPointUrl = '/action/sports/liveupdate?e=k3ibyrasvuknfwhs&';"
    + " conf.eventId = 'k3ibyrasvuknfwhs'; conf.eventIdHashCode = 'oAsFPOpe6rBzC7h8OOTke8nD8QKvJYUz';";
  assert.deepEqual(extractEventAuth(html), {
    e: 'k3ibyrasvuknfwhs', h: 'oAsFPOpe6rBzC7h8OOTke8nD8QKvJYUz', how: 'gameday-conf',
  });
});

test('extractEventAuth: reads a base64 eventIdHashCode containing / + =', () => {
  // Real 2026 page: conf.eventId then conf.eventIdHashCode, whose value is
  // base64 and can contain /, + and = — the regex must not stop at the slash.
  const html = "conf.eventId = 'mrd6azore5odmfgz'; conf.eventIdHashCode = 'WKIEpkL/Kb6zTCvFEeNmbMnD8QKvJYUz';";
  assert.deepEqual(extractEventAuth(html), {
    e: 'mrd6azore5odmfgz', h: 'WKIEpkL/Kb6zTCvFEeNmbMnD8QKvJYUz', how: 'gameday-conf',
  });
});

test('extractEventAuth: 2026 entry-point URL carries only e (no hash)', () => {
  // Real page shape: the gameday entry point now passes just the event id with a
  // trailing & and no &h=, and there is no eventIdHashCode field. The feed takes
  // the event id alone, so e must come back even without a hash.
  const html = "conf.gamedayServiceEntryPointUrl = '/action/sports/liveupdate?e=mrd6azore5odmfgz&';";
  const out = extractEventAuth(html);
  assert.equal(out.e, 'mrd6azore5odmfgz');
  assert.equal(out.h, null);
  assert.equal(out.how, 'gameday-conf-nohash');
});

test('extractEventAuth: not found returns nulls', () => {
  assert.deepEqual(extractEventAuth('<html>no tokens</html>'), { e: null, h: null, how: 'not-found' });
});

// Status fields arrive as 1-element arrays from the feed; val() unwraps them.
const STATUS = {
  status: {
    complete: ['N'], inning: ['4'], vh: ['V'], batting: ['Gators'],
    outs: ['2'], b: ['1'], s: ['2'], batter: ['J. Doe'], pitcher: ['R. Roe'],
    first: ['A. Smith'], second: [''], third: [''],
  },
};

test('summarizeLive: maps the status block to the live situation', () => {
  const live = summarizeLive(STATUS);
  assert.equal(live.complete, false);
  assert.equal(live.inning, '4');
  assert.equal(live.half, 'Top');           // vh 'V' => visitor batting => top
  assert.equal(live.battingTeam, 'Gators');
  assert.equal(live.outs, 2);
  assert.equal(live.count, '1-2');
  assert.equal(live.batter, 'J. Doe');
  assert.equal(live.pitcher, 'R. Roe');
  assert.deepEqual(live.bases, { first: true, second: false, third: false });
  assert.equal(live.runners.first, 'A. Smith');
  assert.equal(live.runners.second, null);
});

test('summarizeLive: home batting flips the half to Bottom', () => {
  const live = summarizeLive({ status: { vh: ['H'], inning: ['7'] } });
  assert.equal(live.half, 'Bottom');
});

test('summarizeLive: missing status returns null', () => {
  assert.equal(summarizeLive({}), null);
  assert.equal(summarizeLive(null), null);
});

test('summarizeLive: pitcher info carries pitch count with strikes and balls', () => {
  const json = {
    status: { vh: ['V'], inning: ['4'], pitcher: ['Jaykub Reyes'] },
    team: [{ vh: 'V', player: [
      { name: 'Jaykub Reyes', uni: '23', pitching: [{ ip: '3.0', er: '2', so: '1', bb: '0', pitches: '49', strikes: '33' }] },
    ] }],
  };
  const info = summarizeLive(json).pitcherInfo;
  assert.equal(info.line, '3.0 IP, 2 ER, 1 K, 0 BB');
  assert.equal(info.pitches, 49);
  assert.equal(info.strikes, 33);
  assert.equal(info.balls, 16); // 49 - 33
});

test('summarizeLive: a pitcher with no pitches yet has no strikes/balls', () => {
  const json = {
    status: { pitcher: ['Matthew McKinley'] },
    team: [{ player: [{ name: 'Matthew McKinley', uni: '22', pitching: [{ appear: '2' }] }] }],
  };
  const info = summarizeLive(json).pitcherInfo;
  assert.equal(info.pitches, null);
  assert.equal(info.strikes, null);
  assert.equal(info.balls, null);
});

test('teamLineScores: flattens each team line, per-inning runs, and flags the Gators', () => {
  const json = { team: [
    { vh: 'V', name: 'Gators', teamId: GATORS, linescore: { runs: 3, hits: 5, errs: 0,
      lineinn: [{ inn: '1', score: ['2'] }, { inn: '2', score: ['1'] }] } },
    { vh: 'H', name: 'Bison', teamId: 'ij0lwtvjsx2mi1nh', linescore: { runs: 1, hits: 3, errs: 1,
      lineinn: [{ inn: '1', score: ['0'] }, { inn: '2', score: ['1'] }] } },
  ] };
  const lines = teamLineScores(json);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], { vh: 'V', name: 'Gators', teamId: GATORS, isGators: true, runs: 3, hits: 5, errs: 0, innings: [2, 1] });
  assert.equal(lines[1].isGators, false);
  assert.deepEqual(lines[1].innings, [0, 1]);
});

test('teamLineScores: missing team array yields empty list', () => {
  assert.deepEqual(teamLineScores({}), []);
});

// ---- summarizePlays: flatten the play-by-play into a narrated feed ----------
const PLAYS = {
  plays: { format: 'summary', inning: [
    { number: '1', batting: [
      { vh: 'V', id: 'LAKE CHA', play: [
        { seq: '1', outs: '0', narrative: { text: 'Nathan McDonald singled to third base (2-2 KBKFB).' } },
        { seq: '2', outs: '0', narrative: { text: 'Reid Snider grounded out to p, RBI; Nathan McDonald scored.' } },
        { seq: '3', outs: '1' }, // runner-only / no narrative -> skipped
      ] },
      { vh: 'H', id: 'SHERMAN', play: [
        { seq: '1', outs: '0', narrative: { text: 'Cole Carnes flied out to lf (0-2 KS).' } },
      ] },
    ] },
  ] },
};

test('summarizePlays: flattens narrated plays with inning/half and skips empties', () => {
  const p = summarizePlays(PLAYS);
  assert.equal(p.length, 3);
  assert.deepEqual(p[0], { inning: 1, half: 'top', team: 'LAKE CHA', outs: 0, scored: false, text: 'Nathan McDonald singled to third base (2-2 KBKFB).' });
  assert.equal(p[2].half, 'bot');
});

test('summarizePlays: flags run-scoring plays', () => {
  const p = summarizePlays(PLAYS);
  assert.equal(p[1].scored, true);   // "...scored."
  assert.equal(p[0].scored, false);
});

test('summarizePlays: no plays yields empty list', () => {
  assert.deepEqual(summarizePlays({}), []);
  assert.deepEqual(summarizePlays(null), []);
});

// ---- pitchersFromFeed: per-team live pitching lines -----------------------
const PITCHERS = { team: [
  { vh: 'V', name: 'Gators', teamId: GATORS, player: [
    { name: 'Tanner Trout', uni: '19', pitching: [{ ip: '1.1', h: '3', r: '5', er: '4', bb: '2', so: '0', hbp: '1', pitches: '38', strikes: '22', dec: 'L' }] },
    { name: 'Relief Guy', uni: '21', pitching: [{ ip: '0.0', h: '0', r: '0', er: '0', bb: '0', so: '0', pitches: '0' }] }, // not appeared -> dropped
    { name: 'A Hitter', uni: '7', hitting: { ab: 3, h: 1 } }, // no pitching -> skipped
  ] },
  { vh: 'H', name: 'Bison', teamId: 'ij0lwtvjsx2mi1nh', player: [
    { name: 'Cole Carnes', uni: '30', pitching: [{ ip: '5.0', hits: '4', runs: '2', earned: '2', walks: '1', k: '6', hb: '2', np: '72', balls: '24' }] }, // alt field spellings; S% from balls
  ] },
] };

test('pitchersFromFeed: lists appeared pitchers with their game line', () => {
  const p = pitchersFromFeed(PITCHERS);
  assert.equal(p.length, 2);
  assert.equal(p[0].isGators, true);
  assert.equal(p[0].rows.length, 1);                  // relief guy with no appearance dropped
  // S% = strikes/pitches = 22/38 = 58%
  assert.deepEqual(p[0].rows[0], { name: 'Tanner Trout', uni: '19', ip: '1.1', h: 3, r: 5, er: 4, bb: 2, k: 0, hbp: 1, np: 38, sp: 58, dec: 'L' });
});

test('pitchersFromFeed: matches alternate field spellings (hits/runs/earned/walks/k/np)', () => {
  const p = pitchersFromFeed(PITCHERS);
  const carnes = p[1].rows[0];
  // S% derived from balls: (72-24)/72 = 67%
  assert.deepEqual(carnes, { name: 'Cole Carnes', uni: '30', ip: '5.0', h: 4, r: 2, er: 2, bb: 1, k: 6, hbp: 2, np: 72, sp: 67, dec: '' });
});

test('pitchersFromFeed: missing team array yields empty list', () => {
  assert.deepEqual(pitchersFromFeed({}), []);
  assert.deepEqual(pitchersFromFeed(null), []);
});

test('pitchersFromFeed: the just-entered current pitcher shows instantly, before throwing', () => {
  const json = {
    status: { pitcher: ['Fresh Arm'] },
    team: [{ vh: 'V', name: 'Gators', teamId: GATORS, player: [
      { name: 'Starter', uni: '10', pitching: [{ ip: '5.0', h: '4', r: '2', er: '2', bb: '1', so: '5', pitches: '70', strikes: '45' }] },
      { name: 'Fresh Arm', uni: '28', pitching: [{ appear: '1' }] }, // just announced, no pitch data yet
    ] }],
  };
  const rows = pitchersFromFeed(json)[0].rows;
  assert.equal(rows.length, 2); // starter plus the reliever who just entered
  const fresh = rows.find(r => r.name === 'Fresh Arm');
  assert.deepEqual(fresh, { name: 'Fresh Arm', uni: '28', ip: '0.0', h: 0, r: 0, er: 0, bb: 0, k: 0, hbp: 0, np: null, sp: null, dec: '' });
});

test('applyLivePitchCount: current pitcher count climbs with the in-progress at-bat', () => {
  const live = { pitcher: 'Joe Arm', balls: 1, abPitches: 3,
    pitcherInfo: { name: 'Joe Arm', pitches: 20, strikes: 13, balls: 7 } };
  const pitchers = [{ isGators: true, rows: [{ name: 'Joe Arm', np: 20, sp: 65 }] }];
  applyLivePitchCount('lp-climb', live, pitchers);
  assert.equal(pitchers[0].rows[0].np, 23);        // 20 cumulative + 3 this at-bat
  assert.equal(live.pitcherInfo.pitches, 23);
  assert.equal(live.pitcherInfo.strikes, 15);      // 13 + (3 pitches - 1 ball)
  assert.equal(live.pitcherInfo.balls, 8);         // 7 + 1 ball, and 15 + 8 === 23
});

test('applyLivePitchCount: a just-entered pitcher (null cumulative) shows his at-bat pitches', () => {
  const pitchers = [{ rows: [{ name: 'Fresh Arm', np: null, sp: null }] }];
  applyLivePitchCount('lp-fresh', { pitcher: 'Fresh Arm', balls: 0, abPitches: 2 }, pitchers);
  assert.equal(pitchers[0].rows[0].np, 2);
});

test('applyLivePitchCount: no double-count when the cumulative absorbs the finished at-bat', () => {
  // poll 1 — mid at-bat: cumulative 20, three pitches thrown this at-bat
  applyLivePitchCount('lp-edge', { pitcher: 'Joe Arm', balls: 1, abPitches: 3,
    pitcherInfo: { name: 'Joe Arm', pitches: 20, strikes: 13, balls: 7 } },
    [{ rows: [{ name: 'Joe Arm', np: 20, sp: 65 }] }]);
  // poll 2 — at-bat just ended: cumulative jumped to 23, but status.np still
  // reports the finished at-bat (3) for one tick before it resets.
  const pitchers = [{ rows: [{ name: 'Joe Arm', np: 23, sp: 65 }] }];
  applyLivePitchCount('lp-edge', { pitcher: 'Joe Arm', balls: 1, abPitches: 3,
    pitcherInfo: { name: 'Joe Arm', pitches: 23, strikes: 15, balls: 8 } }, pitchers);
  assert.equal(pitchers[0].rows[0].np, 23);        // not 26 — the stale at-bat is suppressed
});

test('pitchingTotals: sums a team line, carrying innings by outs', () => {
  const rows = [
    { ip: '6.0', h: 6, r: 2, er: 2, bb: 0, k: 3, np: 89, sp: 64 },
    { ip: '1.2', h: 1, r: 1, er: 1, bb: 2, k: 1, np: 30, sp: 57 },
    { ip: '0.2', h: 0, r: 0, er: 0, bb: 1, k: 0, np: 11, sp: 55 },
  ];
  const t = pitchingTotals(rows);
  assert.equal(t.ip, '8.1');          // 18 + 5 + 2 = 25 outs = 8 1/3
  assert.equal(t.h, 7); assert.equal(t.r, 3); assert.equal(t.er, 3);
  assert.equal(t.bb, 3); assert.equal(t.k, 4);
  assert.equal(t.np, 130);            // 89 + 30 + 11
  // strikes: round(.64*89)+round(.57*30)+round(.55*11) = 57+17+6 = 80; 80/130 = 62%
  assert.equal(t.sp, 62);
});

test('pitchingTotals: a just-entered pitcher (no pitch count) does not break the total', () => {
  const t = pitchingTotals([
    { ip: '2.0', h: 1, r: 0, er: 0, bb: 1, k: 4, np: 28, sp: 60 },
    { ip: '0.0', h: 0, r: 0, er: 0, bb: 0, k: 0, np: null, sp: null }, // just entered
  ]);
  assert.equal(t.ip, '2.0');
  assert.equal(t.np, 28);             // null pitch count ignored
  assert.equal(t.k, 4);
});

test('pitchersFromFeed: a non-appeared, non-current pitcher is still dropped', () => {
  const json = {
    status: { pitcher: ['Someone Else'] },
    team: [{ vh: 'V', name: 'Gators', teamId: GATORS, player: [
      { name: 'Idle Arm', uni: '40', pitching: [{ appear: '1' }] }, // in the pen, not the current pitcher
    ] }],
  };
  assert.deepEqual(pitchersFromFeed(json), []);
});

test('applyPitcherOverrides: rewrites a placeholder pitcher across the live card and box row', () => {
  const overrides = [{ gameId: null, from: 'Emergency Player', name: 'Cameron Carlile', uni: '21' }];
  const live = { pitcher: 'Emergency Player', pitcherInfo: { name: 'Emergency Player', uni: '0' } };
  const pitchers = [{ vh: 'V', rows: [{ name: 'Emergency Player', uni: '0', ip: '1.0', er: 2 }] }];
  applyPitcherOverrides('anygame', live, pitchers, overrides);
  assert.equal(live.pitcher, 'Cameron Carlile');
  assert.equal(live.pitcherInfo.name, 'Cameron Carlile');
  assert.equal(live.pitcherInfo.uni, '21');
  assert.equal(pitchers[0].rows[0].name, 'Cameron Carlile');
  assert.equal(pitchers[0].rows[0].uni, '21');
  assert.equal(pitchers[0].rows[0].ip, '1.0'); // stat line preserved
});

test('applyPitcherOverrides: matches the feed\'s SHOUTED placeholder name', () => {
  const overrides = [{ gameId: null, from: 'Emergency Player', name: 'Cameron Carlile', uni: '21' }];
  const live = { pitcher: 'EMERGENCY PLAYER', pitcherInfo: { name: 'EMERGENCY PLAYER', uni: '0' } };
  applyPitcherOverrides('anygame', live, [], overrides);
  assert.equal(live.pitcher, 'Cameron Carlile');
  assert.equal(live.pitcherInfo.uni, '21');
});

test('applyPitcherOverrides: leaves a real (non-placeholder) pitcher untouched', () => {
  const overrides = [{ gameId: null, from: 'Emergency Player', name: 'Cameron Carlile', uni: '21' }];
  const live = { pitcher: 'Hogan Shelby', pitcherInfo: { name: 'Hogan Shelby', uni: '14' } };
  const pitchers = [{ vh: 'V', rows: [{ name: 'Hogan Shelby', uni: '14' }] }];
  applyPitcherOverrides('anygame', live, pitchers, overrides);
  assert.equal(live.pitcher, 'Hogan Shelby');
  assert.equal(pitchers[0].rows[0].uni, '14');
});

test('applyPitcherOverrides: a gameId-scoped entry only fires for that game', () => {
  const overrides = [{ gameId: '20260704_abcd', from: 'Emergency Player', name: 'Cameron Carlile', uni: '21' }];
  const other = { pitcher: 'Emergency Player', pitcherInfo: { name: 'Emergency Player', uni: '0' } };
  applyPitcherOverrides('20260705_zzzz', other, [], overrides);
  assert.equal(other.pitcher, 'Emergency Player'); // different game, untouched
  const match = { pitcher: 'Emergency Player', pitcherInfo: { name: 'Emergency Player', uni: '0' } };
  applyPitcherOverrides('20260704_abcd', match, [], overrides);
  assert.equal(match.pitcher, 'Cameron Carlile');
});
