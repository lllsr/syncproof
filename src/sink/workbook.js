// A local stand-in for the destination spreadsheet, with the same contract the
// Google Sheets sink will implement:
//
//   - upsert by primary key, never truncate
//   - one immutable snapshot per run, so yesterday's numbers can still be produced
//   - a row is only ever revised, and the revision is visible
//
// "Historical data can't disappear. No rolling 30-day windows that wipe older rows."

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const KEY_SEP = '|';

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
  constructor(dir, { columns, keyColumns, mode = 'upsert', keepDays = null, dateColumn = 'date' }) {
    this.dir = dir;
    this.columns = columns;
    this.keyColumns = keyColumns;
    this.mode = mode;
    this.keepDays = keepDays;      // a rolling window, i.e. the thing clients ask us not to do
    this.dateColumn = dateColumn;
    mkdirSync(join(dir, 'snapshots'), { recursive: true });
  }

  get currentPath() { return join(this.dir, 'current.csv'); }

  // A visible separator: receipts and diff reports are read by people.
  key(row) { return this.keyColumns.map((c) => row[c]).join(KEY_SEP); }

  readCurrent() {
    if (!existsSync(this.currentPath)) return [];
    return fromCsv(readFileSync(this.currentPath, 'utf8'));
  }

  /**
   * Merge incoming rows into the sheet. Returns a plan describing exactly what
   * would change, so it can be shown to a human before anything is written.
   */
  plan(incoming) {
    const existing = new Map(this.readCurrent().map((r) => [this.key(r), r]));
    const added = [], revised = [], unchanged = [];
    for (const row of incoming) {
      const k = this.key(row);
      const prev = existing.get(k);
      if (!prev) { added.push(row); continue; }
      // Only the changed cells go into the plan. A receipt nobody can read is
      // the same as no receipt.
      const changes = this.columns
        .filter((c) => String(prev[c] ?? '') !== String(row[c] ?? ''))
        .map((c) => ({ column: c, from: prev[c], to: row[c] }));
      if (changes.length) revised.push({ key: k, changes });
      else unchanged.push(row);
    }
    const incomingKeys = new Set(incoming.map((r) => this.key(r)));
    const absent = [...existing.keys()].filter((k) => !incomingKeys.has(k));
    return {
      added: added.length, revised: revised.length, unchanged: unchanged.length,
      absentFromSource: absent.length,
      revisions: revised.slice(0, 25),
      // Rows the source stopped returning are kept. Deletion is never implicit.
      retained: absent.length,
    };
  }

  commit(incoming, { snapshotLabel }) {
    let rows;
    if (this.mode === 'append') {
      // What a spreadsheet built from an "add row" automation actually does. Kept
      // as a switch so the difference can be shown rather than asserted.
      rows = [...this.readCurrent(), ...incoming];
    } else {
      const merged = new Map(this.readCurrent().map((r) => [this.key(r), r]));
      for (const row of incoming) {
        const k = this.key(row);
        merged.set(k, { ...(merged.get(k) || {}), ...row });
      }
      rows = [...merged.values()].sort((a, b) => this.key(a).localeCompare(this.key(b)));
    }
    if (this.keepDays) {
      // "No rolling 30-day windows that wipe older rows." This branch is the
      // behaviour being warned about, kept so the check can be seen catching it.
      const dates = [...new Set(rows.map((r) => r[this.dateColumn]))].sort();
      const keep = new Set(dates.slice(-this.keepDays));
      rows = rows.filter((r) => keep.has(r[this.dateColumn]));
    }
    const csv = toCsv(rows, this.columns);
    writeFileSync(this.currentPath, csv, 'utf8');
    if (snapshotLabel) {
      writeFileSync(join(this.dir, 'snapshots', `${snapshotLabel}.csv`), csv, 'utf8');
    }
    return { rows: rows.length };
  }

  snapshots() {
    const dir = join(this.dir, 'snapshots');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.csv')).sort();
  }
}
