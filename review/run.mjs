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

export async function reviewSite(db, monitorDb, { brief, journey }, { fetcher, renderer, screenshot } = {}) {
  const { site, hostname, target, urls } = settings(brief, journey);
  const report = { site, target, mode: 'quick', startedAt: date(), steps: [], captures: [] };
  const policy = createPolicy({ fetcher, delayMs: 200 });
  const engine = renderer ?? createRenderer();
  const step = (name, status, evidence = {}) => report.steps.push({ name, status, ...evidence });
  let audit;
  let journeyEvidence;
  let pageBrief;
  let monitor;
  try {
    for (const url of urls) {
      try {
        const capture = await scanPage(db, url, { mode: 'auto', policy, renderer: engine });
        report.captures.push({ url, mode: capture.mode, outcome: capture.outcome,
          snapshotId: capture.snapshot, rawSnapshotId: capture.raw?.snapshot ?? null,
          observedAt: capture.observedAt, finalUrl: capture.finalUrl,
          ...(capture.renderError ? { reason: capture.renderError } : {}) });
      } catch (error) {
        report.captures.push({ url, outcome: 'failed', reason: error.message });
      }
    }
    const usable = report.captures.filter(capture => capture.outcome === 'usable').length;
    step('capture', usable === urls.size ? 'pass' : usable ? 'partial' : 'failed',
      { attempted: urls.size, usable });

    try {
      audit = auditSite(db, { hostname, requestedUrls: urls });
      step('seo_audit', 'pass', { pages: audit.totals.pages, findingGroups: audit.groups });
    } catch (error) {
      step('seo_audit', 'failed', { reason: error.message });
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

    if (usable === urls.size) {
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
      const crawl = { site, discovered: urls.size, attempted: urls.size, usable, snapshots: report.captures };
      const history = readHistory(monitorDb, site);
      const artifacts = { crawl, audit, journey: journeyEvidence };
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
      prioritizedActions: pageBrief?.actions ?? [] },
    audit: audit ?? null, journey: journeyEvidence ?? null, brief: pageBrief ?? null, monitor: monitor ?? null };
}
