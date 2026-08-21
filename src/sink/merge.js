// The merge rules, kept in one place so the local workbook and the Google Sheets
// sink cannot drift apart. If they behaved differently, testing against one and
// shipping the other would prove nothing.

export const KEY_SEP = '|';

export const keyOf = (row, keyColumns) => keyColumns.map((c) => row[c]).join(KEY_SEP);

/**
 * What would change, described before anything is written.
 * Only changed cells are listed: a receipt nobody can read is the same as none.
 */
export function planMerge(existing, incoming, { columns, keyColumns }) {
  const have = new Map(existing.map((r) => [keyOf(r, keyColumns), r]));
  const added = [], revised = [];
  let unchanged = 0;

  for (const row of incoming) {
    const k = keyOf(row, keyColumns);
    const prev = have.get(k);
    if (!prev) { added.push(row); continue; }
    const changes = columns
      .filter((c) => String(prev[c] ?? '') !== String(row[c] ?? ''))
      .map((c) => ({ column: c, from: prev[c], to: row[c] }));
    if (changes.length) revised.push({ key: k, changes });
    else unchanged++;
  }

  const incomingKeys = new Set(incoming.map((r) => keyOf(r, keyColumns)));
  const absent = [...have.keys()].filter((k) => !incomingKeys.has(k));

  return {
    added: added.length,
    revised: revised.length,
    unchanged,
    // Rows the source stopped returning are kept. Deletion is never implicit.
    retained: absent.length,
    absentFromSource: absent.length,
    revisions: revised.slice(0, 25),
  };
}

/** Produce the rows to write. `mode: 'append'` and `keepDays` exist to be argued against. */
export function mergeRows(existing, incoming, { keyColumns, mode = 'upsert', keepDays = null, dateColumn = 'date' }) {
  let rows;
  if (mode === 'append') {
    rows = [...existing, ...incoming];
  } else {
    const merged = new Map(existing.map((r) => [keyOf(r, keyColumns), r]));
    for (const row of incoming) {
      const k = keyOf(row, keyColumns);
      merged.set(k, { ...(merged.get(k) || {}), ...row });
    }
    rows = [...merged.values()].sort((a, b) => keyOf(a, keyColumns).localeCompare(keyOf(b, keyColumns)));
  }
  if (keepDays) {
    const dates = [...new Set(rows.map((r) => r[dateColumn]))].sort();
    const keep = new Set(dates.slice(-keepDays));
    rows = rows.filter((r) => keep.has(r[dateColumn]));
  }
  return rows;
}
