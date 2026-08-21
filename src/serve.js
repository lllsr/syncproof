// An HTTP surface, so a workflow platform that cannot run shell commands —
// n8n Cloud, Make, Zapier — can still put a verification step in front of the
// decisions it feeds.
//
// The design decision that matters: a failed verification returns **422**, not 200
// with a flag in the body. No-code platforms branch on status codes; a body field
// gets ignored, and an ignored check is not a check.

import { createServer } from 'node:http';
import { loadJob, doSync, doVerify, summarise } from './run.js';

const json = (res, status, body) => {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

export function serveApi({ port = 8790, token = process.env.SYNCPROOF_TOKEN || null, defaultJob = null } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    if (url.pathname === '/healthz') {
      return json(res, 200, { ok: true, authRequired: !!token, defaultJob });
    }

    if (token) {
      const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (given !== token) return json(res, 401, { error: 'unauthorized' });
    }

    const body = req.method === 'POST' ? await readBody(req) : {};
    const jobPath = body.job || url.searchParams.get('job') || defaultJob;

    try {
      if (url.pathname === '/verify') {
        const job = loadJob(jobPath);
        const v = await doVerify(job, { asOf: body.asOf || url.searchParams.get('asOf') });
        const summary = summarise(job, v);
        // 200 only when the sheet can be trusted; 422 is the branch a scenario takes.
        return json(res, summary.trustworthy ? 200 : 422, summary);
      }

      if (url.pathname === '/sync') {
        const job = loadJob(jobPath);
        const approve = body.approve === true || url.searchParams.get('approve') === 'true';
        const r = await doSync(job, {
          approve,
          snapshotLabel: body.snapshot || url.searchParams.get('snapshot') || new Date().toISOString().slice(0, 10),
          asOf: body.asOf || url.searchParams.get('asOf'),
        });
        return json(res, 200, {
          job: job.name,
          written: r.written,
          reason: r.reason ?? null,
          rows: r.rows ?? null,
          destination: r.url ?? r.sink?.url ?? null,
          read: { rows: r.read.rows.length, pages: r.read.pages, retries: r.read.retriesUsed },
          plan: { added: r.plan.added, revised: r.plan.revised, retained: r.plan.retained },
        });
      }

      return json(res, 404, { error: 'not found', routes: ['GET /healthz', 'POST /verify', 'POST /sync'] });
    } catch (err) {
      // 500 with the message: a scenario author needs to see the cause, and this
      // service is not reachable from outside their own network.
      return json(res, 500, { error: err.message });
    }
  });

  server.listen(port);
  return server;
}
