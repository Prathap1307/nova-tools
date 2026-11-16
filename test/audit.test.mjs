import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, scanPage } from '../crawler/scan.mjs';
import { auditSite } from '../audit/check.mjs';

const root = 'https://example.com';
const html = (body, headers = {}) => ({
  status: 200, headers: { 'content-type': 'text/html', ...headers }, body: Buffer.from(body)
});
const missingRobots = { status: 404, headers: {}, body: Buffer.alloc(0) };
const network = page => async url => url.pathname === '/robots.txt' ? missingRobots : page;

test('groups homepage canonicals and duplicate metadata with browser evidence', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const raw = html('<title>Generic shell</title><link rel="canonical" href="/"><div></div>');
  const rendered = html('<title> Shared  title </title><meta name="description" content="Shared description">'
    + '<link rel="canonical" href="/"><main><h1>Parking information</h1></main>');
  const renderer = { async render(source) { return { ...source, ...rendered }; } };
  for (const path of ['/faq', '/terminal-3']) {
    await scanPage(db, root + path, { mode: 'auto', fetcher: network(raw), renderer });
  }
  const report = auditSite(db, { hostname: 'example.com' });
  assert.deepEqual(report.totals, { pages: 2, usable: 2, noUsableContent: 0, failed: 0, browserOnlyContent: 2 });
  assert.deepEqual(report.findings.map(group => group.code),
    ['homepage_canonical', 'duplicate_title', 'duplicate_description', 'browser_only_content']);
  assert.equal(report.findings[0].affectedCount, 2);
  assert.equal(report.findings[0].affected[1].declaredCanonical, root + '/');
  assert.equal(report.findings[1].value, 'Shared title');
  assert.equal(report.findings[3].affected[0].raw.captureMode, 'http');
  assert.equal(report.findings[3].affected[0].captureMode, 'browser');
});

test('checks headers, usable metadata, failed scans and host scope', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const page = html('<meta name="robots" content="index, follow"><p>A page with enough usable text to audit successfully.</p>',
    { 'x-robots-tag': 'googlebot: noindex, nofollow' });
  await scanPage(db, root + '/a', { fetcher: network(page) });
  await scanPage(db, root + '/b', { fetcher: network(html('<h1>Public</h1>', { 'x-robots-tag': 'otherbot: noindex' })) });
  await scanPage(db, 'https://another.example/a', { fetcher: network(page) });
  await scanPage(db, root + '/shell', { fetcher: network(html('<title>Empty app shell</title>')) });
  await assert.rejects(scanPage(db, root + '/failed', { fetcher: network({ ...page, status: 503 }) }));
  const report = auditSite(db, { hostname: 'example.com' });
  const findings = Object.fromEntries(report.findings.map(group => [group.code, group]));
  assert.equal(report.totals.pages, 4);
  assert.equal(findings.noindex.affectedCount, 1);
  assert.match(findings.noindex.affected[0].xRobotsTag, /noindex/);
  assert.equal(findings.conflicting_robots_directives.affectedCount, 1);
  assert.equal(findings.missing_h1.affectedCount, 1);
  assert.equal(findings.missing_title.affectedCount, 2);
  assert.equal(findings.no_usable_content.affectedCount, 1);
  assert.match(findings.capture_failed.affected[0].reason, /503/);
});

test('does not reuse older browser content when the latest render failed', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const page = html('<div></div>');
  await scanPage(db, root, { mode: 'auto', fetcher: network(page),
    renderer: { async render(source) { return { ...source, ...html('<h1>Previous content</h1>') }; } } });
  await scanPage(db, root, { mode: 'auto', fetcher: network(page),
    renderer: { async render() { throw new Error('Render unavailable'); } } });
  const report = auditSite(db);
  assert.equal(report.totals.usable, 0);
  assert.equal(report.findings[0].code, 'no_usable_content');
  assert.equal(report.findings[0].affected[0].browserError, 'Render unavailable');
});
