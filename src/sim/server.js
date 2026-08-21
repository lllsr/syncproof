// A stand-in for an ad platform's reporting API, with switchable faults.
//
// Every fault here is one I have either hit or seen reported in the wild. They are
// switchable so a check can be shown failing and then passing — a check that has
// never been observed to fail is not evidence of anything.

import { createServer } from 'node:http';
import { buildLedger, applyRestatement } from './ledger.js';
import { buildDeals, dealsAsOf, crmPage, CRM_FAULTS } from './crm.js';

export const FAULTS = {
  micros: 'spend is returned in micros (1e6) while the export is in currency units',
  cursor_drift: 'one row is silently skipped at each page boundary',
  rate_limit: 'every 4th request returns 429 with Retry-After',
  tz_shift: 'the reporting day starts at 07:00 UTC, so some rows land on the previous date',
  rename: 'an ad is renamed mid-period, breaking any join on ad name',
  dupe_page: 'a retried page returns rows that were already delivered',
  window_change: 'the attribution window changes mid-period, restating older days',
  missed_run: 'one date returns no rows at all, as if a scheduled run had failed that night',
  ...CRM_FAULTS,
};

/** The date the `missed_run` fault blanks out. */
export const MISSED_DATE = '2026-07-28';

export function createSimulator({ seed = 42, faults = [], asOf = '2026-08-14', pageSize = 250 } = {}) {
  const on = (f) => faults.includes(f);
  const ledger = buildLedger({ seed });
  let requestCount = 0;
  let currentAsOf = asOf;

  const rows = () => {
    let rs = applyRestatement(ledger.rows, currentAsOf, on('window_change') ? { window: 6, factor: 0.55 } : {});
    if (on('tz_shift')) {
      // A 7-hour offset moves a slice of each day's activity onto the previous date.
      rs = rs.map((r, i) => (i % 9 === 0
        ? { ...r, date: new Date(new Date(r.date + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10) }
        : r));
    }
    if (on('rename')) {
      rs = rs.map((r) => (r.ad_name === '#184.2' && r.date >= '2026-07-20'
        ? { ...r, ad_name: '#184.2 (v2 hook)' }
        : r));
    }
    if (on('missed_run')) {
      rs = rs.filter((r) => r.date !== MISSED_DATE);
    }
    return rs;
  };

  /** Serve one page. Returns { status, body, headers }. */
  function page({ since, until, cursor = '0', limit = pageSize }) {
    requestCount++;
    if (on('rate_limit') && requestCount % 4 === 0) {
      return { status: 429, headers: { 'retry-after': '2' }, body: { error: 'rate limit exceeded' } };
    }

    let all = rows();
    if (since) all = all.filter((r) => r.date >= since);
    if (until) all = all.filter((r) => r.date <= until);

    const start = Number(cursor) || 0;
    // cursor_drift: the next page starts one row late, so that row is never delivered.
    const readFrom = on('cursor_drift') && start > 0 ? start + 1 : start;
    let slice = all.slice(readFrom, readFrom + Number(limit));

    if (on('dupe_page') && start > 0 && requestCount % 3 === 0) {
      slice = [...all.slice(Math.max(0, start - 3), start), ...slice];
    }

    const data = slice.map((r) => ({
      date: r.date,
      ad_name: r.ad_name,
      impressions: r.impressions,
      three_second_plays: r.plays3s,
      link_clicks: r.clicks,
      purchases: r.purchases,
      // The unit trap: micros is what Google Ads actually returns for cost.
      spend: on('micros') ? r.spend_cents * 10000 : r.spend_cents / 100,
      revenue: r.revenue_cents / 100,
    }));

    const nextStart = start + Number(limit);
    return {
      status: 200,
      headers: {},
      body: { data, next_cursor: nextStart < all.length ? String(nextStart) : null, total_hint: all.length },
    };
  }

  const deals = buildDeals({ seed });
  /** The CRM endpoint. `revision` advances with asOf, so an edit can appear later. */
  const crm = ({ after, limit }) => {
    requestCount++;
    if (on('rate_limit') && requestCount % 4 === 0) {
      return { status: 429, headers: { 'retry-after': '2' }, body: { error: 'rate limit exceeded' } };
    }
    const revision = currentAsOf >= '2026-08-14' ? 1 : 0;
    const all = dealsAsOf(deals, { faults, revision });
    return { status: 200, headers: {}, body: crmPage(all, { after, limit, faults }) };
  };

  return {
    page, crm, deals, ledger, faults,
    get asOf() { return currentAsOf; },
    /** Advance the clock between runs, as a scheduled sync would experience it. */
    setAsOf(d) { currentAsOf = d; requestCount = 0; },
  };
}

export function serve(sim, port = 8787) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, faults: sim.faults, asOf: sim.asOf }));
    }
    if (url.pathname === '/crm/v3/objects/deals') {
      const out = sim.crm({ after: url.searchParams.get('after') || '0', limit: url.searchParams.get('limit') || 100 });
      res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers });
      return res.end(JSON.stringify(out.body));
    }
    if (url.pathname !== '/v1/ads') {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    const out = sim.page({
      since: url.searchParams.get('since'),
      until: url.searchParams.get('until'),
      cursor: url.searchParams.get('cursor') || '0',
      limit: url.searchParams.get('limit') || 250,
    });
    res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers });
    res.end(JSON.stringify(out.body));
  });
  server.listen(port);
  return server;
}
