import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { modes, openDatabase, scanPage } from './scan.mjs';
import { crawlSite } from './site.mjs';

const usage = [
  'npm run scan -- --url https://example.com/ [--mode http|browser|auto]',
  'npm run crawl -- --site https://example.com/ [--mode http|browser|auto] [--max-pages 20]',
  'Options: --db crawler.sqlite --export captures.json --allow-host HOST',
  '         --sitemap-host HOST --asset-host HOST --delay-ms 200'
].join('\n');

function exportCapture(page) {
  return { requestedUrl: page.requestedUrl, finalUrl: page.finalUrl, title: page.fields.title,
    description: page.fields.description, canonical: page.fields.canonical,
    headings: page.fields.headings, answers: page.fields.answers ?? [], pageText: page.fields.mainText, links: page.links, mode: page.mode,
    timestamp: page.observedAt, extractionVersion: page.extractionVersion, status: page.status,
    outcome: page.outcome, flags: page.flags, changes: page.changes };
}

let db;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    url: { type: 'string' }, site: { type: 'string' }, db: { type: 'string', default: 'crawler.sqlite' },
    mode: { type: 'string' }, export: { type: 'string' }, 'max-pages': { type: 'string', default: '20' },
    'delay-ms': { type: 'string', default: '200' }, help: { type: 'boolean' },
    'allow-host': { type: 'string', multiple: true }, 'sitemap-host': { type: 'string', multiple: true },
    'asset-host': { type: 'string', multiple: true }
  } });
  const siteMode = positionals[0] === 'crawl' || Boolean(values.site);
  if (values.help) {
    console.log(usage);
  } else {
    const target = siteMode ? values.site : values.url;
    if (!target || (values.url && values.site) || (positionals.length && positionals.join(' ') !== 'crawl'))
      throw new Error(usage);
    const mode = values.mode ?? (siteMode ? 'auto' : 'http');
    const delayMs = Number(values['delay-ms']);
    if (!modes.includes(mode)) throw new Error('Mode must be http, browser, or auto');
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60000) throw new Error('Invalid delay-ms');
    const options = { mode, extraHosts: values['allow-host'] ?? [], assetHosts: values['asset-host'] ?? [] };
    db = openDatabase(values.db);
    const result = siteMode ? await crawlSite(db, target, { ...options, delayMs,
      sitemapHosts: values['sitemap-host'] ?? [], maxPages: Number(values['max-pages']) })
      : await scanPage(db, target, options);
    const captures = siteMode ? result.snapshots : [result];
    if (values.export) {
      const rows = captures.flatMap(page => page.raw ? [exportCapture(page.raw), exportCapture(page)] : [exportCapture(page)]);
      await writeFile(values.export, JSON.stringify(rows, null, 2) + '\n', { flag: 'wx' });
    }
    const output = siteMode ? { ...result, snapshots: captures.map(page => ({
      requestedUrl: page.requestedUrl, finalUrl: page.finalUrl, outcome: page.outcome,
      mode: page.mode, status: page.status, snapshot: page.snapshot, rawSnapshot: page.raw?.snapshot,
      rawOutcome: page.raw?.outcome, rawFlags: page.raw?.flags, flags: page.flags
    })) } : result;
    console.log(JSON.stringify(output, null, 2));
    if (!siteMode && result.renderError) process.exitCode = 1;
  }
} catch (error) {
  console.error('Scan failed: ' + error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
