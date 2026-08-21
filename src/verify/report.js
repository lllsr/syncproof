// The report a client reads. Three things, in this order:
//   1. the verdict, because that is the only line some people will read
//   2. what disagrees, with concrete rows
//   3. how it was checked, so the verdict can be argued with

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : esc(v));

function evidenceTable(r) {
  const e = r.evidence || {};
  if (r.id === 'aggregate_tolerance' && e.rows) {
    return `<table><thead><tr><th>metric</th><th>sheet</th><th>export</th><th>difference</th><th>%</th></tr></thead><tbody>${
      e.rows.map((x) => `<tr class="${x.withinTolerance ? '' : 'bad'}"><td>${esc(x.metric)}</td><td>${n(x.sheet)}</td><td>${n(x.export)}</td><td>${n(x.diff)}</td><td>${n(x.pct)}%</td></tr>`).join('')
    }</tbody></table>`;
  }
  if (r.id === 'row_level_diff' && e.sample?.length) {
    const pattern = e.patterns?.length
      ? `<table><thead><tr><th>metric</th><th>cells affected</th><th>sheet ÷ export</th></tr></thead><tbody>${
        e.patterns.map((p) => `<tr class="bad"><td>${esc(p.metric)}</td><td>${n(p.count)}</td><td>${p.medianRatio == null ? '—' : `${n(p.medianRatio)}×${p.uniform ? ' <em>(constant)</em>' : ' (median)'}`}</td></tr>`).join('')
      }</tbody></table>` : '';
    return `${pattern}<p class="more">Examples:</p><table><thead><tr><th>row</th><th>metric</th><th>sheet</th><th>export</th></tr></thead><tbody>${
      e.sample.map((x) => `<tr class="bad"><td>${esc(x.key)}</td><td>${esc(x.metric)}</td><td>${n(x.sheet)}</td><td>${n(x.export)}</td></tr>`).join('')
    }</tbody></table>${e.count > e.sample.length ? `<p class="more">and ${e.count - e.sample.length} more, all following the pattern above</p>` : ''}`;
  }
  if (r.id === 'restatement' && e.settledSample?.length) {
    return `<table><thead><tr><th>row</th><th>metric</th><th>was</th><th>now</th><th>day age</th></tr></thead><tbody>${
      e.settledSample.map((x) => `<tr class="bad"><td>${esc(x.key)}</td><td>${esc(x.metric)}</td><td>${n(x.was)}</td><td>${n(x.now)}</td><td>${n(x.ageDays)}d</td></tr>`).join('')
    }</tbody></table>`;
  }
  if (r.id === 'join_integrity' && e.sample?.length) {
    return `<table><thead><tr><th>unmatched value</th><th>first seen</th></tr></thead><tbody>${
      e.sample.map((x) => `<tr class="bad"><td>${esc(x.value)}</td><td>${esc(x.date)}</td></tr>`).join('')
    }</tbody></table>`;
  }
  const lists = ['missing', 'extra', 'gaps', 'missingVsTruth', 'sample'];
  for (const k of lists) {
    if (Array.isArray(e[k]) && e[k].length) {
      return `<p class="keys">${e[k].map((x) => `<code>${esc(typeof x === 'object' ? (x.key || JSON.stringify(x)) : x)}</code>`).join(' ')}</p>`;
    }
  }
  return '';
}

export function renderReport({ job, verify, faults = [], receipts = [] }) {
  const ok = verify.verdict === 'MATCHES SOURCE';
  const failed = verify.results.filter((r) => r.status === 'fail');
  const warned = verify.results.filter((r) => r.status === 'warn');
  const passed = verify.results.filter((r) => r.status === 'pass');
  const reads = receipts.filter((r) => r.action === 'source_read');
  const throttles = receipts.filter((r) => r.action === 'throttled');
  const writes = receipts.filter((r) => r.action === 'write_committed');

  const card = (r) => `
    <section class="check ${r.status}">
      <h3><span class="dot"></span>${esc(r.id.replace(/_/g, ' '))}</h3>
      <p class="headline">${esc(r.headline)}</p>
      ${r.detail ? `<p class="why">${esc(r.detail)}</p>` : ''}
      ${evidenceTable(r)}
    </section>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(job.name)} — data verification</title>
<style>
  :root { --ink:#111; --mute:#666; --line:#e3e3e3; --bad:#b3261e; --good:#1b6b3a; --warn:#8a6100; }
  * { box-sizing: border-box; }
  body { font: 15px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); margin: 0; }
  main { max-width: 820px; margin: 0 auto; padding: 48px 32px 80px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--mute); margin: 0 0 32px; }
  .verdict { border: 2px solid; border-radius: 10px; padding: 20px 24px; margin: 0 0 12px; }
  .verdict.ok { border-color: var(--good); }
  .verdict.no { border-color: var(--bad); }
  .verdict h2 { margin: 0 0 6px; font-size: 21px; }
  .verdict.ok h2 { color: var(--good); } .verdict.no h2 { color: var(--bad); }
  .verdict p { margin: 0; color: var(--mute); }
  .tally { display: flex; gap: 22px; margin: 18px 0 34px; color: var(--mute); font-size: 14px; }
  .tally b { color: var(--ink); }
  h2.rule { font-size: 13px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--mute);
            border-bottom: 1px solid var(--line); padding-bottom: 8px; margin: 38px 0 18px; }
  .check { border-left: 3px solid var(--line); padding: 2px 0 2px 16px; margin: 0 0 26px; }
  .check.fail { border-left-color: var(--bad); } .check.pass { border-left-color: var(--good); }
  .check.warn { border-left-color: var(--warn); }
  .check h3 { font-size: 15px; margin: 0 0 4px; text-transform: capitalize; }
  .headline { margin: 0 0 6px; }
  .check.fail .headline { color: var(--bad); font-weight: 600; }
  .why { color: var(--mute); font-size: 13.5px; margin: 6px 0 10px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 10px 0 4px; }
  th { text-align: left; font-weight: 600; color: var(--mute); border-bottom: 1px solid var(--line); padding: 5px 8px 5px 0; }
  td { padding: 4px 8px 4px 0; border-bottom: 1px solid #f4f4f4; font-variant-numeric: tabular-nums; }
  tr.bad td { color: var(--bad); }
  .keys code { background: #f5f5f5; padding: 1px 5px; border-radius: 3px; font-size: 12px; margin-right: 3px; }
  .more { color: var(--mute); font-size: 12.5px; margin: 4px 0 0; }
  footer { color: var(--mute); font-size: 12.5px; border-top: 1px solid var(--line); margin-top: 44px; padding-top: 14px; }
  .method li { margin-bottom: 7px; }
</style></head>
<body><main>
  <h1>${esc(job.name)}</h1>
  <p class="sub">Data verification · sheet compared against the platform export · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</p>

  <div class="verdict ${ok ? 'ok' : 'no'}">
    <h2>${ok ? 'The sheet matches the source' : `${failed.length} check${failed.length === 1 ? '' : 's'} failed — do not make decisions from this sheet yet`}</h2>
    <p>${ok
      ? 'Every metric total, every row and every date in the export is accounted for in the sheet.'
      : esc(failed.map((f) => f.headline).join(' · '))}</p>
  </div>

  <div class="tally">
    <span><b>${verify.counts.sheet}</b> rows in sheet</span>
    <span><b>${verify.counts.truth}</b> rows in export</span>
    <span><b>${passed.length}</b> passed</span>
    <span><b>${failed.length}</b> failed</span>
    <span><b>${warned.length}</b> advisory</span>
  </div>

  ${failed.length ? `<h2 class="rule">What disagrees</h2>${failed.map(card).join('')}` : ''}
  ${warned.length ? `<h2 class="rule">Worth knowing</h2>${warned.map(card).join('')}` : ''}
  ${passed.length ? `<h2 class="rule">Checks that passed</h2>${passed.map(card).join('')}` : ''}

  <h2 class="rule">How this was checked</h2>
  <ol class="method">
    <li>The sheet is compared against <code>${esc(job.truth.csv)}</code> — the export taken from the platform itself, which is the artefact a spot-check would use.</li>
    <li>Totals are compared with a stated tolerance of <b>${esc(String(job.verify.tolerancePct ?? 0.5))}%</b>; anything outside it is reported rather than rounded away.</li>
    <li>Rows the source stopped returning are <b>retained</b>, not deleted, and every run leaves an immutable snapshot.</li>
    <li>Writes are withheld unless explicitly approved, and each run appends receipts to <code>${esc(job.receipts || 'out/receipts.jsonl')}</code>.</li>
    ${reads.length ? `<li>This run read <b>${reads.map((r) => r.rows).join(' + ')}</b> row(s) across <b>${reads.map((r) => r.pages).join(' + ')}</b> page(s)${throttles.length ? `, absorbing <b>${throttles.length}</b> throttling response(s)` : ''}${writes.length ? `, and committed <b>${writes[writes.length - 1].rows}</b> row(s)` : ''}.</li>` : ''}
    ${faults.length ? `<li><b>Demonstration run.</b> The source was the bundled simulator with these faults switched on: ${faults.map((f) => `<code>${esc(f)}</code>`).join(', ')}. The data is synthetic; the checks are the same ones used against a live platform.</li>` : ''}
  </ol>

  <footer>
    Generated by syncproof. The sheet is never the evidence — the export is. Anything
    reported here can be recomputed from the receipts and the snapshot in the same run.
  </footer>
</main></body></html>`;
}
