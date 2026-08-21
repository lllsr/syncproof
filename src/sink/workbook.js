// A local stand-in for the destination spreadsheet. Same contract as the Google
// Sheets sink, and the same merge rules — both delegate to merge.js so they cannot
// diverge:
//
//   - upsert by primary key, never truncate
//   - one immutable snapshot per run, so yesterday's numbers can still be produced
//   - a row is only ever revised, and the revision is visible
//
// "Historical data can't disappear. No rolling 30-day windows that wipe older rows."

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { planMerge, mergeRows, keyOf, KEY_SEP } from './merge.js';

export { KEY_SEP };

const csvEscape = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));

export function toCsv(rows, columns) {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => csvEscape(r[c])).join(','))].join('\n') + '\n';
}

export function fromCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return [];
  const cols = splitCsvLine(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = splitCsvLine(l);
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}

function splitCsvLine(line) {
  const out = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export class LocalWorkbook {
  constructor({ dir, columns, keyColumns, mode = 'upsert', keepDays = null, dateColumn = 'date' }) {
    this.dir = dir;
    this.columns = columns;
    this.keyColumns = keyColumns;
    this.mode = mode;
    this.keepDays = keepDays;      // a rolling window, i.e. the thing clients ask us not to do
    this.dateColumn = dateColumn;
    mkdirSync(join(dir, 'snapshots'), { recursive: true });
  }

  get currentPath() { return join(this.dir, 'current.csv'); }
  get url() { return this.currentPath; }

  key(row) { return keyOf(row, this.keyColumns); }

  readCurrent() {
    if (!existsSync(this.currentPath)) return [];
    return fromCsv(readFileSync(this.currentPath, 'utf8'));
  }

  plan(incoming) {
    return planMerge(this.readCurrent(), incoming, { columns: this.columns, keyColumns: this.keyColumns });
  }

  commit(incoming, { snapshotLabel } = {}) {
    const rows = mergeRows(this.readCurrent(), incoming, this);
    const csv = toCsv(rows, this.columns);
    writeFileSync(this.currentPath, csv, 'utf8');
    if (snapshotLabel) writeFileSync(join(this.dir, 'snapshots', `${snapshotLabel}.csv`), csv, 'utf8');
    return { rows: rows.length, url: this.currentPath };
  }

  snapshotLabels() {
    const dir = join(this.dir, 'snapshots');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.csv')).map((f) => f.replace(/\.csv$/, '')).sort();
  }

  readSnapshot(label) {
    const p = join(this.dir, 'snapshots', `${label}.csv`);
    return existsSync(p) ? fromCsv(readFileSync(p, 'utf8')) : [];
  }
}
