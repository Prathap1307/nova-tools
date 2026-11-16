import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recordHealth } from '../business/health-history.mjs';

test('health history survives reopen and reports degradation and recovery per probe', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nova-health-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'health.sqlite');
  function sample(day, passed, probe = 'homepage') {
    return recordHealth(db, [{ probe, passed, checkedAt: '2026-01-0' + day }])[0].transition;
  }
  assert.equal(sample(1, true), 'baseline');
  assert.equal(sample(2, false), 'degraded');
  assert.equal(sample(3, false), 'unchanged');
  assert.equal(sample(4, true), 'recovered');
  assert.equal(sample(1, false), 'stale');
  assert.equal(sample(5, true), 'unchanged');
  assert.equal(sample(5, false, 'faq'), 'baseline');
});
