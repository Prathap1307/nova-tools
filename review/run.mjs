import { crawlSite } from '../crawler/site.mjs';
import { checkLinks } from '../links/check.mjs';
import { prioritize } from './prioritize.mjs';
import { scanPage } from '../crawler/scan.mjs';
import { webUrl } from '../crawler/http.mjs';
import { createPolicy } from '../crawler/policy.mjs';
import { createRenderer } from '../crawler/browser.mjs';
import { auditSite } from '../audit/check.mjs';
import { buildBrief } from '../brief/build.mjs';
import { checkJourney } from '../journeys/check.mjs';
import { buildMonitorReport } from '../monitor/check.mjs';
import { readHistory, saveRun } from '../monitor/store.mjs';

const address = value => webUrl(value).href;
const date = () => new Date().toISOString();

function settings(brief, journey) {
  if (!brief?.target || !journey?.startUrl || address(brief.target) !== address(journey.startUrl))
    throw new Error('Page brief and journey must use the same target URL');
  const target = new URL(address(brief.target));
  const urls = new Set([target.href, ...(brief.support ?? []).map(address)]);
  if (urls.size > 10 || [...urls].some(url => new URL(url).origin !== target.origin))
    throw new Error('A quick review supports up to ten URLs on the same origin');
  return { site: target.origin, hostname: target.hostname, target: target.href, urls };
}

function describe(capture) {
  return { url: capture.requestedUrl, mode: capture.mode, outcome: capture.outcome,
    snapshotId: capture.snapshot, rawSnapshotId: capture.raw?.snapshot ?? null,
    observedAt: capture.observedAt, finalUrl: capture.finalUrl,
    ...(capture.renderError ? { reason: capture.renderError } : {}) };
}

export async function reviewSite(db, monitorDb, { brief, journey, siteOptions = {} },
  { fetcher, renderer, screenshot, mode = 'quick', onStep = () => {} } = {}) {
  const { site, hostname, target, urls } = settings(brief, journey);
  if (!['quick', 'site'].includes(mode)) throw new Error('Review mode must be quick or site');
  const maxPages = siteOptions.maxPages ?? 20;
  const maxLinks = siteOptions.maxLinks ?? 20;
  if (mode === 'site') {
    const required = new Set([site + '/', ...urls]);
    if (!Number.isInteger(maxPages) || maxPages < required.size || maxPages > 2000
        || !Number.isInteger(maxLinks) || maxLinks < 1 || maxLinks > 2000)
      throw new Error('Site review limits must cover priority pages and have at least one link slot');
  }
  const report = { site, target, mode, startedAt: date(), steps: [], captures: [] };
  const policy = createPolicy({ fetcher, delayMs: 200 });
  const engine = renderer ?? createRenderer();
  const step = (name, status, evidence = {}) => {
    const completed = { name, status, ...evidence };
    report.steps.push(completed);
    onStep(completed);
  };
  let audit;
  let crawl;
  let links;
  let journeyEvidence;
  let pageBrief;
  let monitor;
  try {
    let attemptedUrls = urls;
    if (mode === 'site') {
      attemptedUrls = new Set();
      try {
        const full = await crawlSite(db, site, { mode: 'auto', maxPages, fetcher, renderer: engine,
          priorityUrls: [...urls], sitemapHosts: siteOptions.sitemapHosts ?? [],
          assetHosts: siteOptions.assetHosts ?? [] });
        attemptedUrls = new Set(full.attemptedUrls);
        report.captures = full.snapshots.map(describe);
        const captured = new Set(report.captures.map(row => row.url));
        for (const entry of [...full.failed, ...full.skipped]) {
          if (attemptedUrls.has(entry.url) && !captured.has(entry.url))
            report.captures.push({ url: entry.url, outcome: 'failed', reason: entry.reason });
        }
        crawl = { ...full, snapshots: report.captures };
        step('capture', full.usable === full.attempted ? 'pass' : full.usable ? 'partial' : 'failed',
          { discovered: full.discovered, attempted: full.attempted, usable: full.usable, failed: full.failed.length });
      } catch (error) {
        step('capture', 'failed', { reason: error.message });
      }
    } else {
      for (const url of urls) {
        try {
          report.captures.push(describe(await scanPage(db, url, { mode: 'auto', policy, renderer: engine })));
        } catch (error) {
          report.captures.push({ url, outcome: 'failed', reason: error.message });
        }
      }
      const usable = report.captures.filter(capture => capture.outcome === 'usable').length;
      crawl = { site, discovered: urls.size, attempted: urls.size, usable, snapshots: report.captures };
      step('capture', usable === urls.size ? 'pass' : usable ? 'partial' : 'failed', { attempted: urls.size, usable });
    }
    try {
      if (attemptedUrls.size === 0) step('seo_audit', 'skipped', { reason: 'No pages were attempted' });
      else {
        audit = auditSite(db, { hostname, requestedUrls: attemptedUrls });
        step('seo_audit', 'pass', { pages: audit.totals.pages, findingGroups: audit.groups });
      }
    } catch (error) {
      step('seo_audit', 'failed', { reason: error.message });
    }

    if (mode === 'site') {
      const sourceUrls = new Set(report.captures.filter(item => item.outcome === 'usable').map(item => item.url));
      try {
        if (!sourceUrls.size) step('link_health', 'skipped', { reason: 'No usable captures from this run' });
        else {
          links = await checkLinks(db, site, { mode: 'auto', maxLinks, sourceUrls, fetcher, renderer: engine,
            assetHosts: siteOptions.assetHosts ?? [] });
          step('link_health', 'pass', { checked: links.totals.checked, unverified: links.totals.unverified });
        }
      } catch (error) {
        step('link_health', 'failed', { reason: error.message });
      }
    }
    try {
      const result = await checkJourney(journey, { fetcher, renderer: engine, screenshot });
      journeyEvidence = result;
      step('booking_journey', result.outcome === 'pass' ? 'pass' : result.outcome === 'fail' ? 'failed' : 'unverified',
        { finalUrl: result.finalUrl ?? null,
          ...(result.outcome !== 'pass' ? { reason: result.steps.at(-1)?.reason ?? 'Journey did not pass' } : {}) });
    } catch (error) {
      step('booking_journey', 'failed', { reason: error.message });
    }

    const fresh = new Set(report.captures.filter(item => item.outcome === 'usable').map(item => item.url));
    if ([...urls].every(url => fresh.has(url))) {
      try {
        pageBrief = buildBrief(db, brief, { journey: journeyEvidence });
        step('content_brief', 'pass', { actions: pageBrief.actions.length });
      } catch (error) {
        step('content_brief', 'failed', { reason: error.message });
      }
    } else {
      step('content_brief', 'skipped', { reason: 'Required target or supporting capture is unusable in this run' });
    }

    try {

      const history = readHistory(monitorDb, site);
      const artifacts = { crawl, audit, links, journey: journeyEvidence };
      monitor = saveRun(monitorDb, buildMonitorReport(site, history, artifacts), artifacts);
      step('monitor_history', 'pass', { runId: monitor.runId, previousRunId: monitor.previousRunId });
    } catch (error) {
      step('monitor_history', 'failed', { reason: error.message });
    }
  } finally {
    if (!renderer) await engine.close();
  }

  const primaryCapture = report.captures.find(item => item.url === target);
  const canonical = audit?.findings.find(group => group.code === 'homepage_canonical')
    ?.affected.find(item => item.requestedUrl === target && item.snapshotId === primaryCapture?.snapshotId);
  const guide = pageBrief?.questions.flatMap(question => question.existingLinks) ?? [];
  return { ...report, finishedAt: date(),
    outcome: report.steps.every(item => item.status === 'pass') ? 'complete' : 'partial',
    summary: { quoteJourney: journeyEvidence?.outcome ?? 'unverified',
      canonicalReview: canonical ? { requestedUrl: canonical.requestedUrl,
        declaredCanonical: canonical.declaredCanonical, snapshotId: canonical.snapshotId } : null,
      existingLinks: [...new Map(guide.map(link => [link.url, link])).values()],
      prioritizedActions: pageBrief?.actions ?? [],
      ...(mode === "site" ? { topFixes: prioritize({ audit, links, journey: journeyEvidence, brief: pageBrief }).slice(0, 10) } : {}) },
    ...(mode === "site" ? { crawl: crawl ?? null, links: links ?? null } : {}),
    audit: audit ?? null, journey: journeyEvidence ?? null, brief: pageBrief ?? null, monitor: monitor ?? null };
}
