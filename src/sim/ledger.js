// The simulator's private truth: what actually happened in the ad account.
//
// This is synthetic data. It exists so the verification layer can be demonstrated
// against known faults — a live ad account will not produce a cursor drift or a
// unit mismatch on demand, and inventing screenshots of one would be a lie.
// The export CSV written here plays the part of the client's "download from Ads
// Manager", which is the artefact a real spot-check is performed against.

const ANGLES = ['problem-first', 'social-proof', 'price-anchor', 'founder-story'];
const FORMATS = ['static', 'ugc-video', 'carousel'];
const PERSONAS = ['new-parent', 'gift-buyer', 'self-treat'];

// Deterministic PRNG (mulberry32). Determinism is the point: the same seed must
// produce the same ledger, or a diff report proves nothing.
export function rng(seed = 42) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function ymd(d) {
  return d.toISOString().slice(0, 10);
}

function days(from, n) {
  const out = [];
  const start = new Date(from + 'T00:00:00Z');
  for (let i = 0; i < n; i++) {
    out.push(ymd(new Date(start.getTime() + i * 86400000)));
  }
  return out;
}

/**
 * Build the ground-truth ledger: one row per ad per day.
 * Ads are named after the client's own convention — batch #184, variations #184.1 …
 */
export function buildLedger({ seed = 42, from = '2026-07-01', dayCount = 45, batches = 14 } = {}) {
  const r = rng(seed);
  const dates = days(from, dayCount);
  const ads = [];

  for (let b = 0; b < batches; b++) {
    const batch = 180 + b;
    const angle = ANGLES[Math.floor(r() * ANGLES.length)];
    const format = FORMATS[Math.floor(r() * FORMATS.length)];
    const persona = PERSONAS[Math.floor(r() * PERSONAS.length)];
    const variations = 2 + Math.floor(r() * 3);
    // Each batch runs for a window inside the period, as creative testing does.
    const startIdx = Math.floor(r() * Math.max(1, dayCount - 10));
    const liveDays = 5 + Math.floor(r() * 12);
    for (let v = 1; v <= variations; v++) {
      ads.push({
        ad_name: `#${batch}.${v}`,
        batch: `#${batch}`,
        angle, format, persona,
        quality: 0.4 + r() * 1.4,          // hidden performance multiplier
        startIdx,
        endIdx: Math.min(dayCount - 1, startIdx + liveDays),
      });
    }
  }

  const rows = [];
  for (const ad of ads) {
    for (let i = ad.startIdx; i <= ad.endIdx; i++) {
      const date = dates[i];
      const impressions = Math.round((800 + r() * 5200) * ad.quality);
      const plays3s = Math.round(impressions * (0.18 + r() * 0.22));
      const clicks = Math.round(impressions * (0.008 + r() * 0.02) * ad.quality);
      const spendCents = Math.round(impressions * (0.9 + r() * 1.6));
      const purchases = Math.max(0, Math.round(clicks * (0.02 + r() * 0.07) * ad.quality));
      const revenueCents = purchases * Math.round(3200 + r() * 5600);
      rows.push({
        date,
        ad_name: ad.ad_name,
        batch: ad.batch,
        impressions, plays3s, clicks, purchases,
        spend_cents: spendCents,
        revenue_cents: revenueCents,
      });
    }
  }

  rows.sort((a, b) => (a.date + a.ad_name).localeCompare(b.date + b.ad_name));

  const roadmap = [];
  const seen = new Set();
  for (const ad of ads) {
    if (seen.has(ad.batch)) continue;
    seen.add(ad.batch);
    roadmap.push({ batch: ad.batch, angle: ad.angle, format: ad.format, persona: ad.persona });
  }

  return { rows, roadmap, dates, ads };
}

/**
 * Late-arriving conversions. Real ad platforms revise the last few days upward
 * as attribution lands; a sync that treats yesterday as final is quietly wrong.
 * `asOf` is the moment the data is being read.
 */
export function applyRestatement(rows, asOf, { window = 3, factor = 0.72 } = {}) {
  const asOfMs = new Date(asOf + 'T00:00:00Z').getTime();
  return rows.map((row) => {
    const ageDays = (asOfMs - new Date(row.date + 'T00:00:00Z').getTime()) / 86400000;
    if (ageDays < 0) return null;                  // not yet happened
    if (ageDays >= window) return { ...row };      // settled
    // Younger than the attribution window: only part of the conversions are visible yet.
    const visible = factor + (1 - factor) * (ageDays / window);
    return {
      ...row,
      purchases: Math.floor(row.purchases * visible),
      revenue_cents: Math.floor(row.revenue_cents * visible),
    };
  }).filter(Boolean);
}

export function toCsv(rows, columns) {
  const head = columns.join(',');
  const body = rows.map((r) => columns.map((c) => {
    const v = r[c] ?? '';
    return /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
  }).join(','));
  return [head, ...body].join('\n') + '\n';
}

/** The export a client downloads from Ads Manager: currency, not micros. */
export function exportRows(rows) {
  return rows.map((r) => ({
    date: r.date,
    ad_name: r.ad_name,
    impressions: r.impressions,
    three_second_plays: r.plays3s,
    link_clicks: r.clicks,
    purchases: r.purchases,
    spend: (r.spend_cents / 100).toFixed(2),
    revenue: (r.revenue_cents / 100).toFixed(2),
  }));
}

export const EXPORT_COLUMNS = [
  'date', 'ad_name', 'impressions', 'three_second_plays',
  'link_clicks', 'purchases', 'spend', 'revenue',
];
