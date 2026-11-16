import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, scanPage } from '../crawler/scan.mjs';
import { crawlSite } from '../crawler/site.mjs';

const host = 'https://example.com';
const response = (status, body = '', headers = {}) => ({ status, body: Buffer.from(body), headers });
const html = body => response(200, '<!doctype html><html>' + body + '</html>',
  { 'content-type': 'text/html; charset=utf-8' });
const robots = url => url.pathname === '/robots.txt';
const urlset = entries => '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  + entries.map(url => '<url><loc>' + url + '</loc></url>').join('') + '</urlset>';

test('discovers sitemaps, follows an index, deduplicates, and limits attempted pages', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const pages = [];
  const fetcher = async url => {
    if (robots(url)) return url.origin === host
      ? response(200, 'User-agent: *\nDisallow: /blocked\nSitemap: ' + host + '/index.xml\nSitemap: https://maps.example.org/blog.xml')
      : response(404);
    if (url.pathname === '/index.xml') return response(200,
      '<sitemapindex><sitemap><loc>' + host + '/child.xml</loc></sitemap></sitemapindex>');
    if (url.pathname === '/child.xml') return response(200, urlset([
      host + '/a', host + '/a#part', host + '/blocked', 'https://outside.example.org/page'
    ]));
    if (url.hostname === 'maps.example.org') return response(200, urlset([host + '/blog']));
    pages.push(url.pathname);
    return html('<body><h1>Useful website page</h1><a href="/from-links">Discover me</a></body>');
  };
  const options = { mode: 'http', maxPages: 3, fetcher, delayMs: 0 };
  const result = await crawlSite(db, host, { ...options, sitemapHosts: ['maps.example.org'] });
  assert.deepEqual(pages, ['/', '/a']);
  assert.equal(result.attempted, 3);
  assert.equal(result.usable, 2);
  assert.equal(result.discovered, 6);
  assert.equal(result.sitemaps.filter(map => map.outcome === 'read').length, 3);
  assert.ok(result.duplicates > 0);
  assert.deepEqual(result.skipped.map(skip => skip.reason), [
    'outside page scope', 'Page disallowed by robots.txt: /blocked', 'page limit reached', 'page limit reached'
  ]);
  const strict = await crawlSite(db, host, { ...options, maxPages: 1 });
  assert.ok(strict.sitemaps.some(map => map.reason === 'sitemap host not allowlisted'));
});

test('tracks raw and browser captures separately and reports rendering failure', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const fetcher = async url => robots(url) ? response(404)
    : html('<head><title>Home</title><link rel="canonical" href="/"></head><body><div id="app"></div></body>');
  let title = 'Rendered page';
  const renderer = { async render(doc) {
    return { ...doc, ...html('<head><title>' + title + '</title></head><body><h1>FAQ</h1><p>Answer from browser.</p></body>') };
  } };
  const first = await scanPage(db, host + '/faq', { mode: 'auto', fetcher, renderer });
  assert.equal(first.raw.outcome, 'no_usable_content');
  assert.deepEqual(first.raw.flags, ['homepage_canonical_on_non_homepage']);
  assert.equal(first.mode, 'browser');
  assert.equal(first.fields.headings[0].text, 'FAQ');
  const row = db.prepare('SELECT parent_run_id FROM crawl_runs WHERE id=?').get(first.run);
  assert.equal(row.parent_run_id, first.raw.run);
  assert.equal(first.changes.length, 0);
  title = 'Updated render';
  const second = await scanPage(db, host + '/faq', { mode: 'auto', fetcher, renderer });
  assert.equal(second.previousSnapshot, first.snapshot);
  assert.equal(second.raw.previousSnapshot, first.raw.snapshot);
  assert.deepEqual(second.changes.map(change => change.field), ['title']);
  assert.equal(second.raw.changes.length, 0);
  const failed = await scanPage(db, host + '/faq', { mode: 'auto', fetcher,
    renderer: { async render() { throw new Error('browser unavailable'); } } });
  assert.equal(failed.renderError, 'browser unavailable');
  assert.equal(failed.mode, 'http');
});

test('Chromium executes local fixture scripts and blocks external and non-GET requests', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const calls = [];
  const fetcher = async url => {
    calls.push(url.href);
    if (robots(url)) return response(200, 'User-agent: *\nDisallow: /private.js');
    if (url.pathname === '/redirect.js') return response(302, '', { location: 'https://outside.example.org/redirected' });
    if (url.pathname === '/app.js') return response(200, `
      document.querySelector('#app').innerHTML = '<main><h1>Rendered FAQ</h1><p>Answer rendered from fixture JavaScript.</p><a href="/auto-link">Read more</a><h3><button type="button" aria-expanded="false" aria-controls="answer">Where do I park?</button></h3><div id="answer" hidden>Use the marked forecourt.</div></main>';
      document.querySelector('button').onclick = (event) => {
        event.currentTarget.setAttribute('aria-expanded', 'true');
        document.querySelector('#answer').hidden = false;
      };
      fetch('/write', { method: 'POST' }).catch(() => {});
      fetch('https://outside.example.org/no').catch(() => {});
      fetch('/private.js').catch(() => {});
      fetch('/redirect.js').catch(() => {});
    `, { 'content-type': 'application/javascript' });
    return html('<head><title>App shell</title></head><body><div id="app"></div><script src="/app.js"></script></body>');
  };
  const outcome = await scanPage(db, host + '/faq', { mode: 'auto', fetcher });
  assert.equal(outcome.raw?.outcome, 'no_usable_content', outcome.renderError);
  assert.equal(outcome.mode, 'browser', outcome.renderError);
  assert.match(outcome.fields.mainText, /Answer rendered from fixture JavaScript/);
  assert.deepEqual(outcome.fields.answers, [{ question: 'Where do I park?', answer: 'Use the marked forecourt.' }]);
  assert.equal(outcome.links[0].url, host + '/auto-link');
  assert.ok(Object.keys(outcome.blockedResources).some(reason => reason.includes('method excluded')));
  assert.ok(Object.keys(outcome.blockedResources).some(reason => reason.includes('host excluded')));
  assert.ok(Object.keys(outcome.blockedResources).some(reason => reason.includes('robots.txt')));
  assert.deepEqual(calls, [host + '/robots.txt', host + '/faq', host + '/app.js', host + '/redirect.js']);
});
