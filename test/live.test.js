'use strict';
// Tests for the live-situation feed parsers: extractEventAuth (pull the feed's
// event id + access hash out of a boxscore page), summarizeLive (boil the status
// block down), and teamLineScores (per-team runs/hits/errors).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractEventAuth, summarizeLive, teamLineScores, summarizePlays } = require('../server');

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
