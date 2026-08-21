#!/usr/bin/env node
// syncproof — sync a reporting API into a sheet, then prove the sheet matches it.
// See usage.txt, or run with no arguments.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { createSimulator, serve as serveSim, FAULTS } from './sim/server.js';
import { buildLedger, applyRestatement, exportRows, toCsv as ledgerCsv, EXPORT_COLUMNS } from './sim/ledger.js';
import { createSpreadsheet } from './sink/sheets.js';
import { loadJob, rel, doSync, doVerify, summarise } from './run.js';
import { renderReport } from './verify/report.js';
import { serveApi } from './serve.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const C = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', off: '\x1b[0m' };
const mark = (s) => (s === 'pass' ? `${C.green}✓${C.off}` : s === 'fail' ? `${C.red}✗${C.off}` : `${C.yellow}!${C.off}`);

function printVerify(v) {
  console.log(`\n${C.bold}verdict: ${v.verdict === 'MATCHES SOURCE' ? C.green : C.red}${v.verdict}${C.off}`
    + `  ${C.dim}(sheet ${v.counts.sheet} rows · export ${v.counts.truth} rows · ${v.counts.snapshots} snapshot(s))${C.off}`);
  console.log(`${C.dim}  destination: ${v.destination}${C.off}\n`);
  for (const r of v.results) console.log(`  ${mark(r.status)} ${r.id.padEnd(20)} ${r.headline}`);
  console.log('');
  return v.failed ? 1 : 0;
}

// ---------------------------------------------------------------- demo

async function doDemo() {
  const clean = !!flag('clean');
  const faults = clean ? [] : String(flag('faults', 'micros,cursor_drift,rate_limit,rename')).split(',').filter(Boolean);
  const port = Number(flag('port', 8811));
  const jobPath = String(flag('job', join(dirname(new URL(import.meta.url).pathname.slice(1)), '..', 'jobs', 'ads-to-sheet.json')));
  const job = loadJob(jobPath);
  mkdirSync(rel('out'), { recursive: true });

  console.log(`${C.bold}syncproof demo${C.off}  ${C.dim}faults: ${faults.length ? faults.join(', ') : 'none'}${C.off}`);
  for (const f of faults) console.log(`  ${C.dim}· ${f}: ${FAULTS[f] || 'unknown fault'}${C.off}`);

  // Two runs, a day apart: the second is what makes history and restatement checkable.
  const runs = ['2026-08-13', '2026-08-14'];
  const sim = createSimulator({ faults, asOf: runs[0] });
  const server = serveSim(sim, port);
  let lastSync;
  try {
    for (const asOf of runs) {
      sim.setAsOf(asOf);
      // The client's own export, taken at the same moment — this is the source of truth.
      writeFileSync(rel(job.truth.csv), ledgerCsv(exportRows(applyRestatement(buildLedger({}).rows, asOf)), EXPORT_COLUMNS), 'utf8');

      const jobRun = structuredClone({ ...job, __path: undefined, __dir: undefined });
      jobRun.source.url = `http://127.0.0.1:${port}/v1/ads`;
      if (flag('naive')) jobRun.sink.mode = 'append';        // emulate an "add row" automation
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
  writeFileSync(rel(job.verify.entityCsv), 'ad_name\n' + ads.join('\n') + '\n', 'utf8');

  const v = await doVerify(job, { asOf: '2026-08-14' });
  const code = printVerify(v);

  const htmlPath = rel('out/report.html');
  writeFileSync(htmlPath, renderReport({ job, verify: v, faults, receipts: lastSync.receipts.entries() }), 'utf8');
  console.log(`  report → ${htmlPath}`);
  console.log(`  receipts → ${lastSync.receipts.path}\n`);
  process.exitCode = code;
}

// ---------------------------------------------------------------- main

const main = async () => {
  switch (cmd) {
    case 'simulate': {
      const faults = String(flag('faults', '')).split(',').filter(Boolean);
      const port = Number(flag('port', 8787));
      serveSim(createSimulator({ faults, asOf: String(flag('as-of', '2026-08-14')) }), port);
      console.log(`simulator on http://127.0.0.1:${port}/v1/ads  faults: ${faults.join(',') || 'none'}`);
      console.log('(Ctrl-C to stop; GET /healthz for status)');
      break;
    }

    case 'serve': {
      const port = Number(flag('port', 8790));
      const token = flag('token') === true ? null : flag('token');
      const defaultJob = flag('job') === true ? null : flag('job');
      serveApi({ port, token, defaultJob });
      console.log(`syncproof api on http://127.0.0.1:${port}`);
      console.log('  POST /verify  → 200 when the sheet matches the export, 422 when it does not');
      console.log('  POST /sync    → { "approve": true } to write');
      console.log(`  auth: ${token ? 'Bearer token required' : 'none (bind to localhost only)'}`);
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
        ? `wrote ${r.rows} rows to ${r.url} (+${r.plan.added} added, ~${r.plan.revised} revised, ${r.plan.retained} retained)`
        : `${C.yellow}dry run${C.off}: would add ${r.plan.added}, revise ${r.plan.revised}, retain ${r.plan.retained}. ${r.reason}`);
      break;
    }

    case 'verify': {
      const job = loadJob(argv[1]);
      const v = await doVerify(job, { asOf: flag('as-of') });
      if (flag('json')) {
        console.log(JSON.stringify(summarise(job, v), null, 2));
        process.exitCode = v.failed ? 1 : 0;
      } else {
        process.exitCode = printVerify(v);
      }
      break;
    }

    case 'report': {
      const job = loadJob(argv[1]);
      const v = await doVerify(job, { asOf: flag('as-of') });
      const out = String(flag('out', rel('out/report.html')));
      writeFileSync(out, renderReport({ job, verify: v, faults: [], receipts: [] }), 'utf8');
      console.log(`report → ${out}`);
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
      break;
    }

    case 'demo': await doDemo(); break;

    default:
      console.log(readFileSync(new URL('./usage.txt', import.meta.url), 'utf8'));
      process.exitCode = cmd ? 2 : 0;
  }
};

main().catch((err) => { console.error(`syncproof: ${err.stack || err.message}`); process.exit(1); });
