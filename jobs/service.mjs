import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { claimJob, enqueue, findJob, finishJob, jobView, latestReport, renew, saveSteps } from './store.mjs';

const digest = value => createHash('sha256').update(value).digest();
const siteRoute = /^\/v1\/sites\/([a-z0-9][a-z0-9-]{0,63})\/(jobs|report)$/;
const jobRoute = /^\/v1\/jobs\/([0-9a-f-]{36})(\/report)?$/;

export function createJobService({ db, sites, token, runReview, pollMs = 250, leaseMs = 45000 }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('Set NOVA_TOOLS_TOKEN to at least 32 characters');
  const auth = digest('Bearer ' + token);
  const worker = randomUUID();
  let inFlight;
  let stopping = false;

  async function run(job) {
    const steps = [];
    const pulse = setInterval(() => renew(db, job.id, worker, leaseMs), Math.floor(leaseMs / 3));
    try {
      if (!sites.has(job.site)) throw new Error('Site configuration is unavailable');
      const report = await runReview(job.site, job.id, step => {
        steps.push(step);
        saveSteps(db, job.id, worker, steps);
      });
      if (!['complete', 'partial'].includes(report?.outcome)) throw new Error('Invalid review result');
      finishJob(db, job.id, worker, report.outcome, { report, steps: report.steps ?? steps });
    } catch (error) {
      finishJob(db, job.id, worker, 'failed', { error: error.message, steps });
    } finally {
      clearInterval(pulse);
    }
  }

  function pump() {
    if (stopping || inFlight) return;
    const job = claimJob(db, worker, leaseMs);
    if (!job) return;
    inFlight = run(job).finally(() => { inFlight = undefined; });
  }

  const timer = setInterval(pump, pollMs);
  timer.unref();
  const server = createServer((req, res) => {
    const send = (status, value, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(value));
    };
    function sendReport(row) {
      if (!row) return send(404, { error: 'Report not found' });
      if (!row.report) return send(409, { error: 'Report unavailable', job: jobView(row) });
      return send(200, { job: jobView(row), report: JSON.parse(row.report) });
    }
    try {
      if (!timingSafeEqual(digest(req.headers.authorization ?? ''), auth))
        return send(401, { error: 'Bearer token required' }, { 'WWW-Authenticate': 'Bearer' });
      const siteMatch = siteRoute.exec(req.url);
      const jobMatch = jobRoute.exec(req.url);
      if (siteMatch) {
        const [, site, action] = siteMatch;
        if (!sites.has(site)) return send(404, { error: 'Unknown site ID' });
        if (action === 'jobs' && req.method === 'POST') {
          if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0)
            return send(400, { error: 'Start requests do not accept a body' });
          if (stopping) return send(503, { error: 'Job runner is stopping' });
          const result = enqueue(db, site);
          return send(202, result, { Location: '/v1/jobs/' + result.job.id });
        }
        if (action === 'report' && req.method === 'GET') return sendReport(latestReport(db, site));
        return send(405, { error: 'Method not allowed' }, { Allow: action === 'jobs' ? 'POST' : 'GET' });
      }
      if (jobMatch) {
        if (req.method !== 'GET') return send(405, { error: 'Method not allowed' }, { Allow: 'GET' });
        const row = findJob(db, jobMatch[1]);
        if (!row) return send(404, { error: 'Job not found' });
        return jobMatch[2] ? sendReport(row) : send(200, { job: jobView(row) });
      }
      return send(404, { error: 'Endpoint not found' });
    } catch {
      return send(500, { error: 'Job service could not complete the request' });
    }
  });
  return { server, async close() {
    stopping = true;
    clearInterval(timer);
    const closed = server.listening ? new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())) : Promise.resolve();
    await Promise.all([closed, inFlight]);
  } };
}
