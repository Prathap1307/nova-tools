import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readCsv } from '../business/csv.mjs';
import { analyzeBookingCsv } from '../business/booking-csv.mjs';

test('CSV handles BOM, quoted line breaks, escaped quotes and trailing cells', () => {
  assert.deepEqual(readCsv('\uFEFFa,b,c\r\n"x""y\r\nz",end,\r\nlast,field,'), [
    { line: 1, cells: ['a', 'b', 'c'] },
    { line: 2, cells: ['x"y\r\nz', 'end', ''] },
    { line: 4, cells: ['last', 'field', ''] }
  ]);
  assert.throws(() => readCsv('ok\n"unterminated'), /line 2/);
});

test('booking CSV separates received bookings and pickups, and reports row issues', () => {
  const csv = readFileSync(new URL('./fixtures/bookings-sample.csv', import.meta.url), 'utf8');
  const report = analyzeBookingCsv(csv, { date: '2026-06-02' });
  assert.equal(report.bookingsReceived['Heathrow, T3'].confirmed, 1);
  assert.deepEqual(report.bookingsReceived.T5, { confirmed: 0, pending: 1, cancelled: 1 });
  assert.deepEqual(report.scheduledPickups, {});
  assert.deepEqual(analyzeBookingCsv(csv, { date: '2026-06-03' }).scheduledPickups, { 'Heathrow, T3': 1 });
  assert.equal(report.rejected, 3);
  assert.deepEqual(report.findings.map(({ line, code }) => [line, code]), [
    [5, 'missing-pickup-at'], [6, 'duplicate-id'], [7, 'duplicate-id'], [8, 'invalid-created-at']
  ]);
});

test('London autumn clock change supports both offset-qualified occurrences', () => {
  const csv = 'id,terminal,status,createdAt,pickupAt\n' +
    'a,T3,confirmed,2026-10-24T23:15Z,2026-10-25T01:30+01:00\n' +
    'b,T3,confirmed,2026-10-25T01:30+00:00,2026-10-25T01:30+00:00\n' +
    'c,T3,confirmed,2026-10-25T01:30,\n' +
    'd,T3,confirmed,2026-10-25T02:30Z,invalid\n' +
    'e,T3';
  const report = analyzeBookingCsv(csv, { date: '2026-10-25' });
  assert.equal(report.bookingsReceived.T3.confirmed, 3);
  assert.deepEqual(report.scheduledPickups, { T3: 2 });
  assert.deepEqual(report.findings.map(row => row.code), ['invalid-created-at', 'invalid-pickup-at', 'wrong-column-count']);
  assert.throws(() => analyzeBookingCsv('id,status\na,confirmed', { date: '2026-10-25' }), /headers/);
});
