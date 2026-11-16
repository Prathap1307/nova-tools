import test from 'node:test';
import assert from 'node:assert/strict';
import { compareAudits, findingId } from '../audit/compare.mjs';
import { compareRenderedFields } from '../audit/rendered-fields.mjs';
import { auditCsv } from '../audit/csv.mjs';

const url = path => 'https://example.com/' + path;
const data = (path, day = 1, overrides = {}) => ({
  requestedUrl: url(path), finalUrl: url(path), snapshotId: day,
  observedAt: '2026-11-0' + day + 'T00:00:00Z', captureMode: 'browser', extractionVersion: 3,
  ...overrides
});
const page = (capture, outcome = 'usable') => ({ requestedUrl: capture.requestedUrl, capture, outcome });
const group = (code, affected, key = '') => ({ id: findingId(code, key), code, severity: 'low',
  message: 'Finding', nextStep: 'Review', affected, affectedCount: affected.length });

test('classifies paired fields without conflating missing and unchanged', () => {
  const result = compareRenderedFields({ title: 'Shell', canonical: url(''), robots: 'noindex' },
    { title: 'FAQ', canonical: url(''), description: 'Answers' });
  assert.deepEqual(Object.values(result).map(item => item.status),
    ['unchanged', 'changed', 'added', 'removed', 'unchanged']);
  assert.deepEqual(result.robots, { raw: 'noindex', rendered: null, status: 'removed' });
});

test('reports new, persistent, resolved, and unverified with mode and freshness requirements', () => {
  const paths = ['stays', 'fixed', 'omitted', 'failed', 'mode-changed', 'old', 'extractor-changed'];
  const previous = { findings: [group('missing_title', paths.map(path => data(path)))] };
  const current = { findings: [group('missing_title', [data('stays', 2), data('new', 2)])],
    pages: [page(data('fixed', 2)), page(data('failed', 2), 'failed'),
      page(data('mode-changed', 2, { captureMode: 'http' })), page(data('old')),
      page(data('extractor-changed', 2, { extractionVersion: 4 }))] };
  const result = compareAudits(previous, current);
  assert.deepEqual(result.totals, { new: 1, still_present: 1, resolved: 1, unverified: 5 });
  const lookup = Object.fromEntries(result.entries.map(entry => [entry.requestedUrl, entry]));
  assert.match(lookup[url('omitted')].reason, /absent/);
  assert.match(lookup[url('failed')].reason, /unusable/);
  assert.match(lookup[url('mode-changed')].reason, /mode/);
  assert.match(lookup[url('old')].reason, /newer/);
  assert.match(lookup[url('extractor-changed')].reason, /version/);
});

test('does not resolve a duplicate group until peer captures are comparable', () => {
  const previous = { findings: [group('duplicate_title', [data('a'), data('b')], 'example.com\0title')] };
  const current = { findings: [], pages: [page(data('a', 2))] };
  assert.equal(compareAudits(previous, current).totals.unverified, 2);
  current.pages.push(page(data('b', 2)));
  assert.equal(compareAudits(previous, current).totals.resolved, 2);
});

test('compares browser-only findings to newer raw evidence', () => {
  const prior = { ...data('faq'), raw: data('faq', 1, { captureMode: 'http' }) };
  const current = { findings: [], pages: [page(data('faq', 2, { captureMode: 'http' }))] };
  const result = compareAudits({ findings: [group('browser_only_content', [prior])] }, current);
  assert.equal(result.totals.resolved, 1);
  assert.equal(result.entries[0].after.captureMode, 'http');
});

test('CSV contains one row per finding and page and escapes quotes and spreadsheet formulas', () => {
  const item = { ...data('faq'), declaredCanonical: url('') };
  const finding = { ...group('duplicate_title', [item]), value: '=1+1', message: 'Same "title"' };
  const csv = auditCsv({ findings: [finding], pages: [{ ...page(item), raw: { snapshotId: 12 } }] });
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /"Snapshot ID","Raw Snapshot ID"/);
  assert.ok(lines[1].includes('"Same ""title"""'));
  assert.ok(lines[1].includes("\"'=1+1\""));
  assert.match(lines[1], /"1","12","browser"/);
});
