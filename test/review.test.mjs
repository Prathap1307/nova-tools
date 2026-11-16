import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../crawler/scan.mjs';
import { openMonitor, readHistory } from '../monitor/store.mjs';
import { reviewSite } from '../review/run.mjs';

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
