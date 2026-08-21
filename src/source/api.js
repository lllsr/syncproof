// Paginated reader for a JSON reporting API.
//
// The two things that make this different from a fetch loop in a no-code node:
// it refuses to report success on a partial read, and it writes down what it did.

export async function readAll({ url, params = {}, auth, cursorParam = 'cursor', cursorField = 'next_cursor', dataField = 'data', pageSize = 250, maxRetries = 5, receipts, fetchImpl = fetch }) {
  const rows = [];
  let cursor = null;
  let pages = 0;
  let retriesUsed = 0;
  const pageBoundaries = [];

  for (;;) {
    const q = new URLSearchParams({ ...params, limit: String(pageSize) });
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
    const batch = body[dataField] ?? [];
    pages++;
    pageBoundaries.push({ page: pages, cursor: cursor ?? '0', received: batch.length });
    rows.push(...batch);

    const next = body[cursorField];
    if (!next) {
      // A total hint is a cheap end-to-end check the platform gives away for free.
      if (Number.isFinite(body.total_hint) && body.total_hint !== rows.length) {
        receipts?.note('count_mismatch_vs_hint', { expected: body.total_hint, received: rows.length });
      }
      return { rows, pages, retriesUsed, pageBoundaries, totalHint: body.total_hint ?? null };
    }
    cursor = next;
    if (pages > 10000) throw new Error('pagination did not terminate');
  }
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
