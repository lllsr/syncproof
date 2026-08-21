// The HTTP contract a workflow platform branches on. These status codes are the
// integration surface, so they get a test rather than a paragraph in the README.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serveApi } from '../src/serve.js';

const PORT = 8899;
let server, dir, originalCwd;

const columns = ['date', 'ad_name', 'spend'];
const csv = (rows) => ['date,ad_name,spend', ...rows.map((r) => `${r.date},${r.ad_name},${r.spend}`)].join('\n') + '\n';
const rows = [
  { date: '2026-07-01', ad_name: '#1.1', spend: '100.00' },
  { date: '2026-07-02', ad_name: '#1.1', spend: '150.00' },
];

before(() => {
  originalCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'syncproof-serve-'));
  process.chdir(dir);
  mkdirSync(join(dir, 'out', 'sheet', 'snapshots'), { recursive: true });
  writeFileSync(join(dir, 'out', 'platform-export.csv'), csv(rows));
  writeFileSync(join(dir, 'out', 'sheet', 'current.csv'), csv(rows));
  writeFileSync(join(dir, 'job.json'), JSON.stringify({
    name: 'test job',
    receipts: 'out/receipts.jsonl',
    source: { url: 'http://127.0.0.1:1/none' },
    sink: { type: 'local', dir: 'out/sheet', columns, keyColumns: ['date', 'ad_name'] },
    truth: { csv: 'out/platform-export.csv' },
    verify: { keyColumns: ['date', 'ad_name'], metrics: ['spend'], tolerancePct: 0.5 },
  }));
  writeFileSync(join(dir, 'mismatch.json'), JSON.stringify({
    name: 'mismatching job',
    source: { url: 'http://127.0.0.1:1/none' },
    sink: { type: 'local', dir: 'out/sheet', columns, keyColumns: ['date', 'ad_name'] },
    truth: { csv: 'out/wrong-export.csv' },
    verify: { keyColumns: ['date', 'ad_name'], metrics: ['spend'], tolerancePct: 0.5 },
  }));
  // Same rows, one number changed: the sheet no longer matches the export.
  writeFileSync(join(dir, 'out', 'wrong-export.csv'), csv([rows[0], { ...rows[1], spend: '999.00' }]));
  server = serveApi({ port: PORT, token: 'secret' });
});

after(async () => {
  await new Promise((f) => server.close(f));
  process.chdir(originalCwd);
});

const call = (path, { token = 'secret', method = 'POST' } = {}) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

test('healthz needs no token, and says whether one is required', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).authRequired, true);
});

test('a missing or wrong token is refused', async () => {
  assert.equal((await call('/verify?job=job.json', { token: null })).status, 401);
  assert.equal((await call('/verify?job=job.json', { token: 'wrong' })).status, 401);
});

test('a sheet that matches the export returns 200', async () => {
  const res = await call('/verify?job=job.json');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.trustworthy, true);
  assert.equal(body.failed, 0);
});

test('a sheet that disagrees returns 422, so a scenario can branch on it', async () => {
  const res = await call('/verify?job=mismatch.json');
  assert.equal(res.status, 422, 'not 200-with-a-flag: a flag in the body gets ignored');
  const body = await res.json();
  assert.equal(body.trustworthy, false);
  assert.ok(body.checks.some((c) => c.status === 'fail' && /disagree|differ/.test(c.headline)));
});

test('a sync without approval writes nothing and says so', async () => {
  // The source is unreachable on purpose: the point is that no write is attempted
  // before the read succeeds, and that the failure is reported rather than swallowed.
  const res = await call('/sync?job=job.json');
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /cannot reach/);
});

test('an unknown route lists what is available', async () => {
  const res = await call('/nope');
  assert.equal(res.status, 404);
  assert.ok((await res.json()).routes.includes('POST /verify'));
});

test('a missing job file is reported, not treated as an empty job', async () => {
  const res = await call('/verify?job=does-not-exist.json');
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /job file not found/);
});
