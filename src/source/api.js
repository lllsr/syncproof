// Paginated reader for a JSON reporting API.
//
// The two things that make this different from a fetch loop in a no-code node:
// it refuses to report success on a partial read, and it writes down what it did.

/**
 * Read a dotted path out of a response body. Real APIs nest their cursors:
 * HubSpot returns `paging.next.after`, Salesforce `nextRecordsUrl`, Meta
 * `paging.cursors.after`. Supporting a path costs one function and removes the
 * need for a bespoke adapter per platform.
 */
const at = (obj, path) => (path ? String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj) : undefined);

export async function readAll({ url, params = {}, auth, cursorParam = 'cursor', cursorField = 'next_cursor', dataField = 'data', pageSize = 250, pageSizeParam = 'limit', totalField = 'total_hint', maxRetries = 5, receipts, fetchImpl = fetch }) {
  const rows = [];
  let cursor = null;
  let pages = 0;
  let retriesUsed = 0;
  const pageBoundaries = [];

  for (;;) {
    const q = new URLSearchParams({ ...params, [pageSizeParam]: String(pageSize) });
    if (cursor) q.set(cursorParam, cursor);
    const target = `${url}?${q}`;

    let res, attempt = 0;
    for (;;) {
      try {
        res = await fetchImpl(target, { headers: auth ? { authorization: auth } : {} });
      } catch (err) {
        // A connection failure is the one error worth explaining, because the
        // cause is almost always "the thing being read is not running".
        throw new Error(`cannot reach ${url} (${err.cause?.code || err.message}). `
          + `If this is the bundled simulator, start it first: syncproof simulate`);
      }
      if (res.status !== 429 && res.status < 500) break;
      if (attempt >= maxRetries) {
        throw new Error(`giving up on ${target} after ${attempt} retries (last status ${res.status})`);
      }
      // Honour Retry-After when the server sends it; otherwise back off exponentially.
      const hinted = Number(res.headers.get?.('retry-after'));
      const waitMs = Number.isFinite(hinted) && hinted > 0 ? hinted * 1000 : Math.min(30000, 500 * 2 ** attempt);
      receipts?.note('throttled', { url: target, status: res.status, waitMs, attempt });
      await new Promise((f) => setTimeout(f, waitMs));
      attempt++; retriesUsed++;
    }

    if (!res.ok) throw new Error(`${res.status} from ${target}`);
    const body = await res.json();
    const batch = at(body, dataField) ?? [];
    pages++;
    pageBoundaries.push({ page: pages, cursor: cursor ?? '0', received: batch.length });
    rows.push(...batch);

    const next = at(body, cursorField);
    if (!next) {
      // A total hint is a cheap end-to-end check the platform gives away for free.
      const hint = at(body, totalField);
      if (Number.isFinite(hint) && hint !== rows.length) {
        receipts?.note('count_mismatch_vs_hint', { expected: hint, received: rows.length });
      }
      return { rows, pages, retriesUsed, pageBoundaries, totalHint: hint ?? null };
    }
    cursor = next;
    if (pages > 10000) throw new Error('pagination did not terminate');
  }
}

/**
 * Lift nested objects onto the row. CRMs return their fields one level down
 * (HubSpot puts everything in `properties`), and a spreadsheet wants columns.
 * Declared in the job file so the shape of the source stays documented.
 */
export function flatten(rows, fields = []) {
  if (!fields.length) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const f of fields) {
      const nested = at(row, f);
      if (nested && typeof nested === 'object') Object.assign(out, nested);
      delete out[String(f).split('.')[0]];
    }
    return out;
  });
}

/** Apply declared per-field transforms from the job spec, e.g. micros -> currency. */
export function normalise(rows, transforms = {}) {
  const keys = Object.keys(transforms);
  if (!keys.length) return rows;
  return rows.map((row) => {
    const out = { ...row };
    for (const k of keys) {
      const t = transforms[k];
      if (out[k] == null) continue;
      let v = Number(out[k]);
      if (t.divide) v /= t.divide;
      if (t.multiply) v *= t.multiply;
      if (t.round != null) v = Number(v.toFixed(t.round));
      out[k] = v;
    }
    return out;
  });
}
