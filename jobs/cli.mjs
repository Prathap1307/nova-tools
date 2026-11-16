import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openDatabase } from '../crawler/scan.mjs';
import { openMonitor } from '../monitor/store.mjs';
import { loadReviewConfig, readJson } from '../review/config.mjs';
import { reviewSite } from '../review/run.mjs';
import { createJobService } from './service.mjs';
import { openJobs } from './store.mjs';

const usage = 'npm run jobs -- [--config jobs/config/sites.json] [--data-dir .nova-jobs] [--port 8787]';
let db;
try {
  const { values } = parseArgs({ options: {
    config: { type: 'string', default: 'jobs/config/sites.json' },
    'data-dir': { type: 'string', default: '.nova-jobs' },
    port: { type: 'string', default: '8787' }, help: { type: 'boolean' }
  } });
  if (values.help) console.log(usage);
  else {
    const token = process.env.NOVA_TOOLS_TOKEN;
    if (!token || token.length < 32) throw new Error('Set NOVA_TOOLS_TOKEN to at least 32 characters');
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
    const configUrl = pathToFileURL(resolve(values.config));
    const config = await readJson(configUrl);
    const sites = new Map();
    for (const [id, definition] of Object.entries(config.sites ?? {})) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !definition.reviewConfig
          || !['quick', 'site'].includes(definition.mode))
        throw new Error('Invalid configured site: ' + id);
      sites.set(id, { mode: definition.mode, config: await loadReviewConfig(new URL(definition.reviewConfig, configUrl)) });
    }
    if (!sites.size) throw new Error('Configure at least one site');
    const directory = resolve(values['data-dir']);
    await mkdir(directory, { recursive: true });
    db = openJobs(join(directory, 'jobs.sqlite'));
    const service = createJobService({ db, sites, token,
      async runReview(site, job, onStep) {
        const record = sites.get(site);
        const folder = join(directory, site);
        await mkdir(folder, { recursive: true });
        const captures = openDatabase(join(folder, 'crawler.sqlite'));
        let history;
        try {
          history = openMonitor(join(folder, 'monitor.sqlite'));
          return await reviewSite(captures, history, record.config, { mode: record.mode, onStep,
            screenshot: join(folder, job + '-journey.png') });
        } finally {
          history?.close();
          captures.close();
        }
      }
    });
    await new Promise((resolve, reject) => {
      service.server.once('error', reject);
      service.server.listen(port, '127.0.0.1', resolve);
    });
    console.log('Nova Tools Job Runner listening on http://127.0.0.1:' + service.server.address().port);
    const stop = async () => {
      await service.close();
      db.close();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
} catch (error) {
  db?.close();
  console.error('Job runner failed: ' + error.message);
  process.exitCode = 1;
}
