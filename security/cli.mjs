import { parseArgs } from 'node:util';
import { fetchPublic, follow, webUrl } from '../crawler/http.mjs';
import { inspectHeaders } from './headers.mjs';

try {
  const { values } = parseArgs({ options: { url: { type: 'string', multiple: true } } });
  if (!values.url?.length || values.url.length > 10) throw new Error('Supply one to ten --url values');
  const results = [];
  for (const input of values.url) {
    const url = webUrl(input);
    try {
      const response = await follow(url, {
        allowedHosts: new Set([url.hostname]),
        fetcher: target => fetchPublic(target)
      });
      const finalUrl = response.finalUrl.href;
      results.push({ url: url.href, finalUrl, status: response.status,
        findings: inspectHeaders({ status: response.status, headers: response.headers, url: finalUrl }) });
    } catch (error) {
      process.exitCode = 2;
      results.push({ url: url.href, error: error.message });
    }
  }
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
