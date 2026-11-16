import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonitorReport } from '../monitor/check.mjs';
import { openMonitor, readHistory, saveRun } from '../monitor/store.mjs';

const site = 'https://example.com';
const date = hour => '2026-11-16T' + hour + ':00Z';
const url = path => site + '/' + path;
const link = (path, outcome, checkedAt, status) => ({ url: url(path), outcome,
  checkedAt: date(checkedAt), status, quoteOrBooking: true, sources: [] });
const links = (...results) => ({ site, mode: 'auto', results });
const journey = (outcome, checkedAt, failure = 'quote_controls') => ({
  id: 'terminal-3', sourceUrl: url('terminal-3'), outcome, checkedAt: date(checkedAt),
  cta: 'Book T3', viewport: { width: 412, height: 915 }, expected: {},
  steps: outcome === 'pass' ? [] : [{ name: failure, outcome: 'fail' }]
});
const capture = (path, hour) => ({ requestedUrl: url(path), finalUrl: url(path), snapshotId: hour,
  observedAt: date(hour), captureMode: 'browser', extractionVersion: 4 });
const page = (path, hour) => ({ requestedUrl: url(path), outcome: 'usable', capture: capture(path, hour) });
const audit = (pages, affected) => ({ hostname: 'example.com', pages, findings: affected.length ? [{
  id: 'homepage_canonical:https%3A%2F%2Fexample.com%2F', code: 'homepage_canonical', severity: 'high', affected
}] : [] });

test('persists a baseline and detects link and journey regressions, a canonical fix and omissions', t => {
  const db = openMonitor(':memory:');
  t.after(() => db.close());
  const baseline = {
    crawl: { site, snapshots: [], discovered: 4, attempted: 4, usable: 4 },
    audit: audit([page('faq', '10:00'), page('news', '10:00')], [capture('faq', '10:00'), capture('news', '10:00')]),
    links: links(link('quote', 'healthy', '10:00', 200), link('help', 'healthy', '10:00', 200)),
    journey: journey('pass', '10:00')
  };
  const first = saveRun(db, buildMonitorReport(site, [], baseline), baseline);
  assert.equal(first.runId, 1);
  assert.equal(first.baseline, true);
  const current = {
    audit: audit([page('faq', '11:00')], []),
    links: links(link('quote', 'broken', '11:00', 404)),
    journey: journey('fail', '11:00'),
    retries: { links: links(link('quote', 'broken', '11:01', 404)), journey: journey('pass', '11:01') }
  };
  const second = saveRun(db, buildMonitorReport(site, readHistory(db, site), current), current);
  assert.equal(second.previousRunId, 1);
  assert.deepEqual(second.totals, { regression: 2, new: 0, still_present: 0, resolved: 1, unverified: 2 });
  assert.equal(second.tools.find(row => row.kind === 'journey').confirmation, 'intermittent');
  assert.equal(second.tools.find(row => row.key === url('quote')).confirmation, 'confirmed');
  assert.equal(second.tools.find(row => row.key === url('quote')).lastHealthyAt, date('10:00'));
  assert.equal(second.auditGroups[0].pages.find(row => row.requestedUrl === url('news')).status, 'unverified');
  assert.equal(db.prepare('SELECT count(*) AS total FROM monitor_runs').get().total, 2);
  const third = buildMonitorReport(site, readHistory(db, site), { audit: audit([page('news', '12:00')], []) });
  assert.equal(third.auditGroups[0].pages[0].status, 'resolved');
  assert.equal(third.auditGroups[0].pages[0].requestedUrl, url('news'));
});

test('rejects stale or different-configuration retries and prevents unsafe recovery claims', () => {
  const history = [{ id: 7, artifacts: { links: links(link('quote', 'broken', '10:00', 404)),
    journey: journey('pass', '10:00') } }];
  const current = {
    links: { ...links(link('quote', 'healthy', '11:00', 200)), mode: 'http' },
    journey: journey('fail', '11:00'),
    retries: { journey: journey('fail', '11:01', 'destination') }
  };
  const report = buildMonitorReport(site, history, current);
  assert.equal(report.tools.find(row => row.kind === 'links').status, 'unverified');
  assert.equal(report.tools.find(row => row.kind === 'journey').confirmation, 'unverified');
  current.retries.journey = journey('pass', '11:45');
  assert.equal(buildMonitorReport(site, history, current).tools[0].confirmation, 'pending');
  assert.throws(() => buildMonitorReport(site, [], { links: { site: 'https://other.example', results: [] } }), /does not match/);
});
