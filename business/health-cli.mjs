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
    db: { type: 'string' }
  } });
  const maxMs = Number(values['max-ms']);
  if (!values.url?.length || values.url.length > 10 || !Number.isFinite(maxMs) || maxMs <= 0)
    throw new Error('Supply 1–10 --url values and a positive --max-ms');
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
  if (results.some(row => !row.passed)) process.exitCode = 2;
  console.log(JSON.stringify({ results: values.db ? recordHealth(values.db, results) : results }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
