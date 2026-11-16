import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { webUrl } from '../crawler/http.mjs';
import { buildMonitorReport, validateReports } from './check.mjs';
import { retryCritical } from './retry.mjs';
import { openMonitor, readHistory, saveRun } from './store.mjs';

const usage = 'npm run monitor -- --site https://example.com --db monitor.sqlite --audit audit.json --links links.json --journey journey.json [--crawl crawl.json] [--export monitor.json]';
const readJson = async path => path ? JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) : undefined;
let db;
try {
  const { values } = parseArgs({ options: {
    site: { type: 'string' }, db: { type: 'string', default: 'monitor.sqlite' }, export: { type: 'string' },
    crawl: { type: 'string' }, audit: { type: 'string' }, links: { type: 'string' }, journey: { type: 'string' },
    'retry-links': { type: 'string' }, 'retry-journey': { type: 'string' },
    'retry-crawl-db': { type: 'string' }, 'retry-journey-config': { type: 'string' },
    'retry-screenshot': { type: 'string' }, help: { type: 'boolean' }
  } });
  if (values.help) console.log(usage);
  else {
    const keys = ['crawl', 'audit', 'links', 'journey'];
    if (!values.site || !keys.some(key => values[key])) throw new Error(usage);
    const site = webUrl(values.site).origin;
    const artifacts = Object.fromEntries(await Promise.all(keys.map(async key => [key, await readJson(values[key])])));
    artifacts.retries = { links: await readJson(values['retry-links']), journey: await readJson(values['retry-journey']) };
    validateReports(site, artifacts);
    if (values['retry-journey-config'] || values['retry-crawl-db']) {
      artifacts.retries = await retryCritical(site, artifacts, { crawlDb: values['retry-crawl-db'],
        journeyConfig: await readJson(values['retry-journey-config']), screenshot: values['retry-screenshot'] });
    }
    db = openMonitor(values.db);
    const history = readHistory(db, site);
    const report = saveRun(db, buildMonitorReport(site, history, artifacts), artifacts);
    const output = JSON.stringify(report, null, 2) + '\n';
    if (values.export) await writeFile(values.export, output, { flag: 'wx' });
    process.stdout.write(values.export ? JSON.stringify({ runId: report.runId, previousRunId: report.previousRunId,
      baseline: report.baseline, totals: report.totals, coverage: report.coverage }, null, 2) + '\n' : output);
  }
} catch (error) {
  console.error('Monitor failed: ' + error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
