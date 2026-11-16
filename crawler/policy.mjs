import { setTimeout as delay } from 'node:timers/promises';
import robotsParser from 'robots-parser';
import { agent, fetchPublic, follow } from './http.mjs';

export function createPolicy({ fetcher = fetchPublic, delayMs = 0 } = {}) {
  const robots = new Map();
  const nextStart = new Map();
  async function paced(url, options = {}) {
    const now = Date.now();
    const at = Math.max(now, nextStart.get(url.host) ?? now);
    nextStart.set(url.host, at + delayMs);
    if (at > now) await delay(at - now, null, { signal: options.signal });
    return fetcher(url, options);
  }

  function rules(url, allowedHosts) {
    const key = url.origin + ' ' + [...allowedHosts].sort().join(',');
    if (!robots.has(key)) {
      const address = new URL('/robots.txt', url);
      const pending = follow(address, { allowedHosts, fetcher: paced }).then(result => {
        if (![404, 410].includes(result.status) && (result.status < 200 || result.status >= 300))
          throw new Error('robots.txt unavailable (HTTP ' + result.status + ')');
        return robotsParser(address.href, [404, 410].includes(result.status)
          ? '' : Buffer.from(result.body).toString('utf8'));
      });
      robots.set(key, pending);
    }
    return robots.get(key);
  }

  function get(url, allowedHosts, options) {
    return follow(url, {
      allowedHosts, fetcher: target => paced(target, options),
      async beforeFetch(target) {
        options?.checkUrl?.(target);
        if ((await rules(target, allowedHosts)).isAllowed(target.href, agent) === false) {
          const error = new Error('Page disallowed by robots.txt: ' + target.pathname);
          error.code = 'ROBOTS_DENIED';
          throw error;
        }
      }
    });
  }
  return { rules, get };
}
