import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { webUrl } from '../crawler/http.mjs';
import { auditSite } from './check.mjs';
import { compareAudits } from './compare.mjs';
import { auditCsv } from './csv.mjs';

const usage = 'npm run audit -- --db crawler.sqlite [--site https://example.com/] [--export audit.json] [--csv findings.csv] [--compare old-audit.json]';
let db;
try {
  const { values } = parseArgs({ options: {
    db: { type: 'string', default: 'crawler.sqlite' },
    site: { type: 'string' }, export: { type: 'string' }, csv: { type: 'string' }, compare: { type: 'string' }, help: { type: 'boolean' }
  } });
  if (values.help) {
    console.log(usage);
  } else {
    db = new DatabaseSync(values.db, { readOnly: true });
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 2) throw new Error('Use a crawler v0.2 schema database. Run a scan to migrate a v0.1 database.');
    const report = auditSite(db, { hostname: values.site ? webUrl(values.site).hostname : undefined });
    if (values.compare) {
      const baseline = JSON.parse((await readFile(values.compare, 'utf8')).replace(/^\uFEFF/, ''));
      report.comparison = compareAudits(baseline, report);
    }
    if (values.csv) await writeFile(values.csv, auditCsv(report), { flag: 'wx' });
    const output = JSON.stringify(report, null, 2) + '\n';
    if (values.export) await writeFile(values.export, output, { flag: 'wx' });
    process.stdout.write(output);
  }
} catch (error) {
  console.error('Audit failed: ' + error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
