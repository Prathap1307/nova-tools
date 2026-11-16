import { loadBuffer } from 'cheerio';
import { createPolicy } from '../crawler/policy.mjs';
import { createRenderer, usable } from '../crawler/browser.mjs';
import { validateScope, webUrl } from '../crawler/http.mjs';
import { extract } from '../crawler/extract.mjs';

const latestLinks = `
  WITH latest AS (
    SELECT requested_url, MAX(id) AS run_id FROM crawl_runs
    WHERE parent_run_id IS NULL AND state IN ('complete','failed') GROUP BY requested_url
  ), selected AS (
    SELECT MAX(snap.id) AS snapshot_id FROM latest
    JOIN crawl_runs run ON run.id=latest.run_id OR run.parent_run_id=latest.run_id
    JOIN page_snapshots snap ON snap.run_id=run.id GROUP BY latest.requested_url
  )
  SELECT snap.requested_url, snap.final_url, snap.observed_at, snap.mode, snap.id, snap.extraction_version,
    link.url, link.anchor FROM selected
  JOIN page_snapshots snap ON snap.id=selected.snapshot_id
  JOIN page_links link ON link.snapshot_id=snap.id
  ORDER BY snap.requested_url, link.position
`;

function destinations(db, hosts, sourceUrls) {
  const targets = new Map();
  let outsideScopeReferences = 0;
  const legacySnapshots = new Set();
  for (const row of db.prepare(latestLinks).iterate()) {
    if (!hosts.has(new URL(row.requested_url).hostname) || (sourceUrls && !sourceUrls.has(row.requested_url))) continue;
    if (row.extraction_version < 4) legacySnapshots.add(row.id);
    let url;
    try {
      url = new URL(row.url);
      validateScope(webUrl(row.url), hosts);
    } catch {
      outsideScopeReferences++;
      continue;
    }
    const address = webUrl(url.href).href;
    let target = targets.get(address);
    if (!target) {
      target = { url: address, sources: [], seen: new Set(), priority: false };
      targets.set(address, target);
    }
    const key = JSON.stringify([row.requested_url, row.anchor, url.hash]);
    if (target.seen.has(key)) continue;
    target.seen.add(key);
    const cta = /\b(?:book(?:ing)?|quote|reserve)\b/i.test(row.anchor);
    target.priority ||= cta;
    target.sources.push({ sourceUrl: row.requested_url, sourceFinalUrl: row.final_url, anchor: row.anchor,
      ...(url.hash ? { fragment: url.hash } : {}), quoteOrBooking: cta, snapshotId: row.id,
      captureMode: row.mode, observedAt: row.observed_at });
  }
  return { outsideScopeReferences, legacySnapshotsWithLinks: legacySnapshots.size, targets: [...targets.values()].sort((a, b) =>
    Number(b.priority) - Number(a.priority) || b.sources.length - a.sources.length || a.url.localeCompare(b.url)) };
}

function decoded(fragment) {
  try { return decodeURIComponent(fragment.slice(1)); } catch { return null; }
}

function anchors(page) {
  const $ = loadBuffer(Buffer.from(page.body));
  return new Set([...$('[id]').map((_, element) => $(element).attr('id')).get(),
    ...$('a[name]').map((_, element) => $(element).attr('name')).get()]);
}

function soft404(fields) {
  const pattern = /^(?:(?:error\s+)?404\b.*(?:not found|missing)|404(?:$|\s*[-|:])|page not found\b|this page (?:could not|cannot) be found\b|we (?:could not|couldn.t|couldn’t) find (?:this|that|the) page\b)/i;
  return [fields.title, ...fields.headings.filter(heading => heading.level === 1).map(heading => heading.text)]
    .find(value => value && pattern.test(value.trim()));
}

async function check(target, options) {
  const { policy, hosts, mode, assetHosts, renderer, timeout } = options;
  const result = { url: target.url, quoteOrBooking: target.priority, sources: target.sources,
    checkedAt: new Date().toISOString(), signals: [] };
  let page;
  try {
    page = await policy.get(webUrl(target.url), hosts);
  } catch (error) {
    const broken = ['REDIRECT_LOOP', 'REDIRECT_LIMIT'].includes(error.code);
    return { ...result, outcome: broken ? 'broken' : 'unverified', reason: error.message,
      redirects: error.redirects ?? [], signals: broken ? [{ code: error.code.toLowerCase() }] : [] };
  }
  const initial = new URL(target.url);
  const final = page.finalUrl;
  Object.assign(result, { finalUrl: final.href, status: page.status, redirects: page.redirects, mode: 'http' });
  if ([404, 410].includes(page.status)) return { ...result, outcome: 'broken', reason: 'HTTP ' + page.status };
  if (page.status < 200 || page.status >= 300)
    return { ...result, outcome: 'unverified', reason: 'HTTP ' + page.status };
  if (page.redirects.length > 1) result.signals.push({ code: 'redirect_chain', hops: page.redirects.length });
  if (page.redirects.length && initial.pathname !== '/' && final.pathname === '/')
    result.signals.push({ code: 'homepage_redirect' });

  const fragments = [...new Set(target.sources.map(source => source.fragment).filter(Boolean))];
  const redirectFragment = page.redirects.findLast(hop => hop.fragment)?.fragment;
  const inspect = fragments.map(fragment => ({ fragment, id: decoded(redirectFragment ?? fragment) }));
  const supported = inspect.filter(item => item.id && !item.id.includes(':~:') && item.id.toLowerCase() !== 'top');
  if (/^(text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(page.headers['content-type'] || '')) {
    let fields = extract(page.body, final.href, page.headers).fields;
    let found = supported.length ? anchors(page) : new Set();
    const rawShell = !usable(fields);
    if (mode === 'browser' || (mode === 'auto' && (rawShell || supported.some(item => !found.has(item.id))))) {
      result.browserAttempted = true;
      try {
        page = await renderer.render(page, { policy, allowedHosts: hosts, assetHosts, timeout });
        result.mode = 'browser';
        result.finalUrl = page.finalUrl.href;
        fields = extract(page.body, page.finalUrl.href, page.headers).fields;
        if (supported.length) found = anchors(page);
        if (rawShell && usable(fields)) result.signals.push({ code: 'browser_only_content' });
      } catch (error) {
        result.signals.push({ code: 'browser_failed', reason: error.message });
        return { ...result, outcome: 'unverified', reason: 'Browser verification failed: ' + error.message };
      }
    }
    const marker = soft404(fields);
    if (marker) result.signals.push({ code: 'soft_404_candidate', evidence: marker });
    if (!usable(fields) && !marker) result.signals.push({ code: 'no_usable_content' });
    for (const item of supported) {
      if (found.has(item.id)) continue;
      const sources = target.sources.filter(source => source.fragment === item.fragment);
      const compatibility = result.mode === 'browser' && usable(fields) ? 'missing_fragment' : 'fragment_unverified';
      result.signals.push({ code: compatibility, fragment: item.fragment, sources });
    }
    for (const item of inspect) {
      if (!item.id || item.id.includes(':~:'))
        result.signals.push({ code: 'fragment_unverified', fragment: item.fragment });
    }
  } else {
    for (const fragment of fragments) result.signals.push({ code: 'fragment_unverified', fragment });
  }

  const needsReview = result.signals.some(item => ['homepage_redirect', 'redirect_chain',
    'soft_404_candidate', 'missing_fragment'].includes(item.code));
  const unverified = result.signals.some(item => ['no_usable_content', 'fragment_unverified'].includes(item.code));
  return { ...result, outcome: needsReview ? 'review' : unverified ? 'unverified' : 'healthy',
    ...(unverified && !needsReview ? { reason: result.signals.some(item => item.code === 'no_usable_content')
      ? 'HTTP ' + page.status + ' without usable content' : 'Fragment could not be verified' } : {}) };
}

export async function checkLinks(db, site, { mode = 'auto', maxLinks = 50, delayMs = 250,
  extraHosts = [], assetHosts = [], onlyUrls, sourceUrls, fetcher, renderer, timeout } = {}) {
  const seed = webUrl(site);
  if (!['http', 'auto', 'browser'].includes(mode)) throw new Error('Use http, auto, or browser');
  if (!Number.isInteger(maxLinks) || maxLinks < 1 || maxLinks > 2000)
    throw new Error('max-links must be between 1 and 2000');
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60000) throw new Error('Invalid delay-ms');
  const hosts = new Set([seed.hostname, ...extraHosts]);
  const { targets: allTargets, outsideScopeReferences, legacySnapshotsWithLinks } = destinations(db, hosts, sourceUrls);
  const targets = onlyUrls ? allTargets.filter(target => onlyUrls.has(target.url)) : allTargets;
  const policy = createPolicy({ fetcher, delayMs });
  const engine = renderer ?? (mode === 'http' ? undefined : createRenderer());
  const results = [];
  try {
    for (const target of targets.slice(0, maxLinks))
      results.push(await check(target, { mode, policy, hosts, assetHosts, renderer: engine, timeout }));
  } finally {
    if (!renderer) await engine?.close();
  }
  const order = { broken: 0, review: 1, unverified: 2, healthy: 3 };
  results.sort((a, b) => order[a.outcome] - order[b.outcome]
    || Number(b.quoteOrBooking) - Number(a.quoteOrBooking) || b.sources.length - a.sources.length);
  const totals = { discovered: targets.length, checked: results.length, limited: targets.length - results.length,
    outsideScopeReferences, legacySnapshotsWithLinks, healthy: 0, broken: 0, review: 0, unverified: 0, browserAttempted: 0 };
  for (const result of results) {
    totals[result.outcome]++;
    if (result.browserAttempted) totals.browserAttempted++;
  }
  return { site: seed.href, generatedAt: new Date().toISOString(), mode, totals, results,
    limited: targets.slice(maxLinks).map(target => ({ url: target.url, reason: 'link limit reached' })) };
}
