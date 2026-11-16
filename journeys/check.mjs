import { writeFile } from 'node:fs/promises';
import { createRenderer } from '../crawler/browser.mjs';
import { createPolicy } from '../crawler/policy.mjs';
import { webUrl } from '../crawler/http.mjs';

const viewport = { width: 412, height: 915 };

function matcher(rule) {
  return rule.pattern ? new RegExp(rule.pattern, 'i') : rule.name;
}
function locate(container, rule) {
  if (rule.selector) return container.locator(rule.selector);
  if (rule.role) return container.getByRole(rule.role, { name: matcher(rule), exact: !rule.pattern });
  if (rule.text) return container.getByText(rule.text, { exact: true });
  return container.getByLabel(matcher(rule), { exact: !rule.pattern });
}
function pathMatches(url, match) {
  return (!match.path || url.pathname === match.path)
    && (!match.hash || url.hash === match.hash)
    && Object.entries(match.query ?? {}).every(([key, value]) => url.searchParams.get(key) === value);
}
function matchConfig(config) {
  if (!config?.id || !config?.startUrl || !config.cta?.name
      || !['button', 'link'].includes(config.cta.role)
      || !Array.isArray(config.expected?.destinations) || !config.expected.destinations.length
      || config.expected.destinations.some(item => typeof item.path !== 'string' || !item.path.startsWith('/'))
      || !Array.isArray(config.allowedPaths) || !config.allowedPaths.length
      || !Array.isArray(config.expected.controls) || !config.expected.controls.length)
    throw new Error('Invalid journey configuration');
  return webUrl(config.startUrl);
}

export async function checkJourney(config, { fetcher, renderer, screenshot, timeout = 15000 } = {}) {
  const seed = matchConfig(config);
  const report = { id: config.id, sourceUrl: seed.href, viewport, cta: config.cta.name,
    expected: config.expected, checkedAt: new Date().toISOString(), outcome: 'unverified', steps: [] };
  const engine = renderer ?? createRenderer();
  const policy = createPolicy({ fetcher, delayMs: 150 });
  const allowedHosts = new Set([seed.hostname]);
  let clicked = false;
  const safeDocument = url => url.origin === seed.origin && config.allowedPaths.includes(url.pathname);
  const allowNavigation = url => clicked && safeDocument(url);
  const step = (name, outcome, evidence = {}) => report.steps.push({ name, outcome, ...evidence });

  try {
    const document = await policy.get(seed, allowedHosts, { checkUrl: url => {
      if (!safeDocument(url)) throw new Error('Source navigation is outside the configured public routes');
    } });
    if (document.status < 200 || document.status >= 300 || !/^text\/html\b/i.test(document.headers['content-type'] ?? ''))
      throw new Error('Opening the source did not return an HTML page (HTTP ' + document.status + ')');
    await engine.browse(document, { policy, allowedHosts, timeout, allowNavigation, expandAnswers: false },
      async (page, session) => {
        const fail = async (name, outcome, reason, evidence = {}) => {
          report.outcome = outcome;
          step(name, outcome, { reason, ...evidence });
          if (screenshot) {
            try {
              const image = await page.screenshot({ timeout: 3000, animations: 'disabled' });
              await writeFile(screenshot, image, { flag: 'wx' });
              report.screenshot = screenshot;
            } catch (error) {
              report.screenshotError = error.message;
            }
          }
        };
        try {
          step('open', 'pass', { url: page.url(), status: document.status });
          const scope = config.cta.scope ? page.locator(config.cta.scope) : page;
          const controls = locate(scope, config.cta).filter({ visible: true });
          try {
            await controls.first().waitFor({ state: 'visible',
              timeout: Math.min(6500, Math.max(1, session.deadline - Date.now())) });
          } catch {
            const rendered = await page.locator('h1').first().isVisible();
            await fail('cta', rendered ? 'fail' : 'unverified',
              rendered ? 'Expected CTA was not visible' : 'The source did not expose a rendered heading or CTA',
              { label: config.cta.name });
            return;
          }
          if (await controls.count() !== 1) {
            await fail('cta', 'unverified', 'Multiple visible CTAs matched the configuration');
            return;
          }
          const cta = controls.first();
          const info = await cta.evaluate(element => ({
            tag: element.tagName.toLowerCase(),
            form: Boolean(element.closest('form')),
            href: element.getAttribute('href'),
            popup: element.getAttribute('target') === '_blank'
          }));
          if (info.form || info.popup || !['a', 'button'].includes(info.tag)) {
            await fail('cta', 'unverified', 'The CTA is outside the supported read-only interaction', info);
            return;
          }
          if (info.href) {
            let target;
            try { target = webUrl(info.href, page.url()); } catch { /* rejected below */ }
            if (!target || !safeDocument(target)) {
              await fail('destination', 'fail', 'CTA link points outside the configured public route',
                { href: info.href });
              return;
            }
          }
          if (!await cta.isEnabled()) {
            await fail('cta', 'fail', 'Expected CTA is disabled', { label: config.cta.name });
            return;
          }
          step('cta', 'pass', { label: config.cta.name, visible: true, enabled: true, tag: info.tag });

          clicked = true;
          try {
            await cta.tap({ timeout: Math.min(3500, Math.max(1, session.deadline - Date.now())) });
          } catch (error) {
            const navigation = session.blockedNavigations.at(-1);
            await fail(navigation ? 'destination' : 'tap', navigation ? 'fail' : 'unverified',
              navigation?.reason ?? 'CTA tap did not complete', { url: navigation?.url ?? page.url() });
            return;
          }
          step('tap', 'pass');
          const landing = config.expected.landing
            ? locate(page, config.expected.landing).filter({ visible: true }).first() : null;
          // A SPA may update the path and mount the quote panel on different turns.
          if (landing) await landing.waitFor({ state: 'visible',
            timeout: Math.min(4500, Math.max(1, session.deadline - Date.now())) }).catch(() => {});
          else await page.waitForURL(url => config.expected.destinations.some(match => pathMatches(url, match)),
            { timeout: Math.min(4000, Math.max(1, session.deadline - Date.now())) }).catch(() => {});
          const actual = new URL(page.url());
          const blocked = session.blockedNavigations.at(-1);
          const heading = await page.locator("h1").first().innerText({ timeout: 500 }).catch(() => null);
          if (blocked || !safeDocument(actual)
              || !config.expected.destinations.some(match => pathMatches(actual, match))) {
            await fail('destination', 'fail', blocked?.reason ?? 'CTA did not reach the expected route',
              { url: actual.href, heading, attemptedUrl: blocked?.url, expected: config.expected.destinations });
            return;
          }
          if (landing && !await landing.isVisible()) {
            await fail('destination', 'fail', 'Expected quote panel is missing', { url: actual.href, heading });
            return;
          }
          const bounds = landing ? await landing.boundingBox() : null;
          step('destination', 'pass', { url: actual.href, heading, ...(bounds
            ? { quoteHeadingInViewport: bounds.y + bounds.height > 0 && bounds.y < viewport.height }
            : {}) });
          const panel = config.expected.scope ? page.locator(config.expected.scope).first() : page;
          const quoteControls = [];
          for (const entry of config.expected.controls) {
            const field = locate(panel, entry).filter({ visible: true }).first();
            const visible = await field.isVisible();
            quoteControls.push({ label: entry.name, visible, enabled: visible && await field.isEnabled() });
          }
          if (quoteControls.some(field => !field.visible || !field.enabled)) {
            await fail('quote_controls', 'fail', 'One or more required controls are missing or disabled',
              { controls: quoteControls });
            return;
          }
          step('quote_controls', 'pass', { controls: quoteControls });
          const terminal = config.expected.terminal;
          if (terminal) {
            const marker = locate(panel, terminal).filter({ visible: true }).first();
            const visible = await marker.isVisible();
            if (!visible && terminal.required) {
              await fail('terminal_context', 'fail', 'Expected terminal context was not visible');
              return;
            }
            step('terminal_context', visible ? 'pass' : 'info',
              { visible, required: Boolean(terminal.required), expected: terminal.name ?? terminal.text });
          }
          report.outcome = 'pass';
        } catch (error) {
          await fail('browser', 'unverified', error.message);
        } finally {
          report.finalUrl = page.url();
          report.blockedResources = session.blockedResources();
        }
      });
  } catch (error) {
    step(report.steps.length ? 'browser' : 'open', 'unverified', { reason: error.message });
  } finally {
    if (!renderer) await engine.close();
  }
  return report;
}
