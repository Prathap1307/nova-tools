import { readCsv } from './csv.mjs';
import { operationsReport } from './reports.mjs';

function timestamp(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const midnight = new Date(match[1]);
  return Number.isFinite(+midnight) && midnight.toISOString().startsWith(match[1] + 'T');
}

export function analyzeBookingCsv(input, { date, timeZone = 'Europe/London' }) {
  const [header, ...rows] = readCsv(input);
  const columns = header?.cells.map(cell => cell.trim()) ?? [];
  const required = ['id', 'terminal', 'status', 'createdAt', 'pickupAt'];
  if (new Set(columns).size !== columns.length || !required.every(name => columns.includes(name)))
    throw new Error('Expected unique headers including ' + required.join(', '));

  const ids = new Map();
  for (const { cells } of rows) {
    const id = cells[columns.indexOf('id')]?.trim();
    if (id) ids.set(id, (ids.get(id) ?? 0) + 1);
  }

  const findings = [];
  const bookings = [];
  const pickups = [];
  let rejected = 0;
  for (const { line, cells } of rows) {
    const add = (code, severity = 'error') => findings.push({ line, code, severity });
    if (cells.length !== columns.length) {
      add('wrong-column-count');
      rejected++;
      continue;
    }
    const { id, terminal, status, createdAt, pickupAt } = Object.fromEntries(
      columns.map((name, index) => [name, cells[index].trim()]));
    const initial = findings.length;
    if (!id) add('missing-id');
    else if (ids.get(id) > 1) add('duplicate-id');
    if (!terminal) add('missing-terminal');
    if (!['confirmed', 'pending', 'cancelled'].includes(status)) add('invalid-status');
    if (!timestamp(createdAt)) add('invalid-created-at');
    if (findings.length !== initial) {
      rejected++;
      continue;
    }

    bookings.push({ id, terminal, status, createdAt });
    if (!pickupAt) {
      if (status === 'confirmed') add('missing-pickup-at', 'warning');
    } else if (!timestamp(pickupAt)) {
      add('invalid-pickup-at', 'warning');
    } else if (status === 'confirmed') {
      pickups.push({ id, terminal, status, createdAt: pickupAt });
    }
  }

  return { date, timeZone, rowsRead: rows.length, rejected, findings,
    bookingsReceived: operationsReport({ date, timeZone, bookings }).terminals,
    scheduledPickups: Object.fromEntries(Object.entries(
      operationsReport({ date, timeZone, bookings: pickups }).terminals)
      .map(([terminal, counts]) => [terminal, counts.confirmed])) };
}
