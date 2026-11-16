import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const utc = now => new Date(now).toISOString();

export function openJobs(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS review_jobs (
      id TEXT PRIMARY KEY, site TEXT NOT NULL, status TEXT NOT NULL
        CHECK(status IN ('queued','running','complete','partial','failed')),
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
      worker TEXT, lease_until INTEGER, steps TEXT NOT NULL DEFAULT '[]',
      report TEXT, error TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS active_site_review ON review_jobs(site)
      WHERE status IN ('queued','running');
    CREATE INDEX IF NOT EXISTS review_job_history ON review_jobs(site,status,finished_at);
  `);
  return db;
}

function atomic(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function jobView(row) {
  return { id: row.id, site: row.site, status: row.status, createdAt: row.created_at,
    startedAt: row.started_at, finishedAt: row.finished_at,
    steps: JSON.parse(row.steps), ...(row.error ? { error: row.error } : {}) };
}

export function enqueue(db, site, now = Date.now()) {
  return atomic(db, () => {
    const current = db.prepare("SELECT * FROM review_jobs WHERE site=? AND status IN ('queued','running')").get(site);
    if (current) return { job: jobView(current), reused: true };
    const id = randomUUID();
    db.prepare("INSERT INTO review_jobs(id,site,status,created_at) VALUES(?,?,'queued',?)").run(id, site, utc(now));
    return { job: jobView(findJob(db, id)), reused: false };
  });
}

export function findJob(db, id) {
  return db.prepare('SELECT * FROM review_jobs WHERE id=?').get(id);
}

export function latestReport(db, site) {
  return db.prepare("SELECT * FROM review_jobs WHERE site=? AND status IN ('complete','partial')"
    + ' ORDER BY finished_at DESC,rowid DESC LIMIT 1').get(site);
}

export function claimJob(db, worker, leaseMs, now = Date.now()) {
  return atomic(db, () => {
    db.prepare("UPDATE review_jobs SET status='failed',finished_at=?,error='Worker interrupted before review completed.',"
      + "worker=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?").run(utc(now), now);
    if (db.prepare("SELECT 1 FROM review_jobs WHERE status='running' LIMIT 1").get()) return null;
    const next = db.prepare("SELECT * FROM review_jobs WHERE status='queued' ORDER BY rowid LIMIT 1").get();
    if (!next) return null;
    db.prepare("UPDATE review_jobs SET status='running',started_at=?,worker=?,lease_until=? WHERE id=?")
      .run(utc(now), worker, now + leaseMs, next.id);
    return findJob(db, next.id);
  });
}

export function renew(db, id, worker, leaseMs, now = Date.now()) {
  return db.prepare("UPDATE review_jobs SET lease_until=? WHERE id=? AND worker=? AND status='running' AND lease_until>?")
    .run(now + leaseMs, id, worker, now).changes > 0;
}

export function saveSteps(db, id, worker, steps) {
  db.prepare("UPDATE review_jobs SET steps=? WHERE id=? AND worker=? AND status='running'")
    .run(JSON.stringify(steps), id, worker);
}

export function finishJob(db, id, worker, status, { report, error, steps = [] } = {}, now = Date.now()) {
  if (!['complete', 'partial', 'failed'].includes(status)) throw new Error('Invalid terminal job status');
  return db.prepare("UPDATE review_jobs SET status=?,finished_at=?,report=?,error=?,steps=?,worker=NULL,lease_until=NULL"
    + " WHERE id=? AND worker=? AND status='running' AND lease_until>?")
    .run(status, utc(now), report ? JSON.stringify(report) : null, error ?? null,
      JSON.stringify(steps), id, worker, now).changes > 0;
}
