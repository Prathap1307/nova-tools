import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import robotsParser from 'robots-parser';
import { agent, fetchPublic, follow, webUrl } from './http.mjs';
import { extract, extractionVersion } from './extract.mjs';

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  db.exec(readFileSync(new URL('../database/migrations/001-initial.sql', import.meta.url), 'utf8'));
  return db;
}

export async function scanPage(db, input, { fetcher = fetchPublic, extraHosts = [] } = {}) {
  const requested = webUrl(input);
  const allowedHosts = new Set([requested.hostname, ...extraHosts]);
  const network = { allowedHosts, fetcher };
  const time = () => new Date().toISOString();
  const run = Number(db.prepare(
    "INSERT INTO crawl_runs(requested_url,started_at,state) VALUES(?,?,'running')"
  ).run(requested.href, time()).lastInsertRowid);
  const robots = new Map();

  try {
    const page = await follow(requested, {
      ...network,
      async beforeFetch(url) {
        if (!robots.has(url.origin)) {
          const address = new URL('/robots.txt', url);
          const rules = await follow(address, network);
          if (![404, 410].includes(rules.status) && (rules.status < 200 || rules.status >= 300))
            throw new Error('robots.txt unavailable (HTTP ' + rules.status + ')');
          robots.set(url.origin, robotsParser(address.href,
            rules.status === 404 || rules.status === 410 ? '' : Buffer.from(rules.body).toString('utf8')));
        }
        if (robots.get(url.origin).isAllowed(url.href, agent) === false)
          throw new Error('Page disallowed by robots.txt');
      }
    });
    if (page.status < 200 || page.status >= 300) throw new Error('Page returned HTTP ' + page.status);
    if (!/^(text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(page.headers['content-type'] || ''))
      throw new Error('Expected an HTML response');

    const { fields, links } = extract(page.body, page.finalUrl.href, page.headers);
    const observedAt = time();
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare(
        "SELECT * FROM page_snapshots WHERE requested_url=? AND mode='http' AND extraction_version=? ORDER BY id DESC LIMIT 1"
      ).get(requested.href, extractionVersion);
      const snapshot = Number(db.prepare(
        'INSERT INTO page_snapshots(run_id,requested_url,final_url,observed_at,mode,http_status,extraction_version,redirect_chain,fields) VALUES (?,?,?,?,?,?,?,?,?)'
      ).run(run, requested.href, page.finalUrl.href, observedAt, 'http', page.status, extractionVersion,
        JSON.stringify(page.redirects), JSON.stringify(fields)).lastInsertRowid);

      const saveLink = db.prepare('INSERT INTO page_links VALUES (?,?,?,?,?)');
      links.forEach((link, position) => saveLink.run(snapshot, position, link.url, link.anchor, link.kind));

      const changes = [];
      if (previous) {
        const old = { ...JSON.parse(previous.fields), finalUrl: previous.final_url,
          httpStatus: previous.http_status, redirects: JSON.parse(previous.redirect_chain) };
        const current = { ...fields, finalUrl: page.finalUrl.href, httpStatus: page.status, redirects: page.redirects };
        const saveChange = db.prepare('INSERT INTO page_changes VALUES (?,?,?,?,?)');
        for (const [field, value] of Object.entries(current)) {
          if (JSON.stringify(old[field]) === JSON.stringify(value)) continue;
          changes.push({ field, before: old[field], after: value });
          saveChange.run(previous.id, snapshot, field, JSON.stringify(old[field]), JSON.stringify(value));
        }
      }
      db.prepare("UPDATE crawl_runs SET state='complete',finished_at=? WHERE id=?").run(time(), run);
      db.exec('COMMIT');
      return { run, snapshot, previousSnapshot: previous?.id ?? null, requestedUrl: requested.href,
        finalUrl: page.finalUrl.href, status: page.status, observedAt, mode: 'http', extractionVersion,
        redirects: page.redirects, fields, links, changes };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    db.prepare("UPDATE crawl_runs SET state='failed',finished_at=?,error=? WHERE id=?")
      .run(time(), error.message, run);
    throw error;
  }
}
