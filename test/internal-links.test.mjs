import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, scanPage } from '../crawler/scan.mjs';
import { findInternalLinks } from '../internal-links/find.mjs';

const site = 'https://example.com';
const url = path => site + path;
const marker = 'Text us when you land, then meet your driver at the forecourt.';
const expose = (db, path, html) => scanPage(db, url(path), { fetcher: async address =>
  address.pathname === '/robots.txt' ? { status: 404, headers: {}, body: Buffer.alloc(0) }
    : { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(html) } });
const pair = (source, target = '/guide') => ({
  source: url(source), target: url(target), anchor: 'Collection guide', contextPattern: 'text us when you land'
});

test('records main, CTA and footer placement and recommends keep, move, or add', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  await expose(db, '/guide', '<main><h1>Collection guide</h1></main>');
  await expose(db, '/main', '<main><p>' + marker + '</p><a href="/guide">Read details</a></main>');
  await expose(db, '/cta', '<main><section data-link-zone="cta"><h1>Quote</h1><a href="/guide">Guide</a></section></main>');
  await expose(db, '/footer', '<main><p>' + marker + '</p></main><footer><nav><a href="/guide">Guide</a></nav></footer>');
  await expose(db, '/add', '<main><p>' + marker + '</p></main>');
  const report = findInternalLinks(db, { site, pairs: ['/main', '/cta', '/footer', '/add'].map(path => pair(path)) });
  const result = Object.fromEntries(report.opportunities.map(row => [new URL(row.source).pathname, row]));
  assert.equal(result['/main'].recommendation, 'keep');
  assert.equal(result['/main'].existing[0].placement, 'main');
  assert.equal(result['/cta'].existing[0].placement, 'cta');
  assert.equal(result['/footer'].recommendation, 'move_closer');
  assert.equal(result['/footer'].existing[0].placement, 'footer');
  assert.equal(result['/add'].recommendation, 'add');
  assert.match(result['/add'].contextualEvidence.excerpt, /Text us when you land/);
});

test('preserves legacy placement uncertainty and reviews canonical or redirect issues', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const source = await expose(db, '/parking', '<main><p>' + marker + '</p><a href="/older">Guide</a></main>');
  db.prepare("UPDATE page_snapshots SET fields=json_remove(fields,'$.linkPlacements') WHERE id=?").run(source.snapshot);
  await expose(db, '/guide', '<link rel="canonical" href="/"><main><h1>Guide</h1></main>');
  const report = findInternalLinks(db, { site, pairs: [pair('/parking')] }, { linkReport: {
    site, results: [{ url: url('/older'), finalUrl: url('/guide'), redirects: [{ status: 301 }], outcome: 'healthy' }]
  } });
  const [result] = report.opportunities;
  assert.equal(result.recommendation, 'review_target');
  assert.equal(result.placementRecommendation, 'keep');
  assert.equal(result.existing[0].placement, 'unknown');
  assert.ok(result.targetIssues.includes('homepage_canonical'));
  assert.ok(result.targetIssues.includes('existing_link_redirect'));
});
