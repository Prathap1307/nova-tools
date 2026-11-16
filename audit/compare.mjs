const duplicates = new Set(['duplicate_title', 'duplicate_description']);

export function findingId(code, group = '') {
  return code + ':' + encodeURIComponent(group);
}

function legacyId(finding) {
  if (finding.code === 'homepage_canonical') return findingId(finding.code, finding.value);
  if (duplicates.has(finding.code)) {
    const host = new URL(finding.affected[0].finalUrl).hostname;
    const value = finding.value.trim().replace(/\s+/g, ' ').normalize('NFKC').toLowerCase();
    return findingId(finding.code, host + '\0' + value);
  }
  return findingId(finding.code);
}

function index(report) {
  if (!Array.isArray(report?.findings)) throw new Error('Expected a Nova audit JSON report');
  const entries = new Map();
  for (const finding of report.findings) {
    if (!Array.isArray(finding.affected) || typeof finding.code !== 'string')
      throw new Error('Invalid finding in audit JSON');
    if (!finding.affected.length) continue;
    const id = finding.id ?? legacyId(finding);
    for (const detail of finding.affected) {
      if (typeof detail.requestedUrl !== 'string') throw new Error('Finding is missing its requested URL');
      entries.set(JSON.stringify([id, detail.requestedUrl]), { finding, detail, id });
    }
  }
  return entries;
}

function verification(finding, prior, page) {
  if (!page) return { reason: 'URL absent from the latest audit' };
  if (page.outcome !== 'usable') return { reason: 'Latest capture is failed or unusable' };
  if (finding.code === 'raw_noindex' && page.rawNoindex)
    return { reason: 'The raw noindex directive is still present' };
  const rawSignal = ['browser_only_content', 'raw_noindex'].includes(finding.code);
  const before = rawSignal ? prior.raw : prior;
  const after = rawSignal && page.capture?.captureMode === 'browser' ? page.raw : page.capture;
  const beforeTime = Date.parse(before?.observedAt);
  const afterTime = Date.parse(after?.observedAt);
  if (!Number.isFinite(beforeTime) || !Number.isFinite(afterTime))
    return { reason: 'Comparable capture evidence is unavailable' };
  if (finding.code !== 'capture_failed'
      && (before.captureMode !== after.captureMode || before.extractionVersion !== after.extractionVersion))
    return { reason: 'Capture mode or extraction version changed' };
  if (afterTime <= beforeTime) return { reason: 'No newer comparable snapshot' };
  return { capture: after };
}

export function compareAudits(previous, current) {
  const old = index(previous);
  const latest = index(current);
  if (!Array.isArray(current.pages)) throw new Error('The current audit must include its capture inventory');
  const coverage = new Map(current.pages.map(page => [page.requestedUrl, page]));
  const totals = { new: 0, still_present: 0, resolved: 0, unverified: 0 };
  const entries = [];
  function record(status, entry, context = {}) {
    totals[status]++;
    entries.push({ status, findingId: entry.id, code: entry.finding.code,
      severity: entry.finding.severity, requestedUrl: entry.detail.requestedUrl, ...context });
  }
  for (const [key, entry] of latest) {
    const prior = old.get(key);
    record(prior ? 'still_present' : 'new', entry, {
      ...(prior ? { before: prior.detail } : {}), after: entry.detail
    });
  }
  for (const [key, entry] of old) {
    if (latest.has(key)) continue;
    const check = verification(entry.finding, entry.detail, coverage.get(entry.detail.requestedUrl));
    if (!check.reason && duplicates.has(entry.finding.code)) {
      const missingPeer = entry.finding.affected.find(peer =>
        verification(entry.finding, peer, coverage.get(peer.requestedUrl)).reason);
      if (missingPeer) check.reason = 'Duplicate group has another URL without a fresh comparable capture';
    }
    record(check.reason ? 'unverified' : 'resolved', entry, {
      before: entry.detail, ...(check.capture ? { after: check.capture } : {}),
      ...(check.reason ? { reason: check.reason } : {})
    });
  }
  return { baselineGeneratedAt: previous.generatedAt ?? null, totals, entries };
}
