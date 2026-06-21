'use strict';
// Tests for ticketCandidates(): build the TicketSpice URL(s) for a Gators home
// game so the server can verify which one is real before showing a button.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ticketCandidates } = require('../server');

const BASE = 'https://gumbeauxgators.ticketspice.com/lake-charles-gumbeaux-gators-vs-';

test('ticketCandidates: builds the known home-game slug', () => {
  const c = ticketCandidates({ gatorsHome: true, state: 'scheduled', date: '20260627', opponent: { name: 'Baton Rouge Rougarou' } });
  assert.ok(c.includes(BASE + 'baton-rouge-rougarou-62726'));
});

test('ticketCandidates: offers padded and unpadded day for single-digit days', () => {
  const c = ticketCandidates({ gatorsHome: true, state: 'scheduled', date: '20260605', opponent: { name: 'Acadiana Cane Cutters' } });
  assert.ok(c.includes(BASE + 'acadiana-cane-cutters-60526')); // padded day
  assert.ok(c.includes(BASE + 'acadiana-cane-cutters-6526'));  // unpadded day
});

test('ticketCandidates: only for upcoming Gators home games', () => {
  const opp = { name: 'Victoria Generals' };
  assert.deepEqual(ticketCandidates({ gatorsHome: false, state: 'scheduled', date: '20260627', opponent: opp }), []); // away
  assert.deepEqual(ticketCandidates({ gatorsHome: true, state: 'final', date: '20260627', opponent: opp }), []);      // finished
});
