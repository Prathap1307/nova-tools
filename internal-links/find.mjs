import { auditSite } from '../audit/check.mjs';
import { webUrl } from '../crawler/http.mjs';

const cleanUrl = value => webUrl(value).href;
const normalize = value => (value ?? '').replace(/\s+/g, ' ').trim();
const relevant = new Set(['homepage_canonical', 'noindex', 'raw_noindex', 'conflicting_robots_directives']);

function passage(fields, pattern) {
  if (!pattern) return null;
  const matcher = new RegExp(pattern, 'iu');
  for (const item of fields.answers ?? []) {
    if (matcher.test(item.answer ?? '')) return { kind: 'faq_answer', question: item.question,
      excerpt: normalize(item.answer).slice(0, 180) };
  }
  const main = normalize(fields.mainText);
  const index = main.search(matcher);
  if (index < 0) return null;
  const start = Math.max(0, index - 40);
  return { kind: 'body', excerpt: (start ? '…' : '') + main.slice(start, start + 180) };
}

export function findInternalLinks(db, config, { linkReport } = {}) {
  if (!config?.site || !Array.isArray(config.pairs) || !config.pairs.length)
    throw new Error('Config needs a site and link pairs');
  const hostname = new URL(cleanUrl(config.site)).hostname;
  if (linkReport && new URL(cleanUrl(linkReport.site)).hostname !== hostname)
    throw new Error('Link health report is for a different site');
  const report = auditSite(db, { hostname });
  const inventory = new Map(report.pages.map(page => [page.requestedUrl, page]));
  const checkByUrl = new Map((linkReport?.results ?? []).map(check => [cleanUrl(check.url), check]));
  const readFields = db.prepare('SELECT fields FROM page_snapshots WHERE id=?');
  const readLinks = db.prepare('SELECT url,anchor,position FROM page_links WHERE snapshot_id=? ORDER BY position');
  const pages = new Map();
  function captured(url) {
    if (!pages.has(url)) {
      const capture = inventory.get(url);
      if (capture?.outcome !== 'usable') pages.set(url, null);
      else {
        const fields = JSON.parse(readFields.get(capture.capture.snapshotId).fields);
        const links = readLinks.all(capture.capture.snapshotId).map(link => ({
          url: link.url, anchor: link.anchor, placement: fields.linkPlacements?.[link.position] ?? 'unknown'
        }));
        pages.set(url, { capture: capture.capture, fields, links });
      }
    }
    return pages.get(url);
  }
  function health(url) {
    const result = checkByUrl.get(url);
    return result ? { outcome: result.outcome, status: result.status ?? null,
      finalUrl: result.finalUrl ?? null, checkedAt: result.checkedAt ?? null,
      redirects: result.redirects ?? [], reason: result.reason ?? null } : null;
  }

  const seen = new Set();
  const opportunities = config.pairs.map(rule => {
    const source = cleanUrl(rule.source);
    const target = cleanUrl(rule.target);
    const label = normalize(rule.anchor);
    if (source === target || [source, target].some(url => new URL(url).hostname !== hostname)
        || !label || seen.has(JSON.stringify([source, target])))
      throw new Error('Expected distinct same-site link pairs with an anchor label');
    seen.add(JSON.stringify([source, target]));
    const from = captured(source);
    const to = captured(target);
    const destination = health(target);
    const targetIssues = report.findings.filter(group => relevant.has(group.code)
      && group.affected.some(item => item.requestedUrl === target)).map(group => group.code);
    if (destination && !['healthy'].includes(destination.outcome)) targetIssues.push('link_' + destination.outcome);
    if (destination?.redirects.length) targetIssues.push('link_redirect');
    if (!to) targetIssues.push('target_snapshot_unavailable');
    const final = to?.capture.finalUrl ? cleanUrl(to.capture.finalUrl) : target;
    const existing = (from?.links ?? []).filter(link => {
      const address = cleanUrl(link.url);
      const observed = checkByUrl.get(address)?.finalUrl;
      return [target, final].includes(address) || Boolean(observed && [target, final].includes(cleanUrl(observed)));
    }).map(link => ({ ...link, checkedDestination: health(cleanUrl(link.url)) }));
    const evidence = from ? passage(from.fields, rule.contextPattern) : null;

    let recommendation = 'unverified';
    let reason = 'No usable latest source capture.';
    if (from) {
      if (existing.length) {
        const contextual = existing.some(item => ['main', 'cta'].includes(item.placement));
        const known = existing.every(item => item.placement !== 'unknown');
        if (contextual) {
          recommendation = 'keep';
          reason = 'An existing link is captured in main content or a CTA region.';
        } else if (known && evidence) {
          recommendation = 'move_closer';
          reason = 'Links were captured in navigation or footer only, with a relevant passage in the source.';
        } else {
          recommendation = 'keep';
          reason = known ? 'The link exists. No relevant contextual placement was verified.'
            : 'The link exists. Its placement is unknown in the saved snapshot; inspect it before adding or moving a link.';
        }
      } else if (evidence) {
        recommendation = 'add';
        reason = 'A relevant passage was found and the capture contains no matching destination link.';
      } else {
        reason = 'No matching link or relevant passage was found in the saved capture.';
      }
    }
    if (existing.some(link => link.checkedDestination?.redirects.length)
        && !targetIssues.includes('existing_link_redirect')) targetIssues.push('existing_link_redirect');
    if (existing.some(link => link.checkedDestination && link.checkedDestination.outcome !== 'healthy'))
      targetIssues.push('existing_link_health_issue');
    return { source, target, suggestedAnchor: label, recommendation: targetIssues.length ? 'review_target' : recommendation,
      placementRecommendation: recommendation, reason, targetIssues, existing,
      sourceSnapshot: from?.capture ?? null, targetSnapshot: to?.capture ?? null,
      contextualEvidence: evidence, targetHealth: destination,
      declaredCanonical: to?.fields.canonical ?? null };
  });
  const order = { review_target: 0, add: 1, move_closer: 2, unverified: 3, keep: 4 };
  opportunities.sort((a, b) => order[a.recommendation] - order[b.recommendation]);
  const counts = Object.fromEntries(Object.keys(order).map(key => [key, 0]));
  for (const item of opportunities) counts[item.recommendation]++;
  return { hostname, generatedAt: new Date().toISOString(), counts, opportunities };
}
