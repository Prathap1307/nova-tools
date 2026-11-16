import { inspectHeaders } from '../security/headers.mjs';

export function accessReport({ cases }) {
  return cases.map(({ name, expected, observed }) => {
    const statusMatches = expected.statuses.includes(observed.status);
    const dataMatches = expected.bookingId === (observed.bookingId ?? null);
    return { name, passed: statusMatches && dataMatches && observed.stateChanged === expected.stateChanged,
      expected, observed: { status: observed.status, stateChanged: observed.stateChanged, bookingMatches: dataMatches } };
  });
}

export function healthReport({ checks }) {
  return checks.map(({ id, url, status, elapsedMs, maxMs, requiredFields = [], body, certificateExpiresAt, checkedAt, headers }) => {
    const failures = [];
    if (!Number.isInteger(status) || status < 200 || status >= 300) failures.push('HTTP request unsuccessful');
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || !Number.isFinite(maxMs) || maxMs <= 0 || elapsedMs > maxMs) failures.push('Response time outside budget');
    for (const field of requiredFields) {
      if (!body || !Object.hasOwn(body, field) || body[field] == null) failures.push('Missing response field ' + field);
    }
    if (certificateExpiresAt != null) {
      const remaining = Date.parse(certificateExpiresAt) - Date.parse(checkedAt);
      if (!Number.isFinite(remaining) || remaining <= 0) failures.push('Certificate expiry invalid or expired');
      else if (remaining <= 14 * 86400000) failures.push('Certificate expires within 14 days');
    }
    return { id, passed: failures.length === 0, failures,
      headers: headers && inspectHeaders({
        status, url, headers
      }) };
  });
}

function unique(rows, key) {
  const index = new Map();
  for (const row of rows) {
    const id = row[key];
    if (typeof id !== 'string' || !id.trim() || index.has(id)) throw new Error('Missing or duplicate ' + key);
    index.set(id, row);
  }
  return index;
}

function minor(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Amounts must be nonnegative safe integers in minor units');
  return value;
}

function add(left, right) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new Error('Amount exceeds integer precision');
  return sum;
}

export function operationsReport({ bookings, date, timeZone }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date)
    throw new Error('Invalid report date');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const terminals = new Map();
  for (const booking of unique(bookings, 'id').values()) {
    const { terminal, createdAt, status } = booking;
    if (typeof terminal !== 'string' || !terminal.trim() || !['confirmed', 'cancelled', 'pending'].includes(status))
      throw new Error('Invalid booking terminal or status');
    const parts = Object.fromEntries(formatter.formatToParts(new Date(createdAt)).map(({ type, value }) => [type, value]));
    if ([parts.year, parts.month, parts.day].join('-') !== date) continue;
    const counts = terminals.get(terminal) ?? { confirmed: 0, cancelled: 0, pending: 0 };
    counts[status]++;
    terminals.set(terminal, counts);
  }
  return { date, timeZone, terminals: Object.fromEntries(terminals) };
}

export function financeReport({ currency, bookings, transactions, payouts }) {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Expected one ISO currency code');
  const bookingIndex = unique(bookings, 'id');
  const payoutIndex = unique(payouts, 'id');
  const received = new Map();
  const settled = new Map();
  const findings = [];
  for (const row of [...bookings, ...transactions, ...payouts]) {
    if (row.currency !== currency) throw new Error('Mixed currencies');
    minor(row.amount);
  }

  for (const { id, bookingId, payoutId, kind, amount } of unique(transactions, 'id').values()) {
    if (!['payment', 'refund', 'fee'].includes(kind)) throw new Error('Unknown transaction kind');
    if (kind !== 'fee') {
      if (!bookingIndex.has(bookingId)) findings.push({ type: 'unknown-booking', id, bookingId });
      received.set(bookingId, add(received.get(bookingId) ?? 0, kind === 'payment' ? amount : -amount));
    }
    if (payoutId == null) findings.push({ type: 'unsettled-transaction', id });
    else {
      if (!payoutIndex.has(payoutId)) findings.push({ type: 'unknown-payout', id, payoutId });
      settled.set(payoutId, add(settled.get(payoutId) ?? 0, kind === 'payment' ? amount : -amount));
    }
  }
  function compare(rows, totals, type) {
    for (const { id, amount } of rows) {
      const actual = totals.get(id) ?? 0;
      if (actual !== amount) findings.push({ type, id, expected: amount, actual });
    }
  }
  compare(bookings, received, 'booking-mismatch');
  compare(payouts, settled, 'payout-mismatch');
  return { currency, findings };
}

export function marketingReport({ sessions, campaigns }) {
  const byCampaign = new Map();
  for (const { id, spend } of unique(campaigns, 'id').values()) {
    byCampaign.set(id, { spend: minor(spend), visits: 0, quotes: 0, bookings: 0, revenue: 0 });
  }
  const bookingIds = new Set();
  for (const { campaign, quoteStarted, bookingId, revenue = 0 } of unique(sessions, 'id').values()) {
    if (typeof quoteStarted !== 'boolean') throw new Error('Expected a boolean quoteStarted');
    const row = byCampaign.get(campaign);
    if (!row) throw new Error('Unknown campaign');
    row.visits++;
    if (quoteStarted) row.quotes++;
    if (bookingId != null) {
      if (!quoteStarted || typeof bookingId !== 'string' || !bookingId.trim() || bookingIds.has(bookingId))
        throw new Error('Invalid or duplicate conversion');
      bookingIds.add(bookingId);
      row.bookings++;
      row.revenue = add(row.revenue, minor(revenue));
    } else if (revenue !== 0) throw new Error('Revenue without a booking');
  }
  return Object.fromEntries([...byCampaign].map(([id, row]) => [id, { ...row,
    bookingRate: row.visits ? row.bookings / row.visits : null,
    costPerBooking: row.bookings ? Math.round(row.spend / row.bookings) : null }]));
}

export function supportReport({ questions }) {
  return [...unique(questions, 'id').values()].map(({ id, question, url, answer, expectedFacts, snapshotText }) => {
    const normalize = value => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!Array.isArray(expectedFacts) || !expectedFacts.length || expectedFacts.some(fact => !normalize(fact)))
      throw new Error('Supply nonempty facts for each question');
    const excerpt = normalize(answer ?? '');
    const found = excerpt !== '' && normalize(snapshotText ?? '').includes(excerpt);
    const missingFacts = expectedFacts.filter(fact => !found || !excerpt.includes(normalize(fact)));
    return { id, question, url, status: !found ? 'missing' : missingFacts.length ? 'partial' : 'answered',
      evidence: found ? answer : null, missingFacts };
  });
}
