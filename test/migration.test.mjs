import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../crawler/scan.mjs';

test('opens a v0.1 SQLite database in place and preserves old captures', t => {
  const folder = mkdtempSync(join(tmpdir(), 'nova-migrate-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const filename = join(folder, 'legacy.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec(readFileSync(new URL('../database/migrations/001-initial.sql', import.meta.url), 'utf8'));
  legacy.exec(`INSERT INTO crawl_runs VALUES(1,'https://example.com/','old','old','complete',NULL);
    INSERT INTO page_snapshots VALUES(1,1,'https://example.com/','https://example.com/','old','http',200,1,'[]','{}');`);
  legacy.close();
  for (let i = 0; i < 2; i++) {
    const db = openDatabase(filename);
    const stored = db.prepare('SELECT mode,extraction_version,outcome FROM page_snapshots').get();
    assert.equal(stored.mode, 'http');
    assert.equal(stored.extraction_version, 1);
    assert.equal(stored.outcome, 'unknown');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    db.close();
  }
});
