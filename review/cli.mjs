import { loadReviewConfig } from './config.mjs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openDatabase } from '../crawler/scan.mjs';
import { openMonitor } from '../monitor/store.mjs';
import { reviewSite } from './run.mjs';

const usage = 'npm run review -- --config review/config/simpleparking-t3.json [--mode quick|site] [--db review.sqlite] [--history monitor.sqlite] [--export review.json] [--screenshot failure.png]';
let db;
let monitor;
try {
  const { values } = parseArgs({ options: {
    config: { type: 'string' }, db: { type: 'string', default: 'review.sqlite' },
    history: { type: 'string' }, mode: { type: 'string', default: 'quick' }, export: { type: 'string' },
    screenshot: { type: 'string' }, help: { type: 'boolean' }
  } });
  if (values.help) console.log(usage);
  else {
    if (!values.config) throw new Error(usage);
    const configUrl = pathToFileURL(resolve(values.config));
    const config = await loadReviewConfig(configUrl);
    db = openDatabase(values.db);
    monitor = openMonitor(values.history ?? (values.mode === "site" ? "site-monitor.sqlite" : "monitor.sqlite"));
    const report = await reviewSite(db, monitor, config,
      { screenshot: values.screenshot, mode: values.mode });
    if (values.export) await writeFile(values.export, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    const output = values.export ? { outcome: report.outcome, steps: report.steps, summary: report.summary } : report;
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    if (report.outcome === 'partial') process.exitCode = 2;
  }
} catch (error) {
  console.error('SEO review failed: ' + error.message);
  process.exitCode = 1;
} finally {
  monitor?.close();
  db?.close();
}
