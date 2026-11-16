import { auditSite } from '../audit/check.mjs';
import { webUrl } from '../crawler/http.mjs';

const stop = new Set(['a', 'an', 'the', 'at', 'for', 'in', 'and', 'of', 'to', 'on', 'near', 'i', 'my', 'do', 'can', 'is']);
function text(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/&/g, ' and ').replace(/\bt\s*([1-9]\d?)\b/g, 'terminal $1');
}

function tokens(value) {
  return new Set((text(value).match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => !stop.has(word)));
}

function terminal(value) {
  return /\bterminal\s*([1-9]\d?)\b/i.exec(text(value))?.[1] ?? null;
}

function queryIntent(query) {
  const label = text(query).trim();
  if (/^(how|what|where|when|why|is|can|do)\b|\b(faq|policy|directions|instructions|guide)\b/.test(label))
    return 'informational';
  if (/\b(parking|quote|book|booking|price|prices|meet.?and.?greet)\b/.test(label)) return 'transactional';
  return 'general';
}

function groupKey(query) {
  return JSON.stringify([queryIntent(query), [...tokens(query)].sort()]);
}

function inventory(db, hostname) {
  const audit = auditSite(db, { hostname });
  const get = db.prepare('SELECT fields FROM page_snapshots WHERE id=?');
  return audit.pages.filter(page => page.outcome === 'usable').map(page => {
    const fields = JSON.parse(get.get(page.capture.snapshotId).fields);
    const url = new URL(page.capture.finalUrl);
    const canonical = fields.canonical ?? null;
    let rawPath = url.pathname;
    try { rawPath = decodeURIComponent(rawPath); } catch { /* use the stored path */ }
    const h1 = (fields.headings ?? []).filter(item => item.level === 1).map(item => item.text);
    const other = (fields.headings ?? []).filter(item => item.level !== 1).map(item => item.text);
    return { ...page.capture, title: fields.title, h1, canonical,
      flags: audit.findings.filter(group => ['homepage_canonical', 'noindex', 'raw_noindex'].includes(group.code)
        && group.affected.some(issue => issue.requestedUrl === page.requestedUrl)).map(group => group.code),
      strong: tokens([rawPath, fields.title, ...h1].join(' ')),
      headings: tokens(other.join(' ')), body: tokens(fields.mainText),
      terminal: terminal([rawPath, fields.title, ...h1].join(' ')),
      informational: /\b(faq|guide|blog|information|policy)\b/i.test([rawPath, fields.title, ...h1].join(' ')) };
  });
}

function withoutTokens(page) {
  const { strong, headings, body, terminal, informational, ...fields } = page;
  return fields;
}

function candidates(pages, query, intent) {
  const expectedTerminal = terminal(query);
  const wanted = [...tokens(query)];
  const matches = [];
  for (const page of pages) {
    if (expectedTerminal && page.terminal && expectedTerminal !== page.terminal) continue;
    const strong = wanted.filter(word => page.strong.has(word));
    const headings = wanted.filter(word => page.headings.has(word) && !page.strong.has(word));
    const body = wanted.filter(word => page.body.has(word) && !page.strong.has(word) && !page.headings.has(word));
    let score = strong.length * 4 + headings.length * 2 + body.length * 0.5;
    if (expectedTerminal) score += page.terminal === expectedTerminal ? 5 : -5;
    if (page.informational && intent === 'transactional') score -= 4;
    if (page.informational && intent === 'informational') score += 2;
    if (expectedTerminal && page.terminal !== expectedTerminal) score = Math.min(score, 4);
    if (strong.length === 0 || score < 5) continue;
    matches.push({ ...withoutTokens(page), score, matched: { titlePathOrH1: strong, otherHeadings: headings, body } });
  }
  return matches.sort((a, b) => b.score - a.score || a.requestedUrl.localeCompare(b.requestedUrl)).slice(0, 3);
}

function summarize(entries) {
  const pages = new Map();
  for (const entry of entries) {
    const current = pages.get(entry.page) ?? { url: entry.page, clicks: 0, impressions: 0, weightedPosition: 0 };
    current.clicks += entry.clicks;
    current.impressions += entry.impressions;
    current.weightedPosition += entry.impressions * entry.position;
    pages.set(entry.page, current);
  }
  const landings = [...pages.values()].map(({ weightedPosition, ...page }) => ({
    ...page, averagePosition: page.impressions ? Number((weightedPosition / page.impressions).toFixed(2)) : null
  })).sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.url.localeCompare(b.url));
  return { clicks: landings.reduce((sum, page) => sum + page.clicks, 0),
    impressions: landings.reduce((sum, page) => sum + page.impressions, 0), landings };
}

export function mapKeywords(db, site, { seeds = [], search = { entries: [], skipped: 0 } } = {}) {
  const hostname = webUrl(site).hostname;
  const pages = inventory(db, hostname);
  const groups = new Map();
  function include(query, entry) {
    if (!tokens(query).size) return;
    const key = groupKey(query);
    if (!groups.has(key)) groups.set(key, { variants: new Set(), entries: [] });
    groups.get(key).variants.add(query.trim());
    if (entry) groups.get(key).entries.push(entry);
  }
  for (const seed of seeds) include(seed);
  for (const entry of search.entries) include(entry.query, entry);
  const opportunities = [...groups.values()].map(({ variants, entries }) => {
    const queries = [...variants];
    const representative = queries[0];
    const intent = queryIntent(representative);
    const matches = candidates(pages, representative, intent);
    const suggested = matches[0] ?? null;
    const performance = entries.length ? summarize(entries) : null;
    const overlap = (performance?.landings.filter(page => page.impressions > 0).length ?? 0) > 1;
    const priority = overlap || suggested?.flags.length ? 'high' : performance?.impressions ? 'medium' : 'explore';
    const observedLanding = suggested && performance?.landings.find(page =>
      page.url === suggested.requestedUrl || page.url === suggested.finalUrl);
    return { query: representative, variants: queries, intent, priority,
      action: overlap ? 'investigate_overlapping_pages' : suggested ? 'improve_existing_page' : 'evaluate_new_page',
      suggested, alternatives: matches.slice(1), performance, observedSuggestedPage: observedLanding ?? null, searchVolume: null, rankingDifficulty: null,
      reason: overlap ? 'Several landing URLs received impressions in the supplied data.'
        : suggested ? 'Matched terms in the captured title, path, headings or page text.'
          : 'No strong match was found in the saved page inventory. Check crawl coverage before planning a new page.' };
  });
  const priorities = { high: 0, medium: 1, explore: 2 };
  opportunities.sort((a, b) => priorities[a.priority] - priorities[b.priority]
    || (b.performance?.impressions ?? 0) - (a.performance?.impressions ?? 0) || a.query.localeCompare(b.query));
  return { hostname, pagesConsidered: pages.length, searchRows: search.entries.length,
    skippedOtherHosts: search.skipped, opportunities };
}
