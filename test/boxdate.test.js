'use strict';
// The box-score modal shows the game's date so you can tell which game you
// opened. That date is derived client-side by boxDate(), which lives inside the
// big APP template literal — where a lone backslash in a regex escape (e.g. \d)
// is dropped between the server source and the shipped page, quietly turning
// /^(\d{4})/ into /^(d{4})/ and making boxDate() return '' for every real id.
// These tests execute boxDate() exactly as it ships to catch that regression.
const test = require('node:test');
const assert = require('node:assert');
const { APP } = require('../server');

// Pull the shipped boxDate() source straight out of the rendered page and run it,
// so we test the string the browser actually receives (post-template-literal),
// not the pre-render source in server.js.
function shippedBoxDate() {
  const m = /function boxDate\(id\)\{[\s\S]*?return mon\?[^}]*\}/.exec(APP);
  assert.ok(m, 'boxDate() should be present in the shipped client script');
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '\nreturn boxDate;')();
}

test('shipped boxDate resolves a real box id to a readable date', () => {
  const boxDate = shippedBoxDate();
  assert.strictEqual(boxDate('20260708_1me5'), 'Jul 8, 2026');
  assert.strictEqual(boxDate('20260709_t3f4'), 'Jul 9, 2026');
  assert.strictEqual(boxDate('20260602_ixiv'), 'Jun 2, 2026');
});

test('shipped boxDate returns empty for ids without a leading YYYYMMDD', () => {
  const boxDate = shippedBoxDate();
  assert.strictEqual(boxDate('manual_x'), '');
  assert.strictEqual(boxDate(''), '');
  assert.strictEqual(boxDate(null), '');
});

test('shipped boxDate regex was not stripped of its digit class by the template literal', () => {
  // The bug shipped /^(d{4})(d{2})(d{2})/, which matches literal "d" chars, so a
  // numeric id never matched. Guard against any regex that keys on a literal "d".
  assert.ok(!/\(d\{4\}\)/.test(APP), 'shipped boxDate must not contain a (d{4}) literal-d regex');
});
