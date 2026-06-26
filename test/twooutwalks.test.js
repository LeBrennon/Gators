'use strict';
// Regression test for computeBoxStats() two-out-walk detection. A walk play
// carries no out annotation of its own (the "(N out)" sits on the previous out
// play), so the count must come from tracking the running out total through the
// half-inning — not from grepping the walk line for "2 outs".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../scripts/postgame-report.js');
const S = require('../scripts/lib/season');

const fielding = () => (S.resolveGame('latest').home ? 'top' : 'bot');
const tr = s => '<tr><td>' + s + '</td></tr>';

test('computeBoxStats: counts a walk issued with two outs', () => {
  const half = { side: fielding(), html:
    tr('Donnato popped out to 2b (2-0 BB). (1 out)') +
    tr('Montanez struck out looking (2-2 KBKBK). (2 out)') +
    tr('Cooper reached on a fielding error by 2b (1-1 BK).') +
    tr('Dunn singled to left (3-2 BFBBF); Cooper to second.') +
    tr('Duran walked (3-0 BBBB); Dunn to second; Cooper to third.') +
    tr('Motley flied out to rf (0-0). (3 out)') };
  assert.equal(P.computeBoxStats([half], '').twoOutWalks, 1);
});

test('computeBoxStats: does not count a walk issued before two outs', () => {
  const half = { side: fielding(), html:
    tr('Leadoff walked (3-1 BBKB).') +
    tr('Next struck out (0-2 KKK). (1 out)') +
    tr('Third flied out (1-1 BK). (2 out)') +
    tr('Fourth grounded out (0-0). (3 out)') };
  assert.equal(P.computeBoxStats([half], '').twoOutWalks, 0);
});
