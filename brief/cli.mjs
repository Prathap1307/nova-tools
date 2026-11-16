import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { buildBrief } from './build.mjs';
import { briefMarkdown } from './markdown.mjs';

const usage = 'npm run brief -- --db crawler.sqlite --config brief/config/simpleparking-t3.json [--keywords opportunities.json] [--journey journey.json] [--export brief.json] [--markdown brief.md]';
const json = async path => path ? JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) : undefined;
let db;
try {
  const { values } = parseArgs({ options: {
    db: { type: 'string', default: 'crawler.sqlite' }, config: { type: 'string' },
    keywords: { type: 'string' }, journey: { type: 'string' },
    export: { type: 'string' }, markdown: { type: 'string' }, help: { type: 'boolean' }
  } });
  if (values.help) console.log(usage);
  else {
    if (!values.config) throw new Error(usage);
    const [config, keywords, journey] = await Promise.all([json(values.config), json(values.keywords), json(values.journey)]);
    db = new DatabaseSync(values.db, { readOnly: true });
    if (db.prepare('PRAGMA user_version').get().user_version !== 2)
      throw new Error('Use a crawler v0.2 schema database. Run a scan to migrate a v0.1 database.');
    const report = buildBrief(db, config, { keywords, journey });
    const output = JSON.stringify(report, null, 2) + '\n';
    if (values.export) await writeFile(values.export, output, { flag: 'wx' });
    if (values.markdown) await writeFile(values.markdown, briefMarkdown(report), { flag: 'wx' });
    process.stdout.write(output);
  }
} catch (error) {
  console.error('Page brief failed: ' + error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
