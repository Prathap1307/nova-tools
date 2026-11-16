import { gunzipSync } from 'node:zlib';
import { load } from 'cheerio';
import { webUrl } from './http.mjs';
import { createPolicy } from './policy.mjs';
import { createRenderer } from './browser.mjs';
import { scanPage } from './scan.mjs';

function sitemapEntries(bytes) {
  const body = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 }) : bytes;
  const $ = load(body.toString('utf8'), { xml: true });
  const root = $.root().children().first();
  const name = root.get(0)?.name.split(':').at(-1);
  if (!['urlset', 'sitemapindex'].includes(name)) throw new Error('Unsupported sitemap XML root');
  const index = name === 'sitemapindex';
  const entries = root.children().filter((_, node) => node.name.split(':').at(-1) === (index ? 'sitemap' : 'url'))
    .map((_, node) => $(node).children().filter((__, child) => child.name.split(':').at(-1) === 'loc')
      .first().text().trim()).get().filter(Boolean);
  return { index, entries };
}

export async function crawlSite(db, site, { mode = 'auto', maxPages = 20, extraHosts = [],
  sitemapHosts = [], assetHosts = [], priorityUrls = [], fetcher, delayMs = 200, renderer, timeout } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 2000)
    throw new Error('max-pages must be between 1 and 2000');
  const seed = webUrl(site);
  const pagesScope = new Set([seed.hostname, ...extraHosts]);
  const sitemapScope = new Set([...pagesScope, ...sitemapHosts]);
  const policy = createPolicy({ fetcher, delayMs });
  const engine = renderer ?? (mode === 'http' ? undefined : createRenderer());
  const queue = [];
  const known = new Set();
  const skipped = [];
  const failed = [];
  const snapshots = [];
  const sitemaps = [];
  let duplicates = 0;
  let overflow = 0;
  let browserAttempts = 0;
  function discover(input, source, base) {
    let url;
    try { url = webUrl(input, base); }
    catch {
      if (skipped.length < 10000) skipped.push({ url: input, source, reason: 'unsupported URL' });
      return;
    }
    if (known.has(url.href)) { duplicates++; return; }
    if (known.size >= 10000) { overflow++; return; }
    known.add(url.href);
    if (!pagesScope.has(url.hostname)) {
      skipped.push({ url: url.href, source, reason: 'outside page scope' });
      return;
    }
    queue.push({ url: url.href, source });
  }
  discover(seed.href, 'seed');
  for (const url of priorityUrls) discover(url, 'priority', seed);
  const seenMaps = new Set();
  async function visitMap(input, base) {
    let url;
    try {
      url = webUrl(input, base);
      if (seenMaps.has(url.href)) return;
      if (seenMaps.size >= 30) {
        if (!sitemaps.some(map => map.reason === 'sitemap limit reached'))
          sitemaps.push({ outcome: 'skipped', reason: 'sitemap limit reached' });
        return;
      }
      seenMaps.add(url.href);
      if (!sitemapScope.has(url.hostname)) {
        sitemaps.push({ url: url.href, outcome: 'skipped', reason: 'sitemap host not allowlisted' });
        return;
      }
      const result = await policy.get(url, sitemapScope, { maxBytes: 8 * 1024 * 1024 });
      if (result.status < 200 || result.status >= 300) throw new Error('HTTP ' + result.status);
      const parsed = sitemapEntries(Buffer.from(result.body));
      sitemaps.push({ url: url.href, outcome: 'read', entries: parsed.entries.length, index: parsed.index });
      for (const entry of parsed.entries) {
        if (parsed.index) await visitMap(entry, result.finalUrl);
        else discover(entry, url.href, result.finalUrl);
      }
    } catch (error) {
      sitemaps.push({ url: url?.href ?? input, outcome: 'failed', reason: error.message });
    }
  }

  try {
    try {
      const declarations = (await policy.rules(seed, pagesScope)).getSitemaps();
      for (const declaration of declarations.length ? declarations : ['/sitemap.xml'])
        await visitMap(declaration, seed);
    } catch (error) {
      sitemaps.push({ url: new URL('/robots.txt', seed).href, outcome: 'failed', reason: error.message });
    }
    let attempted = 0;
    const attemptedUrls = [];
    for (const entry of queue) {
      if (attempted >= maxPages) {
        skipped.push({ ...entry, reason: 'page limit reached' });
        continue;
      }
      attempted++;
      attemptedUrls.push(entry.url);
      try {
        const result = await scanPage(db, entry.url, { mode, policy, renderer: engine,
          extraHosts: [...pagesScope], assetHosts, timeout });
        snapshots.push(result);
        if (result.mode === "browser" || result.browserAttempted) browserAttempts++;
        if (result.renderError) failed.push({ ...entry, stage: 'browser', reason: result.renderError });
        else if (result.outcome !== 'usable')
          failed.push({ ...entry, stage: result.mode, reason: 'HTTP ' + result.status + ' without usable page content' });
        for (const link of [...(result.raw?.links ?? []), ...result.links]) {
          if (pagesScope.has(new URL(link.url).hostname)) discover(link.url, result.finalUrl);
        }
      } catch (error) {
        if (error.browserAttempted) browserAttempts++;
        const detail = { ...entry, reason: error.message };
        if (error.code === 'ROBOTS_DENIED') skipped.push(detail);
        else failed.push(detail);
      }
    }
    return { site: seed.href, mode, discovered: known.size, attempted,
      usable: snapshots.filter(page => page.outcome === 'usable').length,
      browserAttempted: browserAttempts,
      rendered: snapshots.filter(page => page.mode === 'browser').length,
      duplicates, discoveryOverflow: overflow, attemptedUrls, skipped, failed, sitemaps, snapshots };
  } finally {
    if (!renderer) await engine?.close();
  }
}
