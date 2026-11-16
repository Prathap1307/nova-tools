import { chromium } from 'playwright';
import { agent, validateScope, webUrl } from './http.mjs';
import { extract } from './extract.mjs';

export function usable(fields) {
  return (fields.mainText?.trim().length ?? 0) >= 35
    || fields.headings.some(heading => heading.text.length > 0)
    || fields.quoteLinks.length > 0;
}

async function publicAnswers(page, deadline) {
  const panels = await page.locator('h2 button[type="button"][aria-controls], h3 button[type="button"][aria-controls], h4 button[type="button"][aria-controls]').evaluateAll(buttons =>
    buttons.filter(button => !button.closest('form') && !button.disabled
      && button.hasAttribute('aria-expanded') && /[?？]$/.test(button.innerText.trim()))
      .slice(0, 24).map(button => ({ id: button.getAttribute('aria-controls'), question: button.innerText.trim() })));
  const answers = [];
  for (const panel of panels) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const opened = await page.evaluate(id => {
      const button = [...document.querySelectorAll('h2 button[type="button"], h3 button[type="button"], h4 button[type="button"]')]
        .find(item => item.getAttribute('aria-controls') === id && !item.closest('form'));
      if (!button) return false;
      if (button.getAttribute('aria-expanded') === 'false') button.click();
      return button.getAttribute('aria-expanded') === 'true' || button.hasAttribute('aria-expanded');
    }, panel.id);
    if (!opened) continue;
    try {
      const text = await page.waitForFunction(id => {
        const region = document.getElementById(id);
        return region?.getClientRects().length && region.innerText.trim() || false;
      }, panel.id, { timeout: Math.min(remaining, 500) });
      const answer = (await text.jsonValue()).replace(/\s+/g, ' ').slice(0, 4000);
      await text.dispose();
      if (answer) answers.push({ question: panel.question, answer });
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
    }
  }
  return answers;
}
export function createRenderer() {
  let browserPromise;
  const staticAssets = new Map();
  let cachedBytes = 0;
  return {
    async render(document, { policy, allowedHosts, assetHosts, timeout = 12000 }) {
      browserPromise ??= chromium.launch({ headless: true,
        args: ['--disable-background-networking', '--disable-quic',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
        proxy: { server: 'http://127.0.0.1:1', bypass: '<-loopback>' } });
      const browser = await browserPromise;
      const context = await browser.newContext({
        serviceWorkers: 'block', javaScriptEnabled: true, userAgent: agent,
        viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true
      });
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
      const blocked = new Map();
      const note = (host, reason) => {
        const key = host + ' · ' + reason;
        if (blocked.has(key) || blocked.size < 30) blocked.set(key, (blocked.get(key) ?? 0) + 1);
      };
      const target = document.finalUrl.href;
      const resourceHosts = new Set([...allowedHosts, ...assetHosts]);
      let initial = true;
      let count = 0;
      let bytes = 0;
      try {
        await context.routeWebSocket('**/*', socket => socket.close());
        const page = await context.newPage();
        await context.route('**/*', async route => {
          const request = route.request();
          let label = request.resourceType();
          try {
            const url = webUrl(request.url());
            label = url.hostname;
            if (request.method() !== 'GET') throw new Error('method excluded');
            let response;
            if (request.isNavigationRequest()) {
              if (!initial || request.frame() !== page.mainFrame() || url.href !== target)
                throw new Error('navigation excluded');
              initial = false;
              response = document;
            } else {
              if (!['script', 'stylesheet', 'xhr', 'fetch'].includes(request.resourceType()))
                throw new Error('resource type excluded');
              if (++count > 80) throw new Error('resource limit reached');
              const staticFile = ['script', 'stylesheet'].includes(request.resourceType());
              const cacheKey = url.href + ' ' + [...resourceHosts].sort().join(',');
              response = staticFile ? staticAssets.get(cacheKey) : null;
              if (!response) {
                try {
                  response = await policy.get(url, resourceHosts, { signal, maxBytes: 8 * 1024 * 1024 });
                } catch (error) {
                  if (!staticFile || signal.aborted || !['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code)) throw error;
                  response = await policy.get(url, resourceHosts, { signal, maxBytes: 8 * 1024 * 1024 });
                }
                if (staticFile && response.status === 200 && cachedBytes + response.body.length <= 24 * 1024 * 1024) {
                  staticAssets.set(cacheKey, response);
                  cachedBytes += response.body.length;
                }
              }
              bytes += response.body.length;
              if (bytes > 24 * 1024 * 1024) throw new Error('render byte limit reached');
            }
            const headers = Object.fromEntries(Object.entries(response.headers)
              .filter(([key]) => !['set-cookie', 'content-length', 'transfer-encoding', 'connection',
                'location', 'refresh', 'alt-svc'].includes(key))
              .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : String(value)]));
            await route.fulfill({ status: response.status, headers, body: Buffer.from(response.body) });
          } catch (error) {
            note(label, error.message.startsWith('URL is outside') ? 'host excluded' : error.message);
            await route.abort().catch(() => {});
          }
        });
        const deadline = Date.now() + timeout;
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout });
        let content;
        let evidence;
        let lastSignature;
        let stableSince = Date.now();
        do {
          content = await page.content();
          evidence = extract(Buffer.from(content), target, { 'content-type': 'text/html; charset=utf-8' });
          const signature = JSON.stringify([evidence.fields.title, evidence.fields.mainText, evidence.links.length]);
          if (signature !== lastSignature) {
            lastSignature = signature;
            stableSince = Date.now();
          }
          if (usable(evidence.fields) && Date.now() - stableSince >= 550) break;
          if (Date.now() >= deadline) break;
          await page.waitForTimeout(180);
        } while (true);
        const final = webUrl(page.url());
        validateScope(final, allowedHosts);
        const answers = await publicAnswers(page, deadline);
        return { ...document, finalUrl: final, body: Buffer.from(content), answers,
          headers: { ...document.headers, 'content-type': 'text/html; charset=utf-8' },
          blocked: Object.fromEntries(blocked) };
      } finally {
        controller.abort();
        await context.close();
      }
    },
    async close() {
      if (browserPromise) await browserPromise.then(browser => browser.close(), () => {});
    }
  };
}
