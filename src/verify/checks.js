// The checks. Each one exists because a specific, common failure produces a
// spreadsheet that looks perfectly fine.
//
// A check reports { id, status: pass|fail|warn, headline, detail, evidence }.
// Evidence is always concrete rows or numbers — a check that only says "mismatch"
// makes the client's next question unanswerable.

const num = (v) => (v === '' || v == null ? 0 : Number(v));
const sum = (rows, col) => rows.reduce((a, r) => a + num(r[col]), 0);

function keyOf(row, keyColumns) { return keyColumns.map((c) => row[c]).join('|'); }

/** Every key in the source of truth is present in the sheet, and vice versa. */
export function keyCoverage(sheet, truth, { keyColumns }) {
  const s = new Set(sheet.map((r) => keyOf(r, keyColumns)));
  const t = new Set(truth.map((r) => keyOf(r, keyColumns)));
  const missing = [...t].filter((k) => !s.has(k));
  const extra = [...s].filter((k) => !t.has(k));
  const status = missing.length ? 'fail' : extra.length ? 'warn' : 'pass';
  return {
    id: 'key_coverage',
    status,
    headline: missing.length
      ? `${missing.length} row(s) present in the export are missing from the sheet`
      : extra.length
        ? `${extra.length} row(s) in the sheet are not in the export`
        : 'every export row is present in the sheet',
    detail: 'A silently dropped row is the failure mode a dashboard cannot show you: '
          + 'totals still look plausible because nothing is obviously broken.',
    evidence: { missingCount: missing.length, extraCount: extra.length, missing: missing.slice(0, 12), extra: extra.slice(0, 12) },
  };
}

/** Totals per metric must match within a stated tolerance. */
export function aggregateTolerance(sheet, truth, { metrics, tolerancePct = 0.5 }) {
  const rows = [];
  for (const m of metrics) {
    const a = sum(sheet, m), b = sum(truth, m);
    const diff = a - b;
    const pct = b === 0 ? (a === 0 ? 0 : 100) : (diff / b) * 100;
    rows.push({ metric: m, sheet: a, export: b, diff, pct: Number(pct.toFixed(4)), withinTolerance: Math.abs(pct) <= tolerancePct });
  }
  const bad = rows.filter((r) => !r.withinTolerance);
  return {
    id: 'aggregate_tolerance',
    status: bad.length ? 'fail' : 'pass',
    headline: bad.length
      ? `${bad.map((b) => b.metric).join(', ')} differ from the export by more than ${tolerancePct}%`
      : `all ${metrics.length} metric totals match within ${tolerancePct}%`,
    detail: 'This is the spot-check a client performs on day one. A unit mismatch '
          + '(micros versus currency) shows up here as an enormous, unmissable ratio.',
    evidence: { tolerancePct, rows },
  };
}

/** Per-row comparison, so a mismatch can be pointed at rather than described. */
export function rowLevelDiff(sheet, truth, { keyColumns, metrics, tolerancePct = 0.5 }) {
  const t = new Map(truth.map((r) => [keyOf(r, keyColumns), r]));
  const offenders = [];
  for (const row of sheet) {
    const other = t.get(keyOf(row, keyColumns));
    if (!other) continue;
    for (const m of metrics) {
      const a = num(row[m]), b = num(other[m]);
      if (a === b) continue;
      const pct = b === 0 ? 100 : Math.abs((a - b) / b) * 100;
      if (pct > tolerancePct) offenders.push({ key: keyOf(row, keyColumns), metric: m, sheet: a, export: b, pct: Number(pct.toFixed(2)) });
    }
  }
  // A list of 400 near-identical rows tells a client nothing. The shape of the
  // disagreement is the finding; the rows are only there to prove it.
  const byMetric = {};
  for (const o of offenders) {
    const b = (byMetric[o.metric] ||= { count: 0, ratios: [] });
    b.count++;
    if (o.export !== 0) b.ratios.push(o.sheet / o.export);
  }
  const patterns = Object.entries(byMetric).map(([metric, b]) => {
    const sorted = b.ratios.slice().sort((x, y) => x - y);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    const spread = sorted.length ? sorted[sorted.length - 1] - sorted[0] : 0;
    // A constant ratio across every affected cell is a conversion, not bad data.
    const uniform = median != null && Math.abs(spread) < Math.abs(median) * 0.001;
    return { metric, count: b.count, medianRatio: median == null ? null : Number(median.toPrecision(6)), uniform };
  }).sort((a, b) => b.count - a.count);

  const uniformOne = patterns.find((p) => p.uniform && p.medianRatio != null && Math.abs(p.medianRatio - 1) > 1e-9);
  return {
    id: 'row_level_diff',
    status: offenders.length ? 'fail' : 'pass',
    headline: !offenders.length
      ? 'no cell disagrees with the export'
      : uniformOne
        ? `${offenders.length} cell(s) disagree — every one in "${uniformOne.metric}", each exactly ${uniformOne.medianRatio}× the export`
        : `${offenders.length} cell(s) disagree with the export, across ${patterns.length} metric(s)`,
    detail: uniformOne
      ? 'A constant ratio across every affected cell is a missing unit conversion, not '
      + 'unreliable data — one line in the job file fixes all of them.'
      : 'Row-level evidence is what makes a disagreement actionable: it separates '
      + '"the connector is wrong" from "one day was restated".',
    evidence: { count: offenders.length, patterns, sample: offenders.slice(0, 8), stored: offenders.slice(0, 200) },
  };
}

/** No duplicate primary keys — the classic result of a retried, non-idempotent append. */
export function uniqueKeys(sheet, _truth, { keyColumns }) {
  const counts = new Map();
  for (const r of sheet) {
    const k = keyOf(r, keyColumns);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const dupes = [...counts.entries()].filter(([, n]) => n > 1);
  return {
    id: 'unique_keys',
    status: dupes.length ? 'fail' : 'pass',
    headline: dupes.length ? `${dupes.length} duplicated key(s) in the sheet` : 'primary key is unique across the sheet',
    detail: 'Duplicates double-count spend. They usually arrive when a page is retried '
          + 'after a timeout and the write path appends instead of upserting.',
    evidence: { sample: dupes.slice(0, 15).map(([k, n]) => ({ key: k, rows: n })) },
  };
}

/** The date range is continuous — a missing day is invisible in a monthly total. */
export function dateContinuity(sheet, truth, { dateColumn = 'date' }) {
  const dates = [...new Set(sheet.map((r) => r[dateColumn]))].sort();
  const truthDates = [...new Set(truth.map((r) => r[dateColumn]))].sort();
  if (!dates.length) {
    return { id: 'date_continuity', status: 'fail', headline: 'the sheet has no dated rows', detail: '', evidence: {} };
  }
  const gaps = [];
  const start = new Date(dates[0] + 'T00:00:00Z').getTime();
  const end = new Date(dates[dates.length - 1] + 'T00:00:00Z').getTime();
  const present = new Set(dates);
  for (let t = start; t <= end; t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (!present.has(d)) gaps.push(d);
  }
  const missingVsTruth = truthDates.filter((d) => !present.has(d));
  const status = gaps.length || missingVsTruth.length ? 'fail' : 'pass';
  return {
    id: 'date_continuity',
    status,
    headline: status === 'pass'
      ? `${dates.length} consecutive days present, ${dates[0]} to ${dates[dates.length - 1]}`
      : `${gaps.length} internal gap(s), ${missingVsTruth.length} day(s) in the export absent from the sheet`,
    detail: 'A timezone offset on the reporting day is the usual cause: rows land on '
          + 'the neighbouring date and one boundary day ends up short or empty.',
    evidence: { first: dates[0], last: dates[dates.length - 1], gaps: gaps.slice(0, 15), missingVsTruth: missingVsTruth.slice(0, 15) },
  };
}

/** History is preserved: an earlier snapshot's rows still exist today. */
export function historyPreserved(sheet, _truth, { priorSnapshot, keyColumns }) {
  if (!priorSnapshot?.length) {
    return { id: 'history_preserved', status: 'warn', headline: 'no earlier snapshot to compare against yet', detail: 'Run twice to enable this check.', evidence: {} };
  }
  const now = new Set(sheet.map((r) => keyOf(r, keyColumns)));
  const lost = priorSnapshot.map((r) => keyOf(r, keyColumns)).filter((k) => !now.has(k));
  return {
    id: 'history_preserved',
    status: lost.length ? 'fail' : 'pass',
    headline: lost.length ? `${lost.length} row(s) that existed in the previous snapshot are gone` : 'no row present in the previous snapshot has been lost',
    detail: 'Rolling-window syncs delete the past to stay small. If decisions were made '
          + 'on last month\'s numbers, last month\'s numbers have to remain reproducible.',
    evidence: { lostCount: lost.length, sample: lost.slice(0, 12) },
  };
}

/**
 * Restatement is surfaced rather than hidden: values that changed for settled days
 * are reported, so a human decides whether that is attribution or a bug.
 */
export function restatementReport(sheet, _truth, { priorSnapshot, priorAsOf, keyColumns, metrics, settledAfterDays = 3, asOf }) {
  if (!priorSnapshot?.length) {
    return { id: 'restatement', status: 'warn', headline: 'no earlier snapshot to compare against yet', detail: '', evidence: {} };
  }
  const prev = new Map(priorSnapshot.map((r) => [keyOf(r, keyColumns), r]));
  // Age is measured at the moment of the *previous* snapshot. A day that was still
  // inside the attribution window then is allowed to move; a day that was already
  // settled then is not. Measuring against today would flag every normal late
  // conversion, and a check that cries wolf gets switched off.
  const refMs = new Date((priorAsOf || asOf || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z').getTime();
  const settled = [], expected = [];
  for (const row of sheet) {
    const before = prev.get(keyOf(row, keyColumns));
    if (!before) continue;
    const ageDays = (refMs - new Date(row.date + 'T00:00:00Z').getTime()) / 86400000;
    for (const m of metrics) {
      if (num(before[m]) === num(row[m])) continue;
      const entry = { key: keyOf(row, keyColumns), metric: m, was: num(before[m]), now: num(row[m]), ageDays };
      (ageDays >= settledAfterDays ? settled : expected).push(entry);
    }
  }
  return {
    id: 'restatement',
    status: settled.length ? 'fail' : expected.length ? 'warn' : 'pass',
    headline: settled.length
      ? `${settled.length} value(s) changed on days already past the ${settledAfterDays}-day attribution window`
      : expected.length
        ? `${expected.length} value(s) revised inside the attribution window (expected)`
        : 'no values were revised since the last run',
    detail: 'Late conversions inside the window are normal and are reported as such. '
          + 'A change to a settled day is not normal, and is the signal that something '
          + 'upstream changed definition.',
    evidence: { settledSample: settled.slice(0, 20), inWindowCount: expected.length },
  };
}

/** Join integrity: every row can be attributed to a known entity. */
export function joinIntegrity(sheet, _truth, { joinColumn, derive, knownKeys }) {
  if (!knownKeys?.length) {
    return { id: 'join_integrity', status: 'warn', headline: 'no entity list supplied, join not checked', detail: '', evidence: {} };
  }
  const known = new Set(knownKeys);
  const orphans = [];
  for (const row of sheet) {
    const derived = derive ? derive(row[joinColumn]) : row[joinColumn];
    if (!known.has(derived)) orphans.push({ value: row[joinColumn], derived, date: row.date });
  }
  const uniqueOrphans = [...new Map(orphans.map((o) => [o.value, o])).values()];
  return {
    id: 'join_integrity',
    status: uniqueOrphans.length ? 'fail' : 'pass',
    headline: uniqueOrphans.length
      ? `${uniqueOrphans.length} value(s) in "${joinColumn}" do not match any known entity`
      : `every "${joinColumn}" value resolves to a known entity`,
    detail: 'Naming conventions are load-bearing when they are the join key. Renaming an '
          + 'ad in the platform silently detaches its performance from its plan.',
    evidence: { sample: uniqueOrphans.slice(0, 15) },
  };
}

export const ALL_CHECKS = {
  key_coverage: keyCoverage,
  aggregate_tolerance: aggregateTolerance,
  row_level_diff: rowLevelDiff,
  unique_keys: uniqueKeys,
  date_continuity: dateContinuity,
  history_preserved: historyPreserved,
  restatement: restatementReport,
  join_integrity: joinIntegrity,
};

export function runChecks({ sheet, truth, config, enabled }) {
  const ids = enabled?.length ? enabled : Object.keys(ALL_CHECKS);
  const results = ids.map((id) => {
    const fn = ALL_CHECKS[id];
    if (!fn) return { id, status: 'warn', headline: `unknown check "${id}"`, detail: '', evidence: {} };
    try {
      return fn(sheet, truth, config);
    } catch (err) {
      return { id, status: 'fail', headline: `check threw: ${err.message}`, detail: '', evidence: {} };
    }
  });
  const failed = results.filter((r) => r.status === 'fail');
  return { results, failed: failed.length, verdict: failed.length ? 'NOT TRUSTWORTHY' : 'MATCHES SOURCE' };
}
