import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { webUrl } from './http.mjs';
import { extract, extractionVersion } from './extract.mjs';
import { createPolicy } from './policy.mjs';
import { createRenderer, usable } from './browser.mjs';

export const modes = ['http', 'browser', 'auto'];
const now = () => new Date().toISOString();
const migrations = ['001-initial.sql', '002-capture-outcomes.sql'];

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    db.exec('BEGIN IMMEDIATE');
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > migrations.length) throw new Error('Database requires a newer crawler');
    for (const migration of migrations.slice(version))
      db.exec(readFileSync(new URL('../database/migrations/' + migration, import.meta.url), 'utf8'));
    db.exec('PRAGMA user_version=' + migrations.length + '; COMMIT');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function beginRun(db, requested, parent = null) {
  return Number(db.prepare(
    "INSERT INTO crawl_runs(requested_url,started_at,state,parent_run_id) VALUES(?,?,'running',?)"
  ).run(requested.href, now(), parent).lastInsertRowid);
}

function failRun(db, run, error) {
  db.prepare("UPDATE crawl_runs SET state='failed',finished_at=?,error=? WHERE id=?")
    .run(now(), error.message, run);
}

function checkHtml(page) {
  if (page.status < 200 || page.status >= 300) throw new Error('Page returned HTTP ' + page.status);
  if (!/^(text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(page.headers['content-type'] || ''))
    throw new Error('Expected an HTML response');
}

function saveCapture(db, run, requested, page, mode) {
  const { fields, links } = extract(page.body, page.finalUrl.href, page.headers);
  if (mode === 'browser') {
    fields.answers = page.answers ?? [];
    const extra = fields.answers.filter(item => !fields.mainText?.includes(item.answer))
      .map(item => item.question + ' ' + item.answer).join(' ');
    if (extra) fields.mainText = [fields.mainText, extra].filter(Boolean).join(' ').slice(0, 50000);
  }
  const outcome = usable(fields) ? 'usable' : 'no_usable_content';
  const flags = [];
  if (fields.canonical) {
    const canonical = new URL(fields.canonical);
    if (requested.pathname !== '/' && canonical.pathname === '/'
        && [requested.hostname, page.finalUrl.hostname].includes(canonical.hostname)) {
      flags.push('homepage_canonical_on_non_homepage');
    }
  }
  const observedAt = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare(
      'SELECT * FROM page_snapshots WHERE requested_url=? AND mode=? AND extraction_version=? ORDER BY id DESC LIMIT 1'
    ).get(requested.href, mode, extractionVersion);
    const snapshot = Number(db.prepare(
      'INSERT INTO page_snapshots(run_id,requested_url,final_url,observed_at,mode,http_status,extraction_version,redirect_chain,fields,outcome,flags) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run(run, requested.href, page.finalUrl.href, observedAt, mode, page.status, extractionVersion,
      JSON.stringify(page.redirects), JSON.stringify(fields), outcome, JSON.stringify(flags)).lastInsertRowid);

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
    db.prepare("UPDATE crawl_runs SET state='complete',finished_at=? WHERE id=?").run(now(), run);
    db.exec('COMMIT');
    return { run, snapshot, previousSnapshot: previous?.id ?? null, requestedUrl: requested.href,
      finalUrl: page.finalUrl.href, status: page.status, observedAt, mode, extractionVersion,
      redirects: page.redirects, fields, links, changes, outcome, flags,
      ...(page.blocked ? { blockedResources: page.blocked } : {}) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function scanPage(db, input, { mode = 'http', fetcher, extraHosts = [], assetHosts = [],
  policy = createPolicy({ fetcher }), renderer, timeout } = {}) {
  if (!modes.includes(mode)) throw new Error('Mode must be http, browser, or auto');
  const requested = webUrl(input);
  const allowedHosts = new Set([requested.hostname, ...extraHosts]);
  let run = beginRun(db, requested);
  let raw;
  let ownedRenderer;
  let browserAttempted = false;
  try {
    const page = await policy.get(requested, allowedHosts);
    checkHtml(page);
    if (mode !== 'browser') {
      raw = saveCapture(db, run, requested, page, 'http');
      if (mode === 'http' || raw.outcome === 'usable') return raw;
      run = beginRun(db, requested, run);
    }
    browserAttempted = true;
    const engine = renderer ?? (ownedRenderer = createRenderer());
    const rendered = await engine.render(page, { policy, allowedHosts, assetHosts, timeout });
    const capture = saveCapture(db, run, requested, rendered, 'browser');
    return raw ? { ...capture, raw } : capture;
  } catch (error) {
    failRun(db, run, error);
    if (raw) return { ...raw, renderError: error.message, browserAttempted };
    if (browserAttempted) error.browserAttempted = true;
    throw error;
  } finally {
    await ownedRenderer?.close();
  }
}
