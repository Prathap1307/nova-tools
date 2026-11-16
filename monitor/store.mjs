import { DatabaseSync } from 'node:sqlite';

export function openMonitor(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS monitor_runs (
      id INTEGER PRIMARY KEY, site TEXT NOT NULL, created_at TEXT NOT NULL, summary TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS monitor_site_history ON monitor_runs(site,id);
    CREATE TABLE IF NOT EXISTS monitor_artifacts (
      run_id INTEGER NOT NULL REFERENCES monitor_runs(id),
      kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id,kind)
    );
  `);
  return db;
}

export function readHistory(db, site) {
  const rows = db.prepare(`
    SELECT run.id, run.created_at, item.kind, item.data
    FROM monitor_runs run JOIN monitor_artifacts item ON item.run_id=run.id
    WHERE run.site=? ORDER BY run.id,item.kind
  `).iterate(site);
  const history = new Map();
  for (const row of rows) {
    if (!history.has(row.id)) history.set(row.id, { id: row.id, createdAt: row.created_at, artifacts: {} });
    history.get(row.id).artifacts[row.kind] = JSON.parse(row.data);
  }
  return [...history.values()];
}

export function saveRun(db, report, artifacts) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const latest = db.prepare('SELECT MAX(id) AS id FROM monitor_runs WHERE site=?').get(report.site).id;
    if (latest !== report.previousRunId) throw new Error('Another monitor run was saved. Run the comparison again.');
    const entry = db.prepare('INSERT INTO monitor_runs(site,created_at,summary) VALUES(?,?,?)')
      .run(report.site, report.generatedAt, JSON.stringify(report));
    const runId = Number(entry.lastInsertRowid);
    const add = db.prepare('INSERT INTO monitor_artifacts(run_id,kind,data) VALUES(?,?,?)');
    for (const [kind, value] of Object.entries(artifacts)) if (value) add.run(runId, kind, JSON.stringify(value));
    db.exec('COMMIT');
    return { ...report, runId };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
