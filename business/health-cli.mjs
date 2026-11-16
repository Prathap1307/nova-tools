import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { fetchPublic, follow, validateScope, webUrl } from '../crawler/http.mjs';
import { healthReport } from './reports.mjs';
import { recordHealth } from './health-history.mjs';

try {
  const { values } = parseArgs({ options: {
    url: { type: 'string', multiple: true },
    'max-ms': { type: 'string', default: '3000' },
    field: { type: 'string', multiple: true },
    db: { type: 'string' },
    watch: { type: 'boolean' },
    'interval-seconds': { type: 'string', default: '900' },
    runs: { type: 'string' }
  } });
  const maxMs = Number(values['max-ms']);
  if (!values.url?.length || values.url.length > 10 || !Number.isFinite(maxMs) || maxMs <= 0)
    throw new Error('Supply 1–10 --url values and a positive --max-ms');
  const seconds = Number(values['interval-seconds']);
  const runs = values.runs == null ? Infinity : Number(values.runs);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400 ||
      (values.runs != null && (!values.watch || !Number.isSafeInteger(runs) || runs < 1)))
    throw new Error('Use a 1–86400 second interval and a positive --runs count with --watch');
  if (values.watch && !values.db) throw new Error('--watch requires --db');

  async function check() {
    const results = [];
    const fields = [...new Set(values.field ?? [])].sort();
    for (const input of new Set(values.url.map(value => webUrl(value).href))) {
      const url = webUrl(input);
      const allowedHosts = new Set([url.hostname]);
      validateScope(url, allowedHosts);
      const probe = JSON.stringify([url.href, maxMs, fields]);
      const start = performance.now();
      const checkedAt = new Date().toISOString();
      try {
        const response = await follow(url, { allowedHosts, fetcher: fetchPublic });
        const elapsedMs = Math.round(performance.now() - start);
        let body;
        if (values.field?.length) {
          try { body = JSON.parse(response.body.toString('utf8')); } catch { body = null; }
        }
        const [result] = healthReport({ checks: [{ id: url.href, url: response.finalUrl.href,
          status: response.status, elapsedMs, maxMs, requiredFields: values.field, body,
          headers: response.headers, checkedAt }] });
        results.push({ ...result, probe, finalUrl: response.finalUrl.href, status: response.status, elapsedMs, checkedAt });
      } catch (error) {
        results.push({ id: url.href, probe, passed: false, checkedAt, failures: [error.message] });
      }
    }
    return values.db ? recordHealth(values.db, results) : results;
  }

  for (let run = 0; run < (values.watch ? runs : 1); run++) {
    const started = performance.now();
    const results = await check();
    console.log(JSON.stringify({ results }, null, values.watch ? 0 : 2));
    if (!values.watch && results.some(row => !row.passed)) process.exitCode = 2;
    if (values.watch && run + 1 < runs) await delay(Math.max(0, seconds * 1000 - (performance.now() - started)));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
