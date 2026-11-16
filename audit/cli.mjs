import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { webUrl } from '../crawler/http.mjs';
import { auditSite } from './check.mjs';

const usage = 'npm run audit -- --db crawler.sqlite [--site https://example.com/] [--export audit.json]';
let db;
try {
  const { values } = parseArgs({ options: {
    db: { type: 'string', default: 'crawler.sqlite' },
    site: { type: 'string' }, export: { type: 'string' }, help: { type: 'boolean' }
  } });
  if (values.help) {
    console.log(usage);
  } else {
    db = new DatabaseSync(values.db, { readOnly: true });
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 2) throw new Error('Use a crawler v0.2 schema database. Run a scan to migrate a v0.1 database.');
    const report = auditSite(db, { hostname: values.site ? webUrl(values.site).hostname : undefined });
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
