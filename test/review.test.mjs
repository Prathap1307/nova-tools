import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, scanPage } from '../crawler/scan.mjs';
import { openMonitor, readHistory } from '../monitor/store.mjs';
import { reviewSite } from '../review/run.mjs';
import { prioritize } from '../review/prioritize.mjs';

const site = 'https://example.com';
const target = site + '/terminal-3';
const faq = site + '/faq';
const config = {
  brief: { target, support: [faq], keyword: 'Terminal 3 parking', questions: [{
    id: 'guide', priority: 'high', question: 'Where is the guide?',
    criteria: [{ label: 'Guide', patterns: ['read the collection guide'] }], existingLinkPattern: '/guide',
    keep: 'Keep the guide link', improve: 'Add guidance', verify: 'Check guidance'
  }] },
  journey: { id: 'fixture-t3', startUrl: target, allowedPaths: ['/terminal-3', '/quote'],
    cta: { role: 'link', name: 'Book T3 Parking Now' },
    expected: { destinations: [{ path: '/quote' }], landing: { role: 'heading', name: 'Quote' },
      controls: [{ name: 'Drop-off date' }] } }
};

function network({ failFaq = false } = {}) {
  return async url => {
    const headers = { 'content-type': 'text/html; charset=utf-8' };
    const paths = {
      '/': '<h1>Heathrow parking</h1><a href="/terminal-3">Terminal 3</a>',
      '/sitemap.xml': '<urlset><url><loc>https://example.com/unreviewed</loc></url></urlset>',
      '/unreviewed': '<h1>Old page</h1><a href="/old-destination">Book old parking</a>',
      '/guide': '<h1>Current guide</h1>',
      '/terminal-3': '<link rel="canonical" href="/"><main><h1>Terminal 3 parking</h1>'
        + '<p>Read the collection guide.</p><a href="/guide">Collection guide</a>'
        + '<a href="/quote">Book T3 Parking Now</a></main>',
      '/faq': '<main><h1>FAQ</h1><p>Read the collection guide.</p></main>',
      '/quote': '<main><h1>Quote</h1><label for="date">Drop-off date</label><input id="date" type="date"></main>'
    };
    if (url.pathname === '/robots.txt') return { status: 404, headers: {}, body: Buffer.alloc(0) };
    if (failFaq && url.pathname === '/faq') return { status: 503, headers, body: Buffer.alloc(0) };
    if (!paths[url.pathname]) throw new Error('Unexpected path ' + url.pathname);
    return { status: 200, headers, body: Buffer.from('<!doctype html>' + paths[url.pathname]) };
  };
}

test('one review runs capture, audit, real Chromium journey, brief and history', async t => {
  const db = openDatabase(':memory:');
  const monitor = openMonitor(':memory:');
  t.after(() => { db.close(); monitor.close(); });
  const result = await reviewSite(db, monitor, config, { fetcher: network() });
  assert.equal(result.outcome, 'complete', JSON.stringify(result.steps));
  assert.equal(result.summary.quoteJourney, 'pass');
  assert.equal(result.summary.canonicalReview.declaredCanonical, site + '/');
  assert.equal(result.summary.existingLinks[0].url, site + '/guide');
  assert.equal(result.monitor.runId, 1);

  const partial = await reviewSite(db, monitor, config, { fetcher: network({ failFaq: true }) });
  assert.equal(partial.outcome, 'partial');
  assert.equal(partial.summary.quoteJourney, 'pass');
  assert.equal(partial.brief, null);
  assert.equal(partial.steps.find(step => step.name === 'content_brief').status, 'skipped');
  assert.equal(partial.audit.pages.find(page => page.requestedUrl === faq).outcome, 'failed');
  assert.equal(partial.monitor.previousRunId, 1);
  assert.equal(readHistory(monitor, site).length, 2);
});


test('site review reserves priority slots and excludes stale snapshots from the link sweep and audit', async t => {
  const db = openDatabase(':memory:');
  const monitor = openMonitor(':memory:');
  t.after(() => { db.close(); monitor.close(); });
  await scanPage(db, site + '/unreviewed', { fetcher: network() });
  const requests = [];
  const fetcher = async url => { requests.push(url.pathname); return network()(url); };
  const result = await reviewSite(db, monitor, { ...config, siteOptions: { maxPages: 3, maxLinks: 2 } },
    { fetcher, mode: 'site' });
  assert.equal(result.outcome, 'complete', JSON.stringify(result.steps));
  assert.equal(result.crawl.discovered, 6);
  assert.equal(result.crawl.attempted, 3);
  assert.deepEqual(result.crawl.attemptedUrls, [site + '/', target, faq]);
  assert.equal(result.audit.totals.pages, 3);
  assert.ok(!result.audit.pages.some(page => page.requestedUrl.endsWith('/unreviewed')));
  assert.ok(!requests.includes('/old-destination'));
  assert.equal(result.links.totals.checked, 2);
  assert.equal(result.summary.topFixes[0].code, 'homepage_canonical');
  assert.equal(result.monitor.coverage.links.checked, 2);
});

test('sorts a failed booking journey above site audit and content actions', () => {
  const fixes = prioritize({
    journey: { outcome: 'fail', sourceUrl: target, steps: [{ name: 'quote_controls', outcome: 'fail' }] },
    audit: { findings: [{ code: 'homepage_canonical', severity: 'high', affectedCount: 1,
      affected: [{ requestedUrl: target }], nextStep: 'Review the canonical' }] },
    brief: { target, actions: [{ id: 'canonical', priority: 'high', action: 'Review canonical' },
      { id: 'insurance', priority: 'medium', action: 'Verify cover' }] }
  });
  assert.equal(fixes[0].severity, 'critical');
  assert.equal(fixes[0].evidence.failedStep.name, 'quote_controls');
  assert.deepEqual(fixes.map(item => item.type), ['booking_journey', 'seo_audit', 'content_brief']);
});
