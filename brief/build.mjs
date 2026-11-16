import { auditSite } from '../audit/check.mjs';
import { webUrl } from '../crawler/http.mjs';

const rank = new Map([['high', 0], ['medium', 1], ['low', 2]]);
const clip = text => text.length > 150 ? text.slice(0, 147).trimEnd() + '…' : text;
const exact = value => webUrl(value).href;

function sources(db, target, support) {
  const hostname = webUrl(target).hostname;
  const inventory = auditSite(db, { hostname }).pages;
  const fields = db.prepare('SELECT fields FROM page_snapshots WHERE id=?');
  const links = db.prepare('SELECT url,anchor FROM page_links WHERE snapshot_id=? ORDER BY position');
  return [target, ...support].map(url => {
    if (webUrl(url).hostname !== hostname) throw new Error('Supporting snapshots must share the target hostname');
    const page = inventory.find(page => page.requestedUrl === url);
    if (page?.outcome !== 'usable') throw new Error('No usable latest snapshot for ' + url);
    const id = page.capture.snapshotId;
    return { ...page.capture, fields: JSON.parse(fields.get(id).fields), links: links.all(id) };
  });
}

function snippets(page) {
  const answers = (page.fields.answers ?? []).filter(item => item.answer?.trim()).map(item => ({
    kind: 'faq_answer', question: item.question, text: item.answer.trim()
  }));
  let body = page.fields.mainText ?? '';
  // The crawler appends FAQ answers to mainText. Retain their dedicated evidence instead.
  for (const answer of answers) body = body.replace(answer.text, ' ');
  const sentences = body.split(/(?<=[.!?])\s+/u);
  // Use sentence-sized excerpts and one adjacent sentence when a fact spans two.
  const cleaned = sentences.map(value => value.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return [...answers, ...cleaned.flatMap((value, index) => {
    const adjacent = cleaned[index + 1];
    return [{ kind: 'body', text: value },
      ...(adjacent && value.length + adjacent.length <= 310 ? [{ kind: 'body', text: value + ' ' + adjacent }] : [])];
  })];
}

function evidence(page, passages, criterion) {
  const patterns = criterion.patterns.map(pattern => new RegExp(pattern, 'iu'));
  const question = criterion.questionPattern ? new RegExp(criterion.questionPattern, 'iu') : null;
  for (const passage of passages) {
    if (question && (!passage.question || !question.test(passage.question))) continue;
    if (!patterns.every(pattern => pattern.test(passage.text))) continue;
    const after = Math.max(0, passage.text.search(patterns[0]) - 24);
    const offset = after ? passage.text.lastIndexOf(' ', after) + 1 : 0;
    return { url: page.requestedUrl, snapshotId: page.snapshotId, observedAt: page.observedAt,
      kind: passage.kind, ...(passage.question ? { sourceQuestion: passage.question } : {}),
      excerpt: (offset ? '…' : '') + clip(passage.text.slice(offset)) };
  }
  return null;
}

export function buildBrief(db, config, { journey, keywords } = {}) {
  if (!config?.target || !config.keyword || !Array.isArray(config.questions) || !config.questions.length)
    throw new Error('Brief config needs a target, keyword and questions');
  const target = exact(config.target);
  const support = [...new Set((config.support ?? []).map(exact))].filter(url => url !== target);
  const pages = sources(db, target, support);
  const [primary] = pages;
  const passages = pages.map(snippets);
  const seen = new Set();
  const questions = config.questions.map(question => {
    if (!question.id || seen.has(question.id) || !rank.has(question.priority)
        || !question.question || !Array.isArray(question.criteria) || !question.criteria.length
        || !['keep', 'improve', 'verify'].every(key => typeof question[key] === 'string'))
      throw new Error('Invalid or duplicate checklist question');
    seen.add(question.id);
    const criteria = question.criteria.map(criterion => {
      if (!criterion.label || !Array.isArray(criterion.patterns) || !criterion.patterns.length
          || !criterion.patterns.every(pattern => typeof pattern === 'string' && pattern.trim()))
        throw new Error('Invalid evidence criterion for ' + question.id);
      const matches = pages.map((page, index) => evidence(page, passages[index], criterion));
      return { label: criterion.label, target: matches[0], supporting: matches.slice(1).filter(Boolean) };
    });
    const onTarget = criteria.filter(item => item.target).length;
    const supporting = criteria.some(item => item.supporting.length);
    const status = question.requireVerification ? 'needs_verification'
      : onTarget === criteria.length ? 'covered'
        : onTarget || supporting ? 'partly_covered'
          : question.verifyIfAbsent ? 'needs_verification' : 'missing';
    const linkPattern = question.existingLinkPattern ? new RegExp(question.existingLinkPattern, 'iu') : null;
    const existingLinks = linkPattern ? [...new Map(primary.links.filter(link =>
      linkPattern.test(link.url + ' ' + link.anchor)).map(link =>
      [JSON.stringify([link.url, link.anchor]), link])).values()] : [];
    return { id: question.id, question: question.question, priority: question.priority, status, criteria,
      existingLinks, owner: question.owner ?? null, action: status === 'covered' ? question.keep
        : status === 'needs_verification' ? question.verify : question.improve };
  });

  let journeyEvidence;
  if (journey) {
    if (exact(journey.sourceUrl) !== target) throw new Error('Journey report is for a different target URL');
    const terminal = journey.steps?.find(step => step.name === 'terminal_context');
    journeyEvidence = { sourceUrl: journey.sourceUrl, checkedAt: journey.checkedAt, cta: journey.cta,
      finalUrl: journey.finalUrl, outcome: journey.outcome, ...(terminal ? { terminal } : {}) };
  }
  const keywordMatch = keywords?.opportunities?.find(group =>
    [group.query, ...(group.variants ?? [])].some(term => term.toLowerCase() === config.keyword.toLowerCase()));
  const actions = questions.filter(question => question.status !== 'covered').map(question => ({
    id: question.id, priority: question.priority, owner: question.owner, action: question.action
  }));
  if (journeyEvidence?.outcome === 'pass' && journeyEvidence.terminal?.visible === false) {
    actions.push({ id: 'terminal-context', priority: 'high', owner: 'Website / Operations',
      action: config.journeyContextAction ?? 'Confirm whether the quote step should carry the source-page context forward. The configured marker was not visible.' });
  }
  const canonical = primary.fields.canonical;
  if (canonical && new URL(canonical).pathname === '/' && new URL(target).pathname !== '/'
      && new URL(canonical).hostname === new URL(target).hostname) {
    actions.push({ id: 'canonical', priority: 'high', owner: 'Website / SEO',
      action: 'Confirm whether this page should be indexed separately. If so, review its homepage canonical before publishing more copy.',
      evidence: { url: target, snapshotId: primary.snapshotId, declaredCanonical: canonical } });
  }
  actions.sort((a, b) => rank.get(a.priority) - rank.get(b.priority));
  return { target, keyword: config.keyword, keywordMapping: keywordMatch ? {
    query: keywordMatch.query, suggestedUrl: keywordMatch.suggested?.requestedUrl ?? null
  } : null, generatedAt: new Date().toISOString(), pages: pages.map(({ fields, links, ...page }) => page),
  actions, questions, journey: journeyEvidence ?? null };
}
