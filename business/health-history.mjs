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
      BEGIN IMMEDIATE;
    `);
    const previous = db.prepare('SELECT passed, checked_at FROM health_observations WHERE probe=? ORDER BY seq DESC LIMIT 1');
    const insert = db.prepare('INSERT INTO health_observations(probe,checked_at,passed,observation) VALUES(?,?,?,?)');
    const changes = results.map(result => {
      const before = previous.get(result.probe);
      if (before && before.checked_at > result.checkedAt) return { ...result, transition: 'stale' };
      const passed = Number(result.passed);
      insert.run(result.probe, result.checkedAt, passed, JSON.stringify(result));
      const transition = !before ? 'baseline' : before.passed === passed ? 'unchanged' : passed ? 'recovered' : 'degraded';
      return { ...result, transition, previousCheckedAt: before?.checked_at ?? null };
    });
    db.exec('COMMIT');
    return changes;
  } finally {
    db.close();
  }
}
