#!/usr/bin/env node
// syncproof — sync a reporting API into a sheet, then prove the sheet matches it.
//
//   syncproof simulate  [--port 8787] [--faults a,b]   run the stand-in API
//   syncproof sync      <job.json> [--approve]          read source, plan, write
//   syncproof verify    <job.json>                      compare sheet to the export
//   syncproof report    <job.json> [--out f.html]       write the diff report
//   syncproof demo      [--faults a,b] [--clean]        all of the above, end to end

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createSimulator, serve, FAULTS } from './sim/server.js';
import { buildLedger, applyRestatement, exportRows, toCsv as ledgerCsv, EXPORT_COLUMNS } from './sim/ledger.js';
import { readAll, normalise } from './source/api.js';
import { fromCsv } from './sink/workbook.js';
import { openSink } from './sink/index.js';
import { createSpreadsheet } from './sink/sheets.js';
import { Receipts, gate } from './receipts.js';
import { runChecks } from './verify/checks.js';
import { renderReport } from './verify/report.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const positional = argv.slice(1).filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true);

function loadJob(path) {
  if (!path) die('a job file is required, e.g. jobs/ads-to-sheet.json');
  const job = JSON.parse(readFileSync(path, 'utf8'));
  job.__dir = dirname(resolve(path));
  return job;
}
// Paths in a job file are relative to where the command is run, the way every
// other CLI behaves — so a scheduled run and a manual run land in the same place.
const rel = (_job, p) => resolve(process.cwd(), p);
function die(msg) { console.error(`syncproof: ${msg}`); process.exit(2); }

const C = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' };
const mark = (s) => (s === 'pass' ? `${C.green}✓${C.off}` : s === 'fail' ? `${C.red}✗${C.off}` : `${C.yellow}!${C.off}`);

// ---------------------------------------------------------------- sync

async function doSync(job, { approve, snapshotLabel, asOf }) {
  const receipts = new Receipts(rel(job, job.receipts || 'out/receipts.jsonl'), {
    meta: { job: job.name, approve: !!approve, asOf },
  });

  const read = await readAll({ ...job.source, receipts });
  receipts.note('source_read', {
    rows: read.rows.length, pages: read.pages, retries: read.retriesUsed, totalHint: read.totalHint,
  });

  const rows = normalise(read.rows, job.source.transforms);
  const sink = openSink(job.sink);
  const plan = await sink.plan(rows);
  receipts.note('write_planned', { destination: sink.url, ...plan });

  const g = gate({ approved: !!approve, receipts, action: 'upsert', plan });
  if (!g.proceed) {
    return { plan, written: false, reason: g.reason, receipts, read, sink };
  }
  const res = await sink.commit(rows, { snapshotLabel });
  receipts.note('write_committed', { ...res, snapshot: snapshotLabel });
  return { plan, written: true, rows: res.rows, receipts, read, sink, url: res.url };
}

// ---------------------------------------------------------------- verify

async function doVerify(job, { asOf } = {}) {
  const sink = openSink(job.sink);
  const sheet = await sink.readCurrent();
  const truthPath = rel(job, job.truth.csv);
  if (!existsSync(truthPath)) die(`source-of-truth export not found: ${truthPath}`);
  const truth = fromCsv(readFileSync(truthPath, 'utf8'));

  // Snapshots are labelled with the date they were taken; the restatement check
  // needs that, not today's date, to know which days were already settled then.
  const snaps = await sink.snapshotLabels();
  const priorAsOf = snaps.length > 1 ? snaps[snaps.length - 2] : null;
  const prior = priorAsOf ? await sink.readSnapshot(priorAsOf) : [];

  let knownKeys = job.verify.knownKeys || [];
  if (job.verify.entityCsv && existsSync(rel(job, job.verify.entityCsv))) {
    const col = job.verify.entityColumn || 'ad_name';
    knownKeys = fromCsv(readFileSync(rel(job, job.verify.entityCsv), 'utf8')).map((r) => r[col]);
  }

  const config = { ...job.verify, priorSnapshot: prior, priorAsOf, knownKeys, asOf: asOf || job.verify.asOf };
  const out = runChecks({ sheet, truth, config, enabled: job.verify.checks });
  return { ...out, counts: { sheet: sheet.length, truth: truth.length, snapshots: snaps.length }, config, destination: sink.url };
}

function printVerify(v) {
  console.log(`\n${C.bold}verdict: ${v.verdict === 'MATCHES SOURCE' ? C.green : C.red}${v.verdict}${C.off}`
    + `  ${C.dim}(sheet ${v.counts.sheet} rows · export ${v.counts.truth} rows · ${v.counts.snapshots} snapshot(s))${C.off}\n`);
  for (const r of v.results) {
    console.log(`  ${mark(r.status)} ${r.id.padEnd(20)} ${r.headline}`);
  }
  console.log('');
  return v.failed ? 1 : 0;
}

// ---------------------------------------------------------------- demo

async function doDemo() {
  const clean = !!flag('clean');
  const faults = clean ? [] : String(flag('faults', 'micros,cursor_drift,rate_limit,rename')).split(',').filter(Boolean);
  const port = Number(flag('port', 8811));
  const jobPath = flag('job', join(dirname(new URL(import.meta.url).pathname.slice(1)), '..', 'jobs', 'ads-to-sheet.json'));
  const job = loadJob(jobPath);
  const outDir = rel(job, 'out');
  mkdirSync(outDir, { recursive: true });

  console.log(`${C.bold}syncproof demo${C.off}  ${C.dim}faults: ${faults.length ? faults.join(', ') : 'none'}${C.off}`);
  for (const f of faults) console.log(`  ${C.dim}· ${f}: ${FAULTS[f] || 'unknown fault'}${C.off}`);

  // Two runs, a day apart: the second is what makes history and restatement checkable.
  const runs = ['2026-08-13', '2026-08-14'];
  const sim = createSimulator({ faults, asOf: runs[0] });
  const server = serve(sim, port);
  let lastSync;
  try {
    for (const asOf of runs) {
      sim.setAsOf(asOf);
      // The client's own export, taken at the same moment — this is the source of truth.
      const truth = exportRows(applyRestatement(buildLedger({}).rows, asOf));
      writeFileSync(rel(job, job.truth.csv), ledgerCsv(truth, EXPORT_COLUMNS), 'utf8');

      const jobRun = structuredClone(job);
      jobRun.__dir = job.__dir;
      jobRun.source.url = `http://127.0.0.1:${port}/v1/ads`;
      if (flag('naive')) jobRun.sink.mode = 'append';   // emulate an "add row" automation
      // A rolling window introduced on the second run is the realistic version of
      // this failure: the sheet was complete, then someone "tidied it up".
      if (flag('rolling') && asOf === runs[runs.length - 1]) jobRun.sink.keepDays = Number(flag('rolling'));
      lastSync = await doSync(jobRun, { approve: true, snapshotLabel: asOf, asOf });
      console.log(`\n  ${C.dim}run ${asOf}:${C.off} read ${lastSync.read.rows.length} rows in ${lastSync.read.pages} page(s)`
        + `${lastSync.read.retriesUsed ? `, ${lastSync.read.retriesUsed} retry/ies` : ''}`
        + ` → +${lastSync.plan.added} added, ~${lastSync.plan.revised} revised, ${lastSync.plan.retained} retained`);
    }
  } finally {
    await new Promise((f) => server.close(f));
  }

  // The entity list the client maintains by hand (their roadmap tab).
  const ads = [...new Set(buildLedger({}).rows.map((r) => r.ad_name))];
  writeFileSync(rel(job, job.verify.entityCsv), 'ad_name\n' + ads.join('\n') + '\n', 'utf8');

  const v = await doVerify(job, { asOf: '2026-08-14' });
  const code = printVerify(v);

  const html = renderReport({ job, verify: v, faults, receipts: lastSync.receipts.entries() });
  const htmlPath = join(outDir, 'report.html');
  writeFileSync(htmlPath, html, 'utf8');
  console.log(`  report → ${htmlPath}`);
  console.log(`  receipts → ${lastSync.receipts.path}\n`);
  // Set the code and let the loop drain; calling process.exit() here races the
  // simulator's closing socket and Windows turns that into a libuv assertion.
  process.exitCode = code;
}

// ---------------------------------------------------------------- main

const main = async () => {
  switch (cmd) {
    case 'simulate': {
      const faults = String(flag('faults', '')).split(',').filter(Boolean);
      const port = Number(flag('port', 8787));
      serve(createSimulator({ faults, asOf: String(flag('as-of', '2026-08-14')) }), port);
      console.log(`simulator on http://127.0.0.1:${port}/v1/ads  faults: ${faults.join(',') || 'none'}`);
      console.log(`(Ctrl-C to stop; GET /healthz for status)`);
      break;
    }
    case 'sync': {
      const job = loadJob(argv[1]);
      const r = await doSync(job, {
        approve: !!flag('approve'),
        snapshotLabel: String(flag('snapshot', new Date().toISOString().slice(0, 10))),
        asOf: flag('as-of'),
      });
      console.log(r.written
        ? `wrote ${r.rows} rows (+${r.plan.added} added, ~${r.plan.revised} revised, ${r.plan.retained} retained)`
        : `${C.yellow}dry run${C.off}: would add ${r.plan.added}, revise ${r.plan.revised}, retain ${r.plan.retained}. ${r.reason}`);
      break;
    }
    case 'verify': {
      process.exitCode = printVerify(await doVerify(loadJob(argv[1]), { asOf: flag('as-of') }));
      break;
    }
    case 'sheets:init': {
      const out = await createSpreadsheet({
        credentialsPath: String(flag('credentials', '.secrets/google-service-account.json')),
        title: String(flag('title', 'syncproof — verified report')),
        shareWith: flag('share') === true ? null : flag('share'),
      });
      console.log(`spreadsheet created\n  id     ${out.id}\n  url    ${out.url}\n  owner  ${out.owner}`
        + (out.sharedWith ? `\n  shared ${out.sharedWith} (editor)` : ''));
      console.log(`\nPut the id into your job file as sink.spreadsheetId.`);
      break;
    }
    case 'report': {
      const job = loadJob(argv[1]);
      const v = await doVerify(job, { asOf: flag('as-of') });
      const out = String(flag('out', rel(job, 'out/report.html')));
      writeFileSync(out, renderReport({ job, verify: v, faults: [], receipts: [] }), 'utf8');
      console.log(`report → ${out}`);
      break;
    }
    case 'demo': await doDemo(); break;
    default:
      console.log(readFileSync(new URL('./usage.txt', import.meta.url), 'utf8'));
      process.exit(cmd ? 2 : 0);
  }
};

main().catch((err) => { console.error(`syncproof: ${err.stack || err.message}`); process.exit(1); });
