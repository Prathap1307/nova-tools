import { DatabaseSync } from 'node:sqlite';

export function recordHealth(filename, results) {
  const db = new DatabaseSync(filename);
  try {
    db.exec(`
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS health_observations (
        seq INTEGER PRIMARY KEY, probe TEXT NOT NULL, checked_at TEXT NOT NULL,
        passed INTEGER NOT NULL, observation TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS health_probe_history ON health_observations(probe, seq);
      CREATE TABLE IF NOT EXISTS health_alerts (
        observation_seq INTEGER PRIMARY KEY, probe TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('outage','recovery')), started_at TEXT NOT NULL,
        detected_at TEXT NOT NULL, details TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS health_alert_probe ON health_alerts(probe, observation_seq);
      BEGIN IMMEDIATE;
    `);
    const previous = db.prepare('SELECT passed, checked_at FROM health_observations WHERE probe=? ORDER BY seq DESC LIMIT 1');
    const insert = db.prepare('INSERT INTO health_observations(probe,checked_at,passed,observation) VALUES(?,?,?,?)');
    const lastAlert = db.prepare('SELECT kind, started_at FROM health_alerts WHERE probe=? ORDER BY observation_seq DESC LIMIT 1');
    const saveAlert = db.prepare('INSERT INTO health_alerts VALUES(?,?,?,?,?,?)');
    const changes = results.map(result => {
      const before = previous.get(result.probe);
      if (before && before.checked_at > result.checkedAt) return { ...result, transition: 'stale' };
      if (before?.checked_at === result.checkedAt) return { ...result, transition: 'duplicate' };
      const active = lastAlert.get(result.probe);
      const passed = Number(result.passed);
      const { lastInsertRowid } = insert.run(result.probe, result.checkedAt, passed, JSON.stringify(result));
      const transition = !before ? 'baseline' : before.passed === passed ? 'unchanged' : passed ? 'recovered' : 'degraded';
      const open = active?.kind === 'outage';
      let alert;
      if (!passed && !open && before?.passed === 0) {
        alert = { kind: 'outage', startedAt: before.checked_at, detectedAt: result.checkedAt,
          failures: result.failures ?? [] };
      } else if (passed && open) {
        alert = { kind: 'recovery', startedAt: active.started_at, detectedAt: result.checkedAt };
      }
      if (alert) saveAlert.run(lastInsertRowid, result.probe, alert.kind, alert.startedAt,
        alert.detectedAt, JSON.stringify(alert));
      return { ...result, transition, previousCheckedAt: before?.checked_at ?? null, ...(alert && { alert }) };
    });
    db.exec('COMMIT');
    return changes;
  } finally {
    db.close();
  }
}
