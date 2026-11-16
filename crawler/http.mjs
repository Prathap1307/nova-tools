import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

export const agent = 'NovaCrawler/0.1';

export function webUrl(input, base) {
  const url = new URL(input, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Expected a public HTTP or HTTPS URL without credentials');
  url.hash = '';
  return url;
}

function publicAddress(address) {
  return ipaddr.process(address).range() === 'unicast';
}

export function fetchPublic(url, { signal, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, {
      agent: false,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      headers: { 'User-Agent': agent, Accept: 'text/html, text/plain, application/xhtml+xml, */*;q=0.1' },
      lookup(host, options, callback) {
        lookup(host, { all: true, family: options.family || 0 }).then(addresses => {
          const eligible = addresses.filter(({ address }) => publicAddress(address));
          if (!eligible.length) {
            callback(new Error('URL resolves to a non-public address'));
          } else if (options.all) {
            callback(null, eligible);
          } else {
            callback(null, eligible[0].address, eligible[0].family);
          }
        }, callback);
      }
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('error', reject);
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          const error = new Error('Response exceeded ' + maxBytes + ' bytes');
          response.destroy(error);
          reject(error);
        } else chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    request.on('error', reject);
  });
}

export function validateScope(url, allowedHosts) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowedHosts.has(url.hostname)) throw new Error('URL is outside the allowed crawl hosts');
  if (ipaddr.isValid(hostname) && !publicAddress(hostname)) throw new Error('Non-public address blocked');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw new Error('Local address blocked');
  if (url.port) throw new Error('Use a standard HTTP or HTTPS port');
}

export async function follow(initial, { allowedHosts, fetcher, beforeFetch = async () => {}, maxRedirects = 5 }) {
  let url = initial;
  const redirects = [];
  const seen = new Set();
  for (;;) {
    validateScope(url, allowedHosts);
    if (seen.has(url.href)) throw new Error('Redirect loop');
    seen.add(url.href);
    await beforeFetch(url);
    const response = await fetcher(url);
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.location)
      return { ...response, finalUrl: url, redirects };
    if (redirects.length >= maxRedirects) throw new Error('Redirect limit reached');
    const target = webUrl(response.headers.location, url);
    if (url.protocol === 'https:' && target.protocol !== 'https:') throw new Error('HTTPS downgrade blocked');
    redirects.push({ url: url.href, status: response.status, target: target.href });
    url = target;
  }
}
