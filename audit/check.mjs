import { findingId } from './compare.mjs';
import { compareRenderedFields } from './rendered-fields.mjs';

const severityOrder = { high: 0, medium: 1, low: 2, info: 3 };
const latestCaptures = `
  WITH roots AS (
    SELECT requested_url, MAX(id) AS root_id
    FROM crawl_runs WHERE parent_run_id IS NULL AND state IN ('complete','failed')
    GROUP BY requested_url
  )
  SELECT roots.requested_url AS url, roots.root_id, run.id AS run_id,
    run.state, run.error, run.finished_at, snap.id AS snapshot_id, snap.final_url,
    snap.observed_at, snap.mode, snap.http_status, snap.extraction_version,
    snap.fields, snap.outcome
  FROM roots JOIN crawl_runs run ON run.id=roots.root_id OR run.parent_run_id=roots.root_id
  LEFT JOIN page_snapshots snap ON snap.run_id=run.id
  WHERE run.state IN ('complete','failed')
  ORDER BY roots.requested_url, run.id
`;

const clean = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
const normalized = value => clean(value).normalize('NFKC').toLowerCase();

function evidence(row) {
  return { requestedUrl: row.url, finalUrl: row.final_url, snapshotId: row.snapshot_id,
    runId: row.run_id, captureMode: row.mode, observedAt: row.observed_at,
    extractionVersion: row.extraction_version, httpStatus: row.http_status };
}

function contentUsable(row, fields) {
  return row.outcome === 'usable' || (row.outcome === 'unknown' && (
    clean(fields.mainText).length >= 35 || fields.headings?.some(item => clean(item.text))
    || fields.quoteLinks?.length > 0));
}

function homepageCanonical(row, canonical) {
  if (!canonical) return false;
  try {
    const requested = new URL(row.url);
    const final = new URL(row.final_url);
    const target = new URL(canonical);
    return requested.pathname !== '/' && final.pathname !== '/'
      && target.pathname === '/' && [requested.hostname, final.hostname].includes(target.hostname);
  } catch {
    return false;
  }
}

function robots(fields) {
  const values = new Set();
  function add(value) {
    if (['all', 'none', 'index', 'noindex', 'follow', 'nofollow'].includes(value)) values.add(value);
  }
  for (const value of normalized(fields.robots).split(/[\s,]+/)) add(value);
  let applies = true;
  for (const field of normalized(fields.xRobotsTag).split(',')) {
    const directive = field.trim();
    const agentScope = /^([\w*-]+):\s*(.*)$/.exec(directive);
    if (agentScope) {
      const [, agent, value] = agentScope;
      if (!['unavailable_after', 'max-snippet', 'max-image-preview', 'max-video-preview'].includes(agent)) {
        applies = agent === 'googlebot' || agent === '*';
        if (applies) for (const token of value.split(/\s+/)) add(token);
      }
    } else if (applies) {
      for (const token of directive.split(/\s+/)) add(token);
    }
  }
  return {
    noindex: values.has('noindex') || values.has('none'),
    index: values.has('index') || values.has('all'),
    nofollow: values.has('nofollow') || values.has('none'),
    follow: values.has('follow') || values.has('all')
  };
}

export function auditSite(db, { hostname } = {}) {
  const pages = new Map();
  for (const row of db.prepare(latestCaptures).iterate()) {
    if (hostname && new URL(row.url).hostname !== hostname) continue;
    if (!pages.has(row.url)) pages.set(row.url, []);
    pages.get(row.url).push(row);
  }

  const findings = new Map();
  const inventory = [];
  const totals = { pages: pages.size, usable: 0, noUsableContent: 0, failed: 0, browserOnlyContent: 0 };
  const metadata = { title: new Map(), description: new Map() };
  function add(code, severity, message, nextStep, detail, group = '', value) {
    const key = findingId(code, group);
    if (!findings.has(key)) findings.set(key, { id: key, code, severity, message, nextStep,
      ...(value ? { value } : {}), affected: [] });
    findings.get(key).affected.push(detail);
  }

  for (const rows of pages.values()) {
    const captures = rows.filter(row => row.snapshot_id !== null);
    const current = captures.at(-1);
    if (!current) {
      totals.failed++;
      const last = rows.at(-1);
      inventory.push({ requestedUrl: last.url, outcome: "failed", runId: last.run_id, reason: last.error });
      add('capture_failed', 'info', 'The latest scan failed.',
        'Resolve the capture error before interpreting this page.',
        { requestedUrl: last.url, runId: last.run_id, observedAt: last.finished_at, reason: last.error });
      continue;
    }
    const fields = JSON.parse(current.fields);
    const detail = evidence(current);
    const raw = current.mode === 'browser' ? captures.find(row => row.mode === 'http') : null;
    const rawFields = raw ? JSON.parse(raw.fields) : null;
    inventory.push({ requestedUrl: current.url,
      outcome: contentUsable(current, fields) ? 'usable' : 'no_usable_content', capture: detail,
      ...(raw ? { raw: evidence(raw), rawOutcome: raw.outcome,
        rawNoindex: robots(rawFields).noindex, rawVsRendered: compareRenderedFields(rawFields, fields) } : {}) });
    if (raw && !contentUsable(raw, rawFields) && contentUsable(current, fields)) {
      totals.browserOnlyContent++;
      add('browser_only_content', 'info', 'Usable content appeared after JavaScript rendering.',
        'Review rendering reliability and verify indexing separately in Search Console.',
        { ...detail, raw: evidence(raw), rawOutcome: raw.outcome, headings: fields.headings?.length ?? 0,
          textLength: clean(fields.mainText).length });
    }
    if (homepageCanonical(current, fields.canonical)) {
      const target = new URL(fields.canonical);
      target.hash = '';
      add('homepage_canonical', 'high', 'Distinct pages declare the homepage as canonical.',
        'Confirm whether these pages should be indexed separately. If so, review the canonical template.',
        { ...detail, declaredCanonical: fields.canonical }, target.href, target.href);
    }
    const flags = robots(fields);
    const directives = { metaRobots: fields.robots ?? null, xRobotsTag: fields.xRobotsTag ?? null };
    if (flags.noindex) add('noindex', 'high', 'A noindex directive is present.',
      'Confirm that this page is intended to be excluded.', { ...detail, ...directives });
    else if (raw && robots(rawFields).noindex) {

      add('raw_noindex', 'high', 'The HTTP capture declares noindex before JavaScript rendering.',
        'Review the raw directive before expecting this page to be indexed.',
        { ...detail, raw: evidence(raw), rawMetaRobots: rawFields.robots, rawXRobotsTag: rawFields.xRobotsTag });
    }
    if ((flags.index && flags.noindex) || (flags.follow && flags.nofollow))
      add('conflicting_robots_directives', 'high', 'Robots directives disagree.',
        'Make the meta tag and HTTP header consistent with the intended indexing policy.',
        { ...detail, ...directives });
    if (!contentUsable(current, fields)) {
      totals.noUsableContent++;
      const failure = rows.find(row => row.state === 'failed' && row.run_id !== current.run_id);
      add('no_usable_content', 'medium', 'The latest scan yielded no usable page content.',
        'Check browser capture and page loading before reviewing content or metadata.',
        { ...detail, captureOutcome: current.outcome, ...(failure ? { browserError: failure.error } : {}) });
      continue;
    }
    totals.usable++;
    if (!fields.headings?.some(heading => heading.level === 1 && clean(heading.text)))
      add('missing_h1', 'low', 'Usable pages have no extracted H1.',
        'Review the rendered page and add a descriptive main heading where appropriate.', detail);
    for (const field of ['title', 'description']) {
      const value = clean(fields[field]);
      if (!value) {
        add('missing_' + field, field === 'title' ? 'medium' : 'low', 'Usable pages have no extracted ' + field + '.',
          'Review the page and fill in an accurate, page-specific ' + field + '.', detail);
        continue;
      }
      const key = new URL(current.final_url).hostname + '\0' + normalized(value);
      if (!metadata[field].has(key)) metadata[field].set(key, []);
      metadata[field].get(key).push({ ...detail, [field]: value });
    }
  }

  for (const field of ['title', 'description']) {
    for (const [key, affected] of metadata[field]) {
      if (new Set(affected.map(page => page.finalUrl)).size < 2) continue;
      for (const detail of affected)
        add('duplicate_' + field, field === 'title' ? 'medium' : 'low',
          'Multiple distinct pages share a ' + field + '.',
          'Check whether each distinct page should have its own ' + field + '.', detail, key, affected[0][field]);
    }
  }

  const sorted = [...findings.values()].sort((a, b) =>
    severityOrder[a.severity] - severityOrder[b.severity]
    || b.affected.length - a.affected.length || a.code.localeCompare(b.code));
  return { generatedAt: new Date().toISOString(), hostname: hostname ?? null, totals,
    groups: sorted.length,
    summary: sorted.map(finding => ({ id: finding.id, code: finding.code, severity: finding.severity,
      issue: finding.message, affectedCount: finding.affected.length, nextStep: finding.nextStep,
      examples: finding.affected.slice(0, 3).map(page => ({ url: page.requestedUrl, snapshotId: page.snapshotId ?? null })) })),
    pages: inventory,
    findings: sorted.map(finding => ({ ...finding, affectedCount: finding.affected.length })) };
}
