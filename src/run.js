// The two operations, callable from anywhere: the CLI, the HTTP surface, a test.
// Nothing in here prints; callers decide how to present the result.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { readAll, normalise, flatten } from './source/api.js';
import { fromCsv } from './sink/workbook.js';
import { openSink } from './sink/index.js';
import { Receipts, gate } from './receipts.js';
import { runChecks } from './verify/checks.js';

/** Paths inside a job file resolve against the working directory, like any CLI. */
export const rel = (p) => resolve(process.cwd(), p);

export function loadJob(path) {
  if (!path) throw new Error('a job file is required, e.g. jobs/ads-to-sheet.json');
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) throw new Error(`job file not found: ${full}`);
  const job = JSON.parse(readFileSync(full, 'utf8'));
  job.__path = full;
  job.__dir = dirname(full);
  return job;
}

export async function doSync(job, { approve = false, snapshotLabel, asOf } = {}) {
  const receipts = new Receipts(rel(job.receipts || 'out/receipts.jsonl'), {
    meta: { job: job.name, approve: !!approve, asOf },
  });

  const read = await readAll({ ...job.source, receipts });
  receipts.note('source_read', {
    rows: read.rows.length, pages: read.pages, retries: read.retriesUsed, totalHint: read.totalHint,
  });

  const rows = normalise(flatten(read.rows, job.source.flattenFields), job.source.transforms);
  const sink = openSink(job.sink);
  const plan = await sink.plan(rows);
  receipts.note('write_planned', { destination: sink.url, ...plan });

  const g = gate({ approved: !!approve, receipts, action: 'upsert', plan });
  if (!g.proceed) return { plan, written: false, reason: g.reason, receipts, read, sink };

  const res = await sink.commit(rows, { snapshotLabel });
  receipts.note('write_committed', { ...res, snapshot: snapshotLabel });
  return { plan, written: true, rows: res.rows, url: res.url, receipts, read, sink };
}

export async function doVerify(job, { asOf } = {}) {
  const sink = openSink(job.sink);
  const sheet = await sink.readCurrent();

  const truthPath = rel(job.truth.csv);
  if (!existsSync(truthPath)) throw new Error(`source-of-truth export not found: ${truthPath}`);
  const truth = fromCsv(readFileSync(truthPath, 'utf8'));

  // Snapshots are labelled with the date they were taken; the restatement check
  // needs that, not today's date, to know which days were already settled then.
  const snaps = await sink.snapshotLabels();
  const priorAsOf = snaps.length > 1 ? snaps[snaps.length - 2] : null;
  const prior = priorAsOf ? await sink.readSnapshot(priorAsOf) : [];

  let knownKeys = job.verify.knownKeys || [];
  if (job.verify.entityCsv && existsSync(rel(job.verify.entityCsv))) {
    const col = job.verify.entityColumn || 'ad_name';
    knownKeys = fromCsv(readFileSync(rel(job.verify.entityCsv), 'utf8')).map((r) => r[col]);
  }

  const config = { ...job.verify, priorSnapshot: prior, priorAsOf, knownKeys, asOf: asOf || job.verify.asOf };
  const out = runChecks({ sheet, truth, config, enabled: job.verify.checks });
  return {
    ...out,
    counts: { sheet: sheet.length, truth: truth.length, snapshots: snaps.length },
    destination: sink.url,
    config,
  };
}

/** The shape a workflow platform consumes: small, stable, no ANSI. */
export function summarise(job, verify) {
  return {
    job: job.name,
    verdict: verify.verdict,
    trustworthy: verify.failed === 0,
    failed: verify.failed,
    destination: verify.destination,
    counts: verify.counts,
    checks: verify.results.map((r) => ({ id: r.id, status: r.status, headline: r.headline })),
  };
}
