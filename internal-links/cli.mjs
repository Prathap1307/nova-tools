import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { findInternalLinks } from './find.mjs';

const usage = 'npm run internal-links -- --db crawler.sqlite --config internal-links/config/simpleparking-t3.json [--link-health links.json] [--export opportunities.json]';
const json = async path => path ? JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) : undefined;
let db;
try {
  const { values } = parseArgs({ options: {
    db: { type: 'string', default: 'crawler.sqlite' }, config: { type: 'string' },
    'link-health': { type: 'string' }, export: { type: 'string' }, help: { type: 'boolean' }
  } });
  if (values.help) console.log(usage);
  else {
    if (!values.config) throw new Error(usage);
    const [config, linkReport] = await Promise.all([json(values.config), json(values['link-health'])]);
    db = new DatabaseSync(values.db, { readOnly: true });
    if (db.prepare('PRAGMA user_version').get().user_version !== 2)
      throw new Error('Use a crawler v0.2 schema database. Run a scan to migrate a v0.1 database.');
    const report = findInternalLinks(db, config, { linkReport });
    const output = JSON.stringify(report, null, 2) + '\n';
    if (values.export) await writeFile(values.export, output, { flag: 'wx' });
    process.stdout.write(output);
  }
} catch (error) {
  console.error('Internal link analysis failed: ' + error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
