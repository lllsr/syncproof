import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  keyCoverage, aggregateTolerance, rowLevelDiff, uniqueKeys,
  dateContinuity, historyPreserved, restatementReport, joinIntegrity, runChecks,
} from '../src/verify/checks.js';
import { LocalWorkbook, fromCsv, toCsv } from '../src/sink/workbook.js';
import { readAll, normalise } from '../src/source/api.js';
import { Receipts, gate } from '../src/receipts.js';

const keyColumns = ['date', 'ad_name'];
const row = (date, ad_name, spend, purchases = 1) => ({ date, ad_name, spend, purchases });

const truth = [
  row('2026-07-01', '#1.1', 100),
  row('2026-07-01', '#1.2', 200),
  row('2026-07-02', '#1.1', 150),
];

test('key coverage fails when the sheet is missing a row the export has', () => {
  const r = keyCoverage(truth.slice(0, 2), truth, { keyColumns });
  assert.equal(r.status, 'fail');
  assert.equal(r.evidence.missingCount, 1);
  assert.match(r.headline, /missing from the sheet/);
});

test('key coverage warns, not fails, on rows the sheet has in addition', () => {
  const r = keyCoverage([...truth, row('2026-07-03', '#9.9', 1)], truth, { keyColumns });
  assert.equal(r.status, 'warn');
});

test('aggregate tolerance catches a micros-for-currency unit error', () => {
  const micros = truth.map((t) => ({ ...t, spend: t.spend * 1e6 }));
  const r = aggregateTolerance(micros, truth, { metrics: ['spend'], tolerancePct: 0.5 });
  assert.equal(r.status, 'fail');
  assert.ok(r.evidence.rows[0].pct > 1000);
});

test('aggregate tolerance passes a difference inside the stated tolerance', () => {
  const nudged = truth.map((t, i) => (i === 0 ? { ...t, spend: 100.2 } : t));
  const r = aggregateTolerance(nudged, truth, { metrics: ['spend'], tolerancePct: 0.5 });
  assert.equal(r.status, 'pass');
});

test('row level diff names the offending cell rather than just the total', () => {
  const wrong = truth.map((t, i) => (i === 1 ? { ...t, spend: 999 } : t));
  const r = rowLevelDiff(wrong, truth, { keyColumns, metrics: ['spend'], tolerancePct: 0.5 });
  assert.equal(r.status, 'fail');
  assert.equal(r.evidence.sample[0].key, '2026-07-01|#1.2');
  assert.equal(r.evidence.sample[0].export, 200);
});

test('duplicate primary keys are caught', () => {
  const r = uniqueKeys([...truth, truth[0]], truth, { keyColumns });
  assert.equal(r.status, 'fail');
  assert.equal(r.evidence.sample[0].rows, 2);
});

test('a missing day inside the range is reported as a gap', () => {
  const withGap = [row('2026-07-01', '#1.1', 1), row('2026-07-03', '#1.1', 1)];
  const r = dateContinuity(withGap, withGap, {});
  assert.equal(r.status, 'fail');
  assert.deepEqual(r.evidence.gaps, ['2026-07-02']);
});

test('history preserved fails when a previously present row has gone', () => {
  const r = historyPreserved(truth.slice(1), truth, { priorSnapshot: truth, keyColumns });
  assert.equal(r.status, 'fail');
  assert.equal(r.evidence.lostCount, 1);
});

test('history preserved is advisory when there is no earlier snapshot', () => {
  assert.equal(historyPreserved(truth, truth, { priorSnapshot: [], keyColumns }).status, 'warn');
});

test('restatement separates late conversions from a changed settled day', () => {
  const prior = [row('2026-07-01', '#1.1', 100, 5), row('2026-07-10', '#1.1', 100, 5)];
  const now = [row('2026-07-01', '#1.1', 100, 9), row('2026-07-10', '#1.1', 100, 7)];
  // Judged as at the previous snapshot: 07-01 was settled by then, 07-10 was not.
  const r = restatementReport(now, null, {
    priorSnapshot: prior, priorAsOf: '2026-07-11', keyColumns,
    metrics: ['purchases'], settledAfterDays: 3,
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.evidence.settledSample.length, 1);
  assert.equal(r.evidence.settledSample[0].key, '2026-07-01|#1.1');
  assert.equal(r.evidence.inWindowCount, 1);
});

test('restatement stays quiet when only in-window days moved', () => {
  const prior = [row('2026-07-10', '#1.1', 100, 5)];
  const now = [row('2026-07-10', '#1.1', 100, 7)];
  const r = restatementReport(now, null, {
    priorSnapshot: prior, priorAsOf: '2026-07-11', keyColumns, metrics: ['purchases'], settledAfterDays: 3,
  });
  assert.equal(r.status, 'warn');
});

test('a renamed entity is caught as a broken join', () => {
  const renamed = [{ ...truth[0], ad_name: '#1.1 (v2)' }];
  const r = joinIntegrity(renamed, truth, { joinColumn: 'ad_name', knownKeys: ['#1.1', '#1.2'] });
  assert.equal(r.status, 'fail');
  assert.equal(r.evidence.sample[0].value, '#1.1 (v2)');
});

test('the verdict is driven by failures, not by warnings', () => {
  const clean = runChecks({
    sheet: truth, truth,
    config: { keyColumns, metrics: ['spend'], joinColumn: 'ad_name', knownKeys: ['#1.1', '#1.2'], priorSnapshot: [] },
  });
  assert.equal(clean.verdict, 'MATCHES SOURCE');
  assert.equal(clean.failed, 0);
  assert.ok(clean.results.some((r) => r.status === 'warn'), 'no earlier snapshot should be advisory');
});

// ------------------------------------------------------------------ sink

const wbDir = () => mkdtempSync(join(tmpdir(), 'syncproof-'));

test('upsert is idempotent: writing the same rows twice changes nothing', () => {
  const wb = new LocalWorkbook({ dir: wbDir(), columns: ['date', 'ad_name', 'spend'], keyColumns });
  wb.commit(truth, { snapshotLabel: 'a' });
  const first = wb.readCurrent().length;
  wb.commit(truth, { snapshotLabel: 'b' });
  assert.equal(wb.readCurrent().length, first);
});

test('rows the source stops returning are retained, never deleted', () => {
  const wb = new LocalWorkbook({ dir: wbDir(), columns: ['date', 'ad_name', 'spend'], keyColumns });
  wb.commit(truth, { snapshotLabel: 'a' });
  const plan = wb.plan([truth[0]]);
  assert.equal(plan.retained, 2);
  wb.commit([truth[0]], { snapshotLabel: 'b' });
  assert.equal(wb.readCurrent().length, 3, 'the other two rows must survive');
});

test('a plan reports only the cells that would change', () => {
  const wb = new LocalWorkbook({ dir: wbDir(), columns: ['date', 'ad_name', 'spend'], keyColumns });
  wb.commit(truth, { snapshotLabel: 'a' });
  const plan = wb.plan([{ ...truth[0], spend: 111 }]);
  assert.equal(plan.revised, 1);
  assert.deepEqual(plan.revisions[0].changes, [{ column: 'spend', from: '100', to: 111 }]);
});

test('csv round-trips values containing commas and quotes', () => {
  const odd = [{ a: 'x,y', b: 'he said "hi"' }];
  assert.deepEqual(fromCsv(toCsv(odd, ['a', 'b'])), [{ a: 'x,y', b: 'he said "hi"' }]);
});

// ------------------------------------------------------------------ source

function fakeFetch(pages, { failEvery = 0 } = {}) {
  let calls = 0;
  return async (url) => {
    calls++;
    if (failEvery && calls % failEvery === 0) {
      return { status: 429, ok: false, headers: { get: () => '0' }, json: async () => ({}) };
    }
    const cursor = Number(new URL(url).searchParams.get('cursor') || 0);
    const body = pages[cursor];
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => body };
  };
}

test('pagination collects every page', async () => {
  const pages = {
    0: { data: [{ id: 1 }, { id: 2 }], next_cursor: '2' },
    2: { data: [{ id: 3 }], next_cursor: null, total_hint: 3 },
  };
  const out = await readAll({ url: 'http://x/v1', pageSize: 2, fetchImpl: fakeFetch(pages) });
  assert.equal(out.rows.length, 3);
  assert.equal(out.pages, 2);
});

test('a 429 is retried rather than treated as the end of the data', async () => {
  const pages = {
    0: { data: [{ id: 1 }], next_cursor: '1' },
    1: { data: [{ id: 2 }], next_cursor: null, total_hint: 2 },
  };
  const out = await readAll({ url: 'http://x/v1', pageSize: 1, fetchImpl: fakeFetch(pages, { failEvery: 2 }) });
  assert.equal(out.rows.length, 2);
  assert.ok(out.retriesUsed >= 1);
});

test('a row count that disagrees with the platform hint is written down', async () => {
  const dir = wbDir();
  const receipts = new Receipts(join(dir, 'r.jsonl'));
  const pages = { 0: { data: [{ id: 1 }], next_cursor: null, total_hint: 5 } };
  await readAll({ url: 'http://x/v1', pageSize: 1, receipts, fetchImpl: fakeFetch(pages) });
  assert.ok(receipts.entries().some((e) => e.action === 'count_mismatch_vs_hint'));
});

test('an unreachable source explains itself', async () => {
  await assert.rejects(
    () => readAll({ url: 'http://x/v1', fetchImpl: async () => { const e = new Error('boom'); e.cause = { code: 'ECONNREFUSED' }; throw e; } }),
    /cannot reach .*ECONNREFUSED/,
  );
});

test('declared transforms are applied, undeclared fields are left alone', () => {
  const out = normalise([{ spend: 1e6, clicks: 3 }], { spend: { divide: 1e6, round: 2 } });
  assert.deepEqual(out[0], { spend: 1, clicks: 3 });
});

// ------------------------------------------------------------------ gate

test('nothing is written without approval, and both outcomes are logged', () => {
  const dir = wbDir();
  const receipts = new Receipts(join(dir, 'r.jsonl'));
  assert.equal(gate({ approved: false, receipts, action: 'upsert', plan: { added: 3 } }).proceed, false);
  assert.equal(gate({ approved: true, receipts, action: 'upsert', plan: { added: 3 } }).proceed, true);
  const actions = receipts.entries().map((e) => e.action);
  assert.ok(actions.includes('write_withheld_dry_run'));
  assert.ok(actions.includes('write_approved'));
});

test('receipts are append-only', () => {
  const dir = wbDir();
  const p = join(dir, 'r.jsonl');
  const a = new Receipts(p, { runId: 'aaa' });
  a.note('x');
  const b = new Receipts(p, { runId: 'bbb' });
  b.note('y');
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  assert.equal(lines.length, 4, 'two run_started plus two notes');
  assert.equal(a.entries('aaa').length, 2);
});

// ------------------------------------------------------------------ sheets shapes
// The Sheets sink itself needs the network; its value marshalling does not, and
// that is where the bugs were (a range mismatch and blank trailing rows).

import { RANGE, toValues, fromValues } from '../src/sink/sheets.js';
import { planMerge, mergeRows } from '../src/sink/merge.js';

test('the A1 range quotes tab names containing apostrophes', () => {
  assert.equal(RANGE("Bob's tab"), "'Bob''s tab'!A1:ZZZ200000");
});

test('values round-trip through the sheet representation', () => {
  const cols = ['date', 'ad_name', 'spend'];
  const values = toValues(truth, cols);
  assert.deepEqual(values[0], cols, 'first row is the header');
  const back = fromValues(values, cols);
  assert.equal(back.length, 3);
  assert.equal(back[0].ad_name, '#1.1');
});

test('trailing blank rows in a sheet are not read as data', () => {
  const values = [['date', 'ad_name'], ['2026-07-01', '#1.1'], ['', ''], ['', '']];
  assert.equal(fromValues(values, ['date', 'ad_name']).length, 1);
});

test('both sinks share one merge implementation', () => {
  // A guard against the two destinations drifting apart: same inputs, same plan.
  const cfg = { columns: ['date', 'ad_name', 'spend'], keyColumns };
  const plan = planMerge(truth, [{ ...truth[0], spend: 5 }], cfg);
  assert.equal(plan.revised, 1);
  assert.equal(plan.retained, 2);
  const rows = mergeRows(truth, [{ ...truth[0], spend: 5 }], { keyColumns });
  assert.equal(rows.length, 3, 'a shorter incoming set must not shrink the sheet');
});

test('a nested cursor and data path works, e.g. HubSpot paging.next.after', async () => {
  // HubSpot: { results: [...], paging: { next: { after: "..." } } }
  const pages = {
    0: { results: [{ id: 'a' }], paging: { next: { after: '1' } } },
    1: { results: [{ id: 'b' }], paging: {} },
  };
  const fetchImpl = async (url) => {
    const after = new URL(url).searchParams.get('after') || '0';
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => pages[Number(after)] };
  };
  const out = await readAll({
    url: 'http://x/crm/v3/objects/deals',
    dataField: 'results',
    cursorField: 'paging.next.after',
    cursorParam: 'after',
    pageSizeParam: 'limit',
    fetchImpl,
  });
  assert.deepEqual(out.rows.map((r) => r.id), ['a', 'b']);
  assert.equal(out.pages, 2);
});

test('the page-size parameter name is configurable', async () => {
  let seen = null;
  const fetchImpl = async (url) => {
    seen = new URL(url).searchParams.get('per_page');
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ data: [] }) };
  };
  await readAll({ url: 'http://x/v1', pageSize: 77, pageSizeParam: 'per_page', fetchImpl });
  assert.equal(seen, '77');
});

test('restatement honours the configured date column, not a hardcoded one', () => {
  // A CRM row dates itself with closedate. Reading row.date would give NaN and
  // silently classify a real edit as normal in-window movement.
  const prior = [{ id: '1', closedate: '2026-07-01', amount: 100 }];
  const now = [{ id: '1', closedate: '2026-07-01', amount: 160 }];
  const cfg = { priorSnapshot: prior, priorAsOf: '2026-07-20', keyColumns: ['id'], metrics: ['amount'], settledAfterDays: 3 };
  assert.equal(restatementReport(now, null, { ...cfg, dateColumn: 'closedate' }).status, 'fail');
  // Without the right column the row cannot be dated — still reported, never silent.
  assert.equal(restatementReport(now, null, cfg).status, 'fail');
});

test('an undated record that changes is reported rather than ignored', () => {
  const prior = [{ id: '1', amount: 100 }];
  const now = [{ id: '1', amount: 900 }];
  const r = restatementReport(now, null, {
    priorSnapshot: prior, priorAsOf: '2026-07-20', keyColumns: ['id'], metrics: ['amount'], settledAfterDays: 3,
  });
  assert.equal(r.status, 'fail');
});
