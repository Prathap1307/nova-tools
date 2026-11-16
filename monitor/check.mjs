import { compareAudits } from '../audit/compare.mjs';
import { webUrl } from '../crawler/http.mjs';

const fresh = (before, after) => Date.parse(after?.checkedAt) > Date.parse(before?.checkedAt);
const issues = {
  links: ['broken', 'review'],
  journey: ['fail']
};

function linkObservation(item, mode) {
  return { ...item, profile: mode, key: item.url };
}
function journeyObservation(item) {
  return { ...item, profile: JSON.stringify([item.sourceUrl, item.cta, item.viewport, item.expected]), key: item.id };
}
function observations(artifacts, kind) {
  if (kind === 'links')
    return (artifacts.links?.results ?? []).map(item => linkObservation(item, artifacts.links.mode));
  return artifacts.journey ? [journeyObservation(artifacts.journey)] : [];
}
function retryObservations(retries, kind) {
  if (kind === 'links')
    return (retries?.links?.results ?? []).map(item => linkObservation(item, retries.links.mode));
  return retries?.journey ? [journeyObservation(retries.journey)] : [];
}
function healthy(kind, item) {
  return item.outcome === (kind === 'links' ? 'healthy' : 'pass');
}
function failureSignature(kind, item) {
  if (kind === 'journey') return item.steps?.find(step => step.outcome === 'fail')?.name ?? null;
  return JSON.stringify([item.status ?? null, (item.signals ?? []).map(signal => signal.code).sort()]);
}

function matchingRetry(kind, item, again) {
  return again && again.profile === item.profile && fresh(item, again)
    && Date.parse(again.checkedAt) - Date.parse(item.checkedAt) <= 15 * 60 * 1000;
}
function preview(kind, item) {
  if (!item) return null;
  return kind === 'links'
    ? { url: item.url, finalUrl: item.finalUrl, outcome: item.outcome, checkedAt: item.checkedAt,
      status: item.status, reason: item.reason, sources: item.sources, signals: item.signals, redirects: item.redirects }
    : { id: item.id, sourceUrl: item.sourceUrl, finalUrl: item.finalUrl, outcome: item.outcome,
      checkedAt: item.checkedAt, steps: item.steps, screenshot: item.screenshot };
}

function changesFor(kind, history, artifacts) {
  const past = new Map();
  const lastHealthy = new Map();
  for (const run of history) {
    const retries = new Map(retryObservations(run.artifacts.retries, kind).map(item => [item.key, item]));
    for (const initial of observations(run.artifacts, kind)) {
      const again = retries.get(initial.key);
      const item = matchingRetry(kind, initial, again) && healthy(kind, again) ? again : initial;
      const prior = past.get(item.key);
      if ((healthy(kind, item) || issues[kind].includes(item.outcome)) && (!prior || fresh(prior, item)))
        past.set(item.key, item);
      const lastGood = lastHealthy.get(item.key);
      if (healthy(kind, item) && (!lastGood || fresh(lastGood, item))) lastHealthy.set(item.key, item);
    }
  }
  const current = new Map(observations(artifacts, kind).map(item => [item.key, item]));
  const retry = new Map(retryObservations(artifacts.retries, kind).map(item => [item.key, item]));
  const changes = [];
  for (const key of new Set([...past.keys(), ...current.keys()])) {
    const before = past.get(key);
    const after = current.get(key);
    const again = retry.get(key);
    const priorIssue = before && issues[kind].includes(before.outcome);
    const currentIssue = after && issues[kind].includes(after.outcome);
    const critical = kind === 'journey' || Boolean(after?.quoteOrBooking ?? before?.quoteOrBooking);
    let status;
    let reason;
    let confirmation;
    if (!after || after.outcome === 'unverified') {
      status = 'unverified';
      reason = after?.reason ?? (after ? 'Latest check is unverified' : 'Missing from the latest run');
    } else if (!before) {
      if (!currentIssue) continue;
      status = 'new';
    } else if (before.profile !== after.profile) {
      status = 'unverified';
      reason = 'Check configuration or capture mode changed';
    } else if (currentIssue) {
      if (!priorIssue && !fresh(before, after)) {
        status = 'unverified';
        reason = 'A newer check is required to verify a regression';
      } else {
        status = priorIssue ? 'still_present' : 'regression';
      }
    } else if (priorIssue) {
      status = fresh(before, after) ? 'resolved' : 'unverified';
      if (status === 'unverified') reason = 'A newer comparable healthy check is required';
    } else {
      continue;
    }
    if (critical && currentIssue && status !== 'unverified') {
      confirmation = 'pending';
      if (matchingRetry(kind, after, again)) {
        const issue = failureSignature(kind, after);
        if (healthy(kind, again)) confirmation = 'intermittent';
        else if (again.outcome === after.outcome && issue && failureSignature(kind, again) === issue)
          confirmation = 'confirmed';
        else confirmation = 'unverified';
      }
    }
    changes.push({ kind, key, status, critical, ...(reason ? { reason } : {}),
      ...(confirmation ? { confirmation } : {}), lastHealthyAt: lastHealthy.get(key)?.checkedAt ?? null,
      before: preview(kind, before), after: preview(kind, after), retry: preview(kind, again) });
  }
  return changes;
}

function auditChanges(history, audit) {
  const reports = history.map(run => run.artifacts.audit).filter(Boolean);
  const pending = new Map();
  for (const current of [...reports, ...(audit ? [audit] : [])]) {
    const result = compareAudits({ findings: [...pending.values()] }, current);
    if (current === audit) return result.entries;
    const latest = new Map(current.findings.map(group => [group.id, { ...group, affected: [...group.affected] }]));
    for (const entry of result.entries.filter(entry => entry.status === 'unverified')) {
      const old = pending.get(entry.findingId);
      if (!old) continue;
      if (!latest.has(entry.findingId)) latest.set(entry.findingId, { ...old, affected: [] });
      latest.get(entry.findingId).affected.push(entry.before);
    }
    pending.clear();
    for (const [key, value] of latest) pending.set(key, value);
  }
  return [...pending.values()].flatMap(group => group.affected.map(detail => ({
    findingId: group.id, code: group.code, severity: group.severity, requestedUrl: detail.requestedUrl,
    status: 'unverified', reason: 'No SEO audit supplied for this run', before: detail
  })));
}

export function validateReports(site, artifacts) {
  const host = webUrl(site).hostname;
  if (artifacts.crawl && (!Array.isArray(artifacts.crawl.snapshots) || webUrl(artifacts.crawl.site).hostname !== host))
    throw new Error('Crawl report does not match the monitor site');
  if (artifacts.audit && (!Array.isArray(artifacts.audit.pages) || !Array.isArray(artifacts.audit.findings)
      || artifacts.audit.findings.some(group => !group.id) || artifacts.audit.hostname !== host))
    throw new Error('Supply a scoped SEO audit v0.4 or later for the monitor site');
  for (const report of [artifacts.links, artifacts.retries?.links].filter(Boolean))
    if (!Array.isArray(report.results) || webUrl(report.site).hostname !== host)
      throw new Error('Link report does not match the monitor site');
  for (const report of [artifacts.journey, artifacts.retries?.journey].filter(Boolean))
    if (!report.id || !['pass', 'fail', 'unverified'].includes(report.outcome)
        || webUrl(report.sourceUrl).hostname !== host)
      throw new Error('Journey report does not match the monitor site');
}

export function buildMonitorReport(site, history, artifacts) {
  validateReports(site, artifacts);
  const audits = auditChanges(history, artifacts.audit);
  const tools = [...changesFor('journey', history, artifacts), ...changesFor('links', history, artifacts)];
  const groups = new Map();
  for (const entry of audits) {
    if (!groups.has(entry.findingId)) groups.set(entry.findingId, {
      code: entry.code, severity: entry.severity, counts: {}, pages: []
    });
    const group = groups.get(entry.findingId);
    group.counts[entry.status] = (group.counts[entry.status] ?? 0) + 1;
    group.pages.push(entry);
  }
  const priorities = { regression: 0, new: 1, still_present: 2, resolved: 3, unverified: 4 };
  tools.sort((a, b) => priorities[a.status] - priorities[b.status] || Number(b.critical) - Number(a.critical));
  const totals = Object.fromEntries(Object.keys(priorities).map(status => [status, 0]));
  for (const entry of [...tools, ...audits]) totals[entry.status]++;
  return { site, generatedAt: new Date().toISOString(), baseline: history.length === 0,
    previousRunId: history.at(-1)?.id ?? null, totals, auditGroups: [...groups.values()], tools,
    coverage: { crawl: artifacts.crawl ? {
      discovered: artifacts.crawl.discovered, attempted: artifacts.crawl.attempted, usable: artifacts.crawl.usable
    } : null, audit: artifacts.audit?.totals ?? null, links: artifacts.links?.totals ?? null,
    journey: artifacts.journey?.outcome ?? null } };
}
