import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, scanPage } from '../crawler/scan.mjs';

const start = 'https://example.com/terminal-5';
const html = (title, heading, quote) => `<!doctype html><html><head><title>${title}</title>
  <link rel="canonical" href="/terminal-5"><meta name="robots" content="index,follow">
  <meta name="description" content="Parking"></head>
  <body><nav>Menu</nav><main><h1>${heading}</h1><a href="${quote}">Get a quote</a>
  <a href="https://example.org/info">Info</a><a href="mailto:x@example.com">Contact</a>
  <script>ignore_me()</script></main></body></html>`;
const response = (status, body = '', headers = {}) => ({ status, body: Buffer.from(body), headers });
const document = body => response(200, body, { 'content-type': 'text/html; charset=UTF-8' });

test('extracts normalized evidence and stores stable and changed snapshots', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  let page = html('Terminal 5', 'Terminal Five', '/quote');
  const fetcher = async url => url.pathname === '/robots.txt' ? response(404) : document(page);
  const first = await scanPage(db, start, { fetcher });
  assert.equal(first.fields.canonical, start);
  assert.equal(first.fields.robots, 'index,follow');
  assert.equal(first.fields.description, 'Parking');
  assert.ok(!first.fields.mainText.includes('ignore_me'));
  assert.equal(first.links.length, 2);
  assert.equal(first.links[1].kind, 'external');
  assert.equal((await scanPage(db, start, { fetcher })).changes.length, 0);
  page = html('Terminal 5', 'New handover', '/book');
  const third = await scanPage(db, start, { fetcher });
  assert.equal(third.previousSnapshot, 2);
  assert.deepEqual(third.changes.map(x => x.field), ['headings', 'quoteLinks', 'mainText']);
  assert.equal(third.changes.find(x => x.field === 'quoteLinks').after[0].url, 'https://example.com/book');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM page_snapshots').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM page_links').get().n, 6);
});

test('checks robots before each redirect destination and records an allowed redirect chain', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const calls = [];
  const fetcher = async url => {
    calls.push(url.href);
    if (url.pathname === '/robots.txt') return response(404);
    if (url.hostname === 'example.com') return response(301, '', { location: 'https://www.example.com/new' });
    return document(html('Parking', 'Parking', '/quote'));
  };
  const result = await scanPage(db, start, { fetcher, extraHosts: ['www.example.com'] });
  assert.equal(result.finalUrl, 'https://www.example.com/new');
  assert.equal(result.redirects[0].status, 301);
  assert.equal(calls[2], 'https://www.example.com/robots.txt');
});

test('records robots denials and rejects off-scope or private redirects before requesting them', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const disallow = async url => {
    assert.equal(url.pathname, '/robots.txt');
    return response(200, 'User-agent: *\nDisallow: /terminal-5');
  };
  await assert.rejects(scanPage(db, start, { fetcher: disallow }), /disallowed/);
  for (const [location, extraHosts, reason] of [
    ['https://outside.example/page', [], /outside/],
    ['https://127.0.0.1/page', ['127.0.0.1'], /non-public/i]
  ]) {
    let requests = 0;
    const fetcher = async url => {
      requests++;
      return url.pathname === '/robots.txt' ? response(404) : response(302, '', { location });
    };
    await assert.rejects(scanPage(db, start, { fetcher, extraHosts }), reason);
    assert.equal(requests, 2);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM crawl_runs WHERE state='failed'").get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM page_snapshots').get().n, 0);
});
