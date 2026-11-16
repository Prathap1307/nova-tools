import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, scanPage } from '../crawler/scan.mjs';
import { checkLinks } from '../links/check.mjs';

const host = 'https://example.com';
const response = (status, body = '', headers = {}) => ({ status, headers, body: Buffer.from(body) });
const html = body => response(200, body, { 'content-type': 'text/html; charset=utf-8' });

test('deduplicates destinations, retains every source, and distinguishes HTTP and policy outcomes', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const add = (path, markup) => scanPage(db, host + path, {
    fetcher: async url => url.pathname === '/robots.txt' ? response(404) : html('<h1>Source page</h1>' + markup)
  });
  await add('/one', '<a href="/lost">Book now</a><a href="/chain">Chain</a><a href="/loop">Loop</a>'
    + '<a href="/busy">Busy</a><a href="/blocked">Blocked</a><a href="/maybe">Content</a>'
    + '<a href="/away">Away</a><a href="https://outside.example/skip">Skip</a>');
  await add('/two', '<a href="/lost">Book parking</a>');
  const calls = [];
  const fetcher = async url => {
    calls.push(url.href);
    switch (url.pathname) {
      case '/robots.txt': return response(200, 'User-agent: *\nDisallow: /blocked');
      case '/lost': return response(410);
      case '/chain': return response(301, '', { location: '/hop' });
      case '/hop': return response(302, '', { location: '/' });
      case '/loop': return response(302, '', { location: '/loop' });
      case '/busy': return response(429);
      case '/maybe': return html('<title>Page not found</title><h1>Page not found</h1>');
      case '/away': return response(302, '', { location: 'https://outside.example/elsewhere' });
      default: return html('<h1>Home</h1>');
    }
  };
  const report = await checkLinks(db, host, { mode: 'http', fetcher, delayMs: 0 });
  const byUrl = new Map(report.results.map(result => [new URL(result.url).pathname, result]));
  assert.equal(report.totals.discovered, 7);
  assert.equal(report.totals.outsideScopeReferences, 1);
  assert.equal(byUrl.get('/lost').outcome, 'broken');
  assert.equal(byUrl.get('/lost').sources.length, 2);
  assert.equal(calls.filter(url => url.endsWith('/lost')).length, 1);
  assert.deepEqual(byUrl.get('/chain').signals.map(item => item.code), ['redirect_chain', 'homepage_redirect']);
  assert.equal(byUrl.get('/chain').finalUrl, host + '/');
  assert.equal(byUrl.get('/loop').outcome, 'broken');
  assert.equal(byUrl.get('/loop').redirects.length, 1);
  assert.equal(byUrl.get('/busy').outcome, 'unverified');
  assert.equal(byUrl.get('/blocked').outcome, 'unverified');
  assert.equal(byUrl.get('/away').outcome, 'unverified');
  assert.ok(!calls.some(url => url.includes('outside.example') || url.endsWith('/blocked')));
  assert.equal(byUrl.get('/maybe').signals[0].code, 'soft_404_candidate');
  const limited = await checkLinks(db, host, { mode: 'http', maxLinks: 1, delayMs: 0, fetcher });
  assert.equal(limited.results[0].url, host + '/lost');
  assert.equal(limited.totals.limited, 6);
});

test('uses rendered anchors for a single destination and reports missing fragments by source', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  await scanPage(db, host + '/source', {
    fetcher: async url => url.pathname === '/robots.txt' ? response(404)
      : html('<h1>Links</h1><a href="/app#ready">Valid</a><a href="/app#missing">Invalid</a>')
  });
  let gets = 0;
  const fetcher = async url => {
    if (url.pathname === '/robots.txt') return response(404);
    gets++;
    return html('<title>Shell</title><div id="root"></div>');
  };
  const renderer = { async render(page) {
    return { ...page, ...html('<h1>Rendered destination</h1><div id="ready">Here</div>') };
  } };
  const report = await checkLinks(db, host, { fetcher, renderer, delayMs: 0 });
  assert.equal(gets, 1);
  assert.equal(report.totals.browserAttempted, 1);
  const result = report.results[0];
  assert.equal(result.outcome, 'review');
  assert.equal(result.mode, 'browser');
  assert.equal(result.signals[0].code, 'browser_only_content');
  assert.equal(result.signals[1].fragment, '#missing');
  assert.deepEqual(result.signals[1].sources.map(page => page.anchor), ['Invalid']);
  const raw = await checkLinks(db, host, { mode: 'http', fetcher, delayMs: 0 });
  assert.equal(raw.results[0].outcome, 'unverified');
  assert.ok(raw.results[0].signals.some(item => item.code === 'fragment_unverified'));
});
