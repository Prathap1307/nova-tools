import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { webUrl } from '../crawler/http.mjs';
import { parseSearchConsole } from './search-console.mjs';
import { mapKeywords } from './map.mjs';

const usage = 'npm run keywords -- --site https://example.com/ --db crawler.sqlite [--seed "keyword"] [--search-console query-pages.csv] [--export opportunities.json]';
let db;
try {
  const { values } = parseArgs({ options: {
    site: { type: 'string' }, db: { type: 'string', default: 'crawler.sqlite' },
    seed: { type: 'string', multiple: true }, 'search-console': { type: 'string' },
    export: { type: 'string' }, help: { type: 'boolean' }
  } });
  if (values.help) console.log(usage);
  else {
    if (!values.site || (!values.seed?.length && !values['search-console'])) throw new Error(usage);
    const site = webUrl(values.site);
    const search = values['search-console']
      ? parseSearchConsole(await readFile(values['search-console'], 'utf8'), site.hostname) : undefined;
    db = new DatabaseSync(values.db, { readOnly: true });
    if (db.prepare('PRAGMA user_version').get().user_version !== 2)
      throw new Error('Use a crawler v0.2 schema database. Run a scan to migrate a v0.1 database.');
    const report = mapKeywords(db, site, { seeds: values.seed ?? [], search });
    const output = JSON.stringify(report, null, 2) + '\n';
    if (values.export) await writeFile(values.export, output, { flag: 'wx' });
    process.stdout.write(output);
  }
} catch (error) {
  console.error('Keyword mapping failed: ' + error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
