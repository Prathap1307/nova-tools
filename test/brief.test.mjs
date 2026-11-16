import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, scanPage } from '../crawler/scan.mjs';
import { buildBrief } from '../brief/build.mjs';
import { briefMarkdown } from '../brief/markdown.mjs';

const site = 'https://example.com';
const target = site + '/terminal-3';
const faq = site + '/faq';
const config = {
  target, support: [faq], keyword: 'Terminal 3 parking',
  questions: [
    { id: 'directions', question: 'Where do I meet the driver?', priority: 'high',
      criteria: [{ label: 'Meeting point', patterns: ['Northern Perimeter Road', 'forecourt'] }],
      keep: 'Keep directions', improve: 'Add directions', verify: 'Check with Operations' },
    { id: 'return', question: 'How do I collect?', priority: 'high',
      criteria: [{ label: 'Return contact', patterns: ['text us', 'when you land'] }],
      existingLinkPattern: '/guide', keep: 'Keep wording', improve: 'Make guidance easier to find', verify: 'Check with Operations' },
    { id: 'charges', question: 'What is the surcharge?', priority: 'medium',
      criteria: [{ label: 'Late surcharge', patterns: ['surcharge'] }], verifyIfAbsent: true,
      keep: 'Keep charge', improve: 'Clarify charge', verify: 'Confirm charge before publishing' },
    { id: 'signage', question: 'What sign should I look for?', priority: 'low',
      criteria: [{ label: 'Sign colour', patterns: ['blue sign'] }],
      keep: 'Keep sign', improve: 'Add verified sign detail', verify: 'Confirm sign' }
  ]
};

async function capture(db, url, markup, answers = []) {
  const document = { status: 200, headers: { 'content-type': 'text/html' },
    body: Buffer.from(markup) };
  return scanPage(db, url, { mode: 'browser',
    fetcher: async address => address.pathname === '/robots.txt'
      ? { status: 404, headers: {}, body: Buffer.alloc(0) } : document,
    renderer: { async render(page) { return { ...page, answers }; } }
  });
}

test('separates covered, partly covered, missing and verify with snapshot and journey evidence', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const primary = await capture(db, target, '<link rel="canonical" href="/"><h1>Terminal 3</h1>'
    + '<p>Use Northern Perimeter Road to reach the forecourt.</p><a href="/guide">Guide</a><a href="/guide">Guide</a>');
  const support = await capture(db, faq, '<h1>FAQ</h1>',
    [{ question: 'How do I collect?', answer: 'Text us when you land.' }]);
  const result = buildBrief(db, config, {
    journey: { sourceUrl: target, outcome: 'pass', finalUrl: site + '/', steps: [
      { name: 'terminal_context', visible: false }
    ] },
    keywords: { opportunities: [{ query: 'Terminal 3 parking', suggested: { requestedUrl: target } }] }
  });
  assert.deepEqual(result.questions.map(item => item.status),
    ['covered', 'partly_covered', 'needs_verification', 'missing']);
  assert.equal(result.questions[0].criteria[0].target.snapshotId, primary.snapshot);
  assert.equal(result.questions[1].criteria[0].supporting[0].snapshotId, support.snapshot);
  assert.equal(result.questions[1].existingLinks.length, 1);
  assert.equal(result.keywordMapping.suggestedUrl, target);
  assert.equal(result.actions[0].id, 'return');
  assert.ok(!result.actions.some(item => item.id === 'directions'));
  assert.ok(result.actions.some(item => item.id === 'canonical'));
  assert.ok(result.actions.some(item => item.id === 'terminal-context'));
  assert.match(briefMarkdown(result), /Text us when you land/);
  assert.throws(() => buildBrief(db, config, { journey: { sourceUrl: faq } }), /different target/);
});

test('rejects absent evidence instead of treating every question as missing', t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  assert.throws(() => buildBrief(db, config), /No usable latest snapshot/);
});
