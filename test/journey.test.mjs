import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkJourney } from '../journeys/check.mjs';

const origin = 'https://example.com';
const quote = '<section id="quote"><h2>Get Your Quote</h2><p>Heathrow Terminal 3</p>'
  + '<label for="dates">Drop-off date</label><input id="dates" type="date">'
  + '<label for="time">Drop-off time</label><input id="time" type="time"></section>';
const html = body => ({ status: 200, headers: { 'content-type': 'text/html' },
  body: Buffer.from('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">' + body) });
const config = {
  id: 'fixture-t3', startUrl: origin + '/terminal-3',
  allowedPaths: ['/terminal-3', '/quote', '/wrong'], cta: { role: 'button', name: 'Book T3 Parking Now' },
  expected: { destinations: [{ path: '/quote' }], landing: { role: 'heading', name: 'Get Your Quote' },
    scope: '#quote', controls: [{ name: 'Drop-off date' }, { name: 'Drop-off time' }],
    terminal: { text: 'Heathrow Terminal 3', required: true } }
};

function network(pages, seen) {
  return async url => {
    seen.push(url.pathname);
    if (url.pathname === '/robots.txt') return { status: 404, headers: {}, body: Buffer.alloc(0) };
    if (!pages[url.pathname]) throw new Error('Unexpected request: ' + url.pathname);
    return html(pages[url.pathname]);
  };
}

test('taps a real mobile CTA, checks the quote controls, and sends no form writes', async () => {
  const seen = [];
  const report = await checkJourney(config, { fetcher: network({
    '/terminal-3': '<button onclick="location.href=\'/quote\'; fetch(\'/write\',{method:\'POST\'}).catch(()=>{});">Book T3 Parking Now</button>',
    '/quote': quote
  }, seen) });
  assert.equal(report.outcome, 'pass', JSON.stringify(report));
  assert.equal(report.finalUrl, origin + '/quote');
  assert.ok(report.steps.some(step => step.name === 'terminal_context' && step.visible));
  assert.ok(!seen.includes('/write'));
  assert.ok(Object.keys(report.blockedResources).some(key => key.includes('method excluded')));
});

test('reports the actual wrong page and saves screenshot evidence', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'nova-journey-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const screenshot = join(folder, 'wrong.png');
  const report = await checkJourney({ ...config, cta: { ...config.cta, role: 'link' } },
    { screenshot, fetcher: network({
      '/terminal-3': '<a href="/wrong">Book T3 Parking Now</a>',
      '/wrong': '<h1>Unrelated page</h1>'
    }, []) });
  assert.equal(report.outcome, 'fail', JSON.stringify(report));
  assert.equal(report.steps.at(-1).name, 'destination');
  assert.equal(report.finalUrl, origin + '/wrong');
  assert.deepEqual((await readFile(screenshot)).subarray(0, 4), Buffer.from([137, 80, 78, 71]));
});

test('distinguishes missing required controls from a correct destination', async () => {
  const report = await checkJourney({ ...config, cta: { ...config.cta, role: 'link' } },
    { fetcher: network({
      '/terminal-3': '<a href="/quote">Book T3 Parking Now</a>',
      '/quote': quote.replace('<input id="time" type="time">', '')
    }, []) });
  assert.equal(report.outcome, 'fail', JSON.stringify(report));
  assert.equal(report.steps.at(-1).name, 'quote_controls');
  assert.deepEqual(report.steps.at(-1).controls.map(control => [control.label, control.enabled]),
    [['Drop-off date', true], ['Drop-off time', false]]);
});
