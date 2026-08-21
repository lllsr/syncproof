// A CRM-shaped stand-in, modelled on HubSpot's response envelope:
//   { results: [ { id, properties: {...} } ], paging: { next: { after } } }
//
// The point is not to imitate HubSpot exactly. It is that a deal pipeline fails in
// the same ways an ad report does — rows vanish, a stage gets renamed, a closed
// deal's amount is edited weeks later — and that those failures are invisible in a
// dashboard built on top of them.

import { rng } from './ledger.js';

const STAGES = ['appointmentscheduled', 'qualifiedtobuy', 'presentationscheduled', 'contractsent', 'closedwon', 'closedlost'];
const OWNERS = ['ana', 'bo', 'chen', 'dee'];
const PIPELINE = 'default';

export const CRM_FAULTS = {
  deleted_deal: 'two deals stop being returned, as if merged or deleted in the CRM',
  stage_rename: 'a stage is renamed, so any report grouping by stage loses those deals',
  amount_restated: 'the amount on an already-closed deal is edited after the fact',
  crm_cursor_drift: 'one record is skipped at each page boundary',
};

export function buildDeals({ seed = 7, count = 180 } = {}) {
  const r = rng(seed);
  const deals = [];
  for (let i = 0; i < count; i++) {
    const created = new Date(Date.UTC(2026, 4, 1) + Math.floor(r() * 90) * 86400000);
    const stage = STAGES[Math.floor(r() * STAGES.length)];
    const closed = stage.startsWith('closed');
    deals.push({
      id: String(4000 + i),
      dealname: `${['Acme', 'Northwind', 'Contoso', 'Globex', 'Initech'][Math.floor(r() * 5)]} — ${['renewal', 'expansion', 'new business'][Math.floor(r() * 3)]} ${i}`,
      amount: (500 + Math.floor(r() * 24500)).toFixed(2),
      dealstage: stage,
      pipeline: PIPELINE,
      hubspot_owner_id: OWNERS[Math.floor(r() * OWNERS.length)],
      createdate: created.toISOString().slice(0, 10),
      closedate: closed ? new Date(created.getTime() + Math.floor(r() * 40) * 86400000).toISOString().slice(0, 10) : '',
    });
  }
  return deals.sort((a, b) => a.id.localeCompare(b.id));
}

export const DEAL_COLUMNS = ['id', 'dealname', 'amount', 'dealstage', 'pipeline', 'hubspot_owner_id', 'createdate', 'closedate'];

/** What the CRM would return today, with the requested faults applied. */
export function dealsAsOf(deals, { faults = [], revision = 0 } = {}) {
  const on = (f) => faults.includes(f);
  let out = deals.map((d) => ({ ...d }));

  if (on('deleted_deal')) out = out.filter((d) => d.id !== '4005' && d.id !== '4090');
  if (on('stage_rename')) {
    out = out.map((d) => (d.dealstage === 'contractsent' ? { ...d, dealstage: 'contract-sent-v2' } : d));
  }
  if (on('amount_restated') && revision > 0) {
    // A closed deal's amount edited after the books were considered closed.
    out = out.map((d) => (d.id === '4011' ? { ...d, amount: (Number(d.amount) * 1.6).toFixed(2) } : d));
  }
  return out;
}

/** Page in HubSpot's shape, cursor nested at paging.next.after. */
export function crmPage(all, { after = '0', limit = 100, faults = [] }) {
  const start = Number(after) || 0;
  const readFrom = faults.includes('crm_cursor_drift') && start > 0 ? start + 1 : start;
  const slice = all.slice(readFrom, readFrom + Number(limit));
  const nextStart = start + Number(limit);
  return {
    results: slice.map((d) => ({ id: d.id, properties: { ...d }, createdAt: d.createdate, archived: false })),
    paging: nextStart < all.length ? { next: { after: String(nextStart), link: '…' } } : {},
    total: all.length,
  };
}
