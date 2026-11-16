import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createJobService } from '../jobs/service.mjs';
import { claimJob, enqueue, findJob, finishJob, openJobs } from '../jobs/store.mjs';

test('job API authenticates, deduplicates and returns progress and reports', async t => {
  const db = openJobs(':memory:');
  const token = 'test-token-'.repeat(4);
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const service = createJobService({
    db, token, sites: new Map([['simpleparking', {}]]), pollMs: 10,
    async runReview(site, id, step) {
      step({ name: 'crawl', status: 'complete' });
      started.resolve();
      await gate.promise;
      return { site, outcome: 'partial' };
    }
  });
  t.after(async () => {
    gate.resolve();
    await service.close();
    db.close();
  });
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  const base = 'http://127.0.0.1:' + service.server.address().port;
  function call(path, options = {}) {
    return fetch(base + path, { headers: { Authorization: 'Bearer ' + token }, ...options });
  }
  const site = '/v1/sites/simpleparking';
  assert.equal((await call(site + '/report', { headers: {} })).status, 401);
  assert.equal((await call('/v1/sites/unknown/jobs', { method: 'POST' })).status, 404);
  assert.equal((await call(site + '/jobs', { method: 'POST', body: '{}' })).status, 400);
  const start = await call(site + '/jobs', { method: 'POST' });
  assert.equal(start.status, 202);
  const { job } = await start.json();
  const path = start.headers.get('location');
  assert.equal(path, '/v1/jobs/' + job.id);
  await started.promise;
  const current = await (await call(path)).json();
  assert.equal(current.job.status, 'running');
  assert.equal(current.job.steps[0].name, 'crawl');
  const duplicate = await (await call(site + '/jobs', { method: 'POST' })).json();
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.job.id, job.id);
  assert.equal((await call(path + '/report')).status, 409);
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  const result = await call(path + '/report');
  assert.equal(result.status, 200);
  const envelope = await result.json();
  assert.equal(envelope.job.status, 'partial');
  assert.deepEqual(await (await call(site + '/report')).json(), envelope);
});

test('expired lease fails the interrupted job and fences stale writes', () => {
  const db = openJobs(':memory:');
  try {
    const first = enqueue(db, 'a', 1000).job;
    const next = enqueue(db, 'b', 1001).job;
    assert.equal(claimJob(db, 'old', 100, 1002).id, first.id);
    assert.equal(claimJob(db, 'new', 100, 1101), null);
    assert.equal(claimJob(db, 'new', 100, 1102).id, next.id);
    assert.equal(findJob(db, first.id).status, 'failed');
    assert.equal(finishJob(db, first.id, 'old', 'complete', {}, 1103), false);
  } finally {
    db.close();
  }
});
