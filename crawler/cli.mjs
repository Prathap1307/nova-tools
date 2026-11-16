import { parseArgs } from 'node:util';
import { openDatabase, scanPage } from './scan.mjs';

const usage = 'Usage: npm run scan -- --url https://example.com/ [--db crawler.sqlite] [--allow-host example.org]';
let db;
try {
  const { values } = parseArgs({ options: {
    url: { type: 'string' }, db: { type: 'string', default: 'crawler.sqlite' },
    'allow-host': { type: 'string', multiple: true }, help: { type: 'boolean' }
  } });
  if (values.help) {
    console.log(usage);
  } else {
    if (!values.url) throw new Error(usage);
    db = openDatabase(values.db);
    console.log(JSON.stringify(await scanPage(db, values.url, {
      extraHosts: values['allow-host'] ?? []
    }), null, 2));
  }
} catch (error) {
  console.error('Scan failed: ' + error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
