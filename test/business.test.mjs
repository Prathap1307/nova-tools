import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessReport, healthReport, operationsReport, financeReport, marketingReport, supportReport } from '../business/reports.mjs';

test('access records distinguish denied, leaked, allowed, and mutated bookings', () => {
  const denied = { statuses: [403, 404], bookingId: null, stateChanged: false };
  const cases = [
    { expected: denied, observed: { status: 404, stateChanged: false } },
    { expected: denied, observed: { status: 403, bookingId: 'other', stateChanged: false } },
    { expected: { ...denied, statuses: [200], bookingId: 'own' },
      observed: { status: 200, bookingId: 'own', stateChanged: false } },
    { expected: denied, observed: { status: 403, stateChanged: true } }
  ];
  assert.deepEqual(accessReport({ cases }).map(row => row.passed), [true, false, true, false]);
});

test('health detects errors, slowness, response contract gaps, and expiry', () => {
  const check = { id: 'api', status: 200, elapsedMs: 30, maxMs: 40, requiredFields: ['count'],
    body: { count: 0 }, checkedAt: '2026-01-01', certificateExpiresAt: '2026-02-01' };
  assert.equal(healthReport({ checks: [check] })[0].passed, true);
  assert.equal(healthReport({ checks: [{ ...check, status: 500, elapsedMs: 50, body: {},
    certificateExpiresAt: '2025-12-31' }] })[0].failures.length, 4);
});

test('operations respects London date boundaries and rejects duplicates', () => {
  const row = { id: 'a', terminal: 'T3', status: 'confirmed', createdAt: '2026-06-01T23:30:00Z' };
  const input = { date: '2026-06-02', timeZone: 'Europe/London', bookings: [row] };
  assert.equal(operationsReport(input).terminals.T3.confirmed, 1);
  assert.deepEqual(operationsReport({ ...input, timeZone: 'UTC' }).terminals, {});
  assert.throws(() => operationsReport({ ...input, bookings: [row, row] }), /duplicate/);
});

test('finance matches payments less refunds and fees and flags missing records', () => {
  const gbp = row => ({ ...row, currency: 'GBP' });
  const input = { currency: 'GBP', bookings: [gbp({ id: 'b', amount: 800 })],
    payouts: [gbp({ id: 'p', amount: 700 })], transactions: [
      gbp({ id: 'a', bookingId: 'b', payoutId: 'p', kind: 'payment', amount: 1000 }),
      gbp({ id: 'b', bookingId: 'b', payoutId: 'p', kind: 'refund', amount: 200 }),
      gbp({ id: 'c', payoutId: 'p', kind: 'fee', amount: 100 })
    ] };
  assert.deepEqual(financeReport(input).findings, []);
  assert.deepEqual(financeReport({ ...input, payouts: [] }).findings.map(row => row.type),
    ['unknown-payout', 'unknown-payout', 'unknown-payout']);
  assert.throws(() => financeReport({ ...input, payouts: [{ ...input.payouts[0], currency: 'USD' }] }), /Mixed currencies/);
});

test('marketing reports funnel and empty denominators and catches double attribution', () => {
  const row = { id: 's', campaign: 'a', quoteStarted: true, bookingId: 'b', revenue: 500 };
  const input = { campaigns: [{ id: 'a', spend: 250 }, { id: 'empty', spend: 0 }], sessions: [row] };
  const result = marketingReport(input);
  assert.equal(result.a.costPerBooking, 250);
  assert.equal(result.empty.bookingRate, null);
  assert.throws(() => marketingReport({ ...input, sessions: [row, { ...row, id: 's2' }] }), /duplicate/);
});

test('support requires an excerpt actually present in the snapshot', () => {
  const row = { id: 'q', question: 'Where?', url: 'https://example.com/faq', answer: 'Level 4',
    expectedFacts: ['Level 4'], snapshotText: 'Use LEVEL 4.' };
  assert.equal(supportReport({ questions: [row] })[0].status, 'answered');
  assert.equal(supportReport({ questions: [{ ...row, expectedFacts: ['Level 4', 'Zone B'] }] })[0].status, 'partial');
  assert.equal(supportReport({ questions: [{ ...row, snapshotText: '' }] })[0].status, 'missing');
});
