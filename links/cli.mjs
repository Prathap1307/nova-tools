import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { checkLinks } from './check.mjs';
import { rowsToCsv } from '../report/csv.mjs';

function csv(report) {
  const rows = [['Outcome', 'Reason', 'Destination', 'Final URL', 'HTTP status', 'Capture mode',
    'Quote or booking', 'Source URL', 'Anchor', 'Fragment', 'Source snapshot ID', 'Checked at', 'Signals', 'Redirects']];
  for (const target of report.results) {
    for (const source of target.sources) {
      const signals = target.signals.filter(signal => !signal.fragment || signal.fragment === source.fragment);
      rows.push([target.outcome, target.reason, target.url, target.finalUrl, target.status, target.mode,
        source.quoteOrBooking, source.sourceUrl, source.anchor, source.fragment, source.snapshotId, target.checkedAt,
        JSON.stringify(signals.map(({ sources, ...signal }) => signal)), JSON.stringify(target.redirects ?? [])]);
    }
  }
  return rowsToCsv(rows);
}

const usage = 'npm run links -- --site https://example.com --db crawler.sqlite [--max-links 50] [--mode auto] [--export links.json] [--csv links.csv]';
let db;
try {
  const { values } = parseArgs({ options: {
    db: { type: 'string', default: 'crawler.sqlite' }, site: { type: 'string' },
    mode: { type: 'string', default: 'auto' }, 'max-links': { type: 'string', default: '50' },
    'delay-ms': { type: 'string', default: '250' }, 'allow-host': { type: 'string', multiple: true },
    'asset-host': { type: 'string', multiple: true }, export: { type: 'string' },
    csv: { type: 'string' }, help: { type: 'boolean' }
  } });
  if (values.help) console.log(usage);
  else {
    if (!values.site) throw new Error(usage);
    db = new DatabaseSync(values.db, { readOnly: true });
    if (db.prepare('PRAGMA user_version').get().user_version !== 2)
      throw new Error('Use a crawler v0.2 schema database. Run a scan to migrate a v0.1 database.');
    const report = await checkLinks(db, values.site, { mode: values.mode, maxLinks: Number(values['max-links']),
      delayMs: Number(values['delay-ms']), extraHosts: values['allow-host'], assetHosts: values['asset-host'] });
    const output = JSON.stringify(report, null, 2) + '\n';
    if (values.export) await writeFile(values.export, output, { flag: 'wx' });
    if (values.csv) await writeFile(values.csv, csv(report), { flag: 'wx' });
    process.stdout.write(values.export ? JSON.stringify(report.totals, null, 2) + '\n' : output);
  }
} catch (error) {
  console.error('Link check failed: ' + error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
