import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, scanPage } from '../crawler/scan.mjs';
import { mapKeywords } from '../keywords/map.mjs';
import { parseSearchConsole } from '../keywords/search-console.mjs';

const site = 'https://example.com';
const headers = { 'content-type': 'text/html' };

async function capture(db, path, content) {
  return scanPage(db, site + path, { fetcher: async url => url.pathname === '/robots.txt'
    ? { status: 404, headers: {}, body: Buffer.alloc(0) }
    : { status: 200, headers, body: Buffer.from(content) } });
}

test('maps terminal variants to the correct page and preserves canonical evidence', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  await capture(db, '/', '<h1>Heathrow Airport Parking</h1>');
  await capture(db, '/t3', '<title>Heathrow Terminal 3 Parking</title><link rel="canonical" href="/">'
    + '<h1>Heathrow Terminal 3 Meet &amp; Greet Parking</h1>');
  await capture(db, '/t4', '<h1>Heathrow Terminal 4 Meet and Greet Parking</h1>');
  const report = mapKeywords(db, site, { seeds: [
    'Heathrow Terminal 3 meet and greet parking', 'Meet & greet parking Heathrow T3', 'Heathrow Terminal 5 parking'
  ] });
  assert.equal(report.pagesConsidered, 3);
  assert.equal(report.opportunities.length, 2);
  const [first, missing] = report.opportunities;
  assert.equal(first.suggested.requestedUrl, site + '/t3');
  assert.equal(first.variants.length, 2);
  assert.ok(first.suggested.flags.includes('homepage_canonical'));
  assert.equal(first.suggested.canonical, site + '/');
  assert.equal(first.performance, null);
  assert.equal(first.searchVolume, null);
  assert.equal(first.rankingDifficulty, null);
  assert.equal(missing.suggested, null);
  assert.equal(missing.action, 'evaluate_new_page');
});

test('imports paired Search Console rows and aggregates overlapping landing URLs', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  await capture(db, '/t3', '<h1>Heathrow Terminal 3 parking</h1>');
  const csv = '\uFEFFQuery,Page,Clicks,Impressions,Position\r\n'
    + '"Heathrow T3 parking","https://example.com/t3",3,60,8\r\n'
    + '"Heathrow Terminal 3 parking","https://example.com/t3",2,20,10\r\n'
    + '"Heathrow T3 parking","https://example.com/",1,5,12\r\n'
    + '"parking, quote","https://outside.example/",2,6,3\r\n';
  const search = parseSearchConsole(csv, 'example.com');
  const result = mapKeywords(db, site, { search });
  assert.equal(result.skippedOtherHosts, 1);
  const [group] = result.opportunities;
  assert.equal(group.action, 'investigate_overlapping_pages');
  assert.equal(group.performance.impressions, 85);
  assert.equal(group.performance.clicks, 6);
  assert.equal(group.observedSuggestedPage.averagePosition, 8.5);
});

test('rejects unsupported CSV exports and ambiguous duplicate aggregation', () => {
  const header = 'Query,Page,Clicks,Impressions,Position\n';
  const row = 'parking,https://example.com/,1,2,4\n';
  assert.throws(() => parseSearchConsole('Top queries,Clicks,Impressions,Position\nparking,1,2,4', 'example.com'),
    /same rows/);
  assert.throws(() => parseSearchConsole(header + row + row, 'example.com'), /Duplicate/);
  assert.throws(() => parseSearchConsole(header + row.replace(',1,2,', ',3,2,'), 'example.com'), /Invalid metrics/);
});
