'use strict';
// Tests for the live-situation feed parsers: extractEventAuth (pull the feed's
// event id + access hash out of a boxscore page), summarizeLive (boil the status
// block down), and teamLineScores (per-team runs/hits/errors).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractEventAuth, summarizeLive, teamLineScores, summarizePlays, pitchersFromFeed } = require('../server');

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
    { name: 'Tanner Trout', uni: '19', pitching: [{ ip: '1.1', h: '3', r: '5', er: '4', bb: '2', so: '0', pitches: '38', dec: 'L' }] },
    { name: 'Relief Guy', uni: '21', pitching: [{ ip: '0.0', h: '0', r: '0', er: '0', bb: '0', so: '0', pitches: '0' }] }, // not appeared -> dropped
    { name: 'A Hitter', uni: '7', hitting: { ab: 3, h: 1 } }, // no pitching -> skipped
  ] },
  { vh: 'H', name: 'Bison', teamId: 'ij0lwtvjsx2mi1nh', player: [
    { name: 'Cole Carnes', uni: '30', pitching: [{ ip: '5.0', hits: '4', runs: '2', earned: '2', walks: '1', k: '6', np: '72' }] }, // alt field spellings
  ] },
] };

test('pitchersFromFeed: lists appeared pitchers with their game line', () => {
  const p = pitchersFromFeed(PITCHERS);
  assert.equal(p.length, 2);
  assert.equal(p[0].isGators, true);
  assert.equal(p[0].rows.length, 1);                  // relief guy with no appearance dropped
  assert.deepEqual(p[0].rows[0], { name: 'Tanner Trout', uni: '19', ip: '1.1', h: 3, r: 5, er: 4, bb: 2, k: 0, np: 38, dec: 'L' });
});

test('pitchersFromFeed: matches alternate field spellings (hits/runs/earned/walks/k/np)', () => {
  const p = pitchersFromFeed(PITCHERS);
  const carnes = p[1].rows[0];
  assert.deepEqual(carnes, { name: 'Cole Carnes', uni: '30', ip: '5.0', h: 4, r: 2, er: 2, bb: 1, k: 6, np: 72, dec: '' });
});

test('pitchersFromFeed: missing team array yields empty list', () => {
  assert.deepEqual(pitchersFromFeed({}), []);
  assert.deepEqual(pitchersFromFeed(null), []);
});
