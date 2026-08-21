// Google Sheets destination, implementing the same contract as the local workbook:
// upsert by key, retain what the source stopped sending, immutable snapshot per run.
//
// Auth is a service-account JWT signed with node:crypto, so this file adds no
// dependencies. The account is deliberately given no project roles — it can only
// touch a spreadsheet that someone has explicitly shared with its address.

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { planMerge, mergeRows, keyOf } from './merge.js';
import { makeFetch } from '../net/proxy.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
export const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'];

const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class ServiceAccount {
  constructor(credentialsPath, scopes = SCOPES, fetchImpl = makeFetch()) {
    this.fetch = fetchImpl;
    const raw = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    if (raw.type !== 'service_account') throw new Error(`${credentialsPath} is not a service account key`);
    this.email = raw.client_email;
    this.key = raw.private_key;
    this.projectId = raw.project_id;
    this.scopes = scopes;
    this.cached = null;
  }

  async token() {
    const now = Math.floor(Date.now() / 1000);
    if (this.cached && this.cached.exp > now + 60) return this.cached.token;

    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64url(JSON.stringify({
      iss: this.email, scope: this.scopes.join(' '), aud: TOKEN_URL, iat: now, exp: now + 3600,
    }));
    const signature = b64url(createSign('RSA-SHA256').update(`${header}.${claim}`).sign(this.key));

    const res = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claim}.${signature}`,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${body.error_description || body.error || ''}`);
    this.cached = { token: body.access_token, exp: now + (body.expires_in || 3600) };
    return this.cached.token;
  }

  async call(url, { method = 'GET', body, query } = {}) {
    const target = query ? `${url}?${new URLSearchParams(query)}` : url;
    const res = await this.fetch(target, {
      method,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const msg = parsed.error?.message || text.slice(0, 300);
      // The single most likely failure, and the one worth naming outright.
      const hint = res.status === 403 && /permission|caller does not have/i.test(msg)
        ? `\n  Share the spreadsheet with ${this.email} as an Editor, then retry.`
        : '';
      throw new Error(`${method} ${url.replace(SHEETS, 'sheets')} → ${res.status}: ${msg}${hint}`);
    }
    return parsed;
  }
}

// The write body's range must match the URL's range exactly, so both derive from one place.
export const RANGE = (tab) => `'${tab.replace(/'/g, "''")}'!A1:ZZZ200000`;
const A1 = (tab) => encodeURIComponent(RANGE(tab));

export function toValues(rows, columns) {
  return [columns, ...rows.map((r) => columns.map((c) => (r[c] ?? '')))];
}

export function fromValues(values, columns) {
  if (!values?.length) return [];
  const [header, ...body] = values;
  const cols = header?.length ? header : columns;
  return body
    .filter((row) => row.some((cell) => String(cell ?? '') !== ''))
    .map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i] ?? ''])));
}

export class SheetsWorkbook {
  constructor({ credentialsPath, spreadsheetId, tab = 'current', snapshotPrefix = 'snapshot ', columns, keyColumns, mode = 'upsert', keepDays = null, dateColumn = 'date' }) {
    if (!spreadsheetId) throw new Error('sink.spreadsheetId is required for the sheets sink');
    this.sa = new ServiceAccount(credentialsPath);
    this.id = spreadsheetId;
    this.tab = tab;
    this.snapshotPrefix = snapshotPrefix;
    this.columns = columns;
    this.keyColumns = keyColumns;
    this.mode = mode;
    this.keepDays = keepDays;
    this.dateColumn = dateColumn;
  }

  get url() { return `https://docs.google.com/spreadsheets/d/${this.id}`; }
  key(row) { return keyOf(row, this.keyColumns); }

  async tabs() {
    const meta = await this.sa.call(`${SHEETS}/${this.id}`, { query: { fields: 'sheets.properties(title,sheetId)' } });
    return (meta.sheets || []).map((s) => s.properties);
  }

  async ensureTab(title) {
    const existing = await this.tabs();
    if (existing.some((p) => p.title === title)) return;
    await this.sa.call(`${SHEETS}/${this.id}:batchUpdate`, {
      method: 'POST', body: { requests: [{ addSheet: { properties: { title } } }] },
    });
  }

  async readTab(title) {
    try {
      const res = await this.sa.call(`${SHEETS}/${this.id}/values/${A1(title)}`);
      return fromValues(res.values, this.columns);
    } catch (err) {
      if (/Unable to parse range|not found/i.test(err.message)) return [];
      throw err;
    }
  }

  async writeTab(title, rows) {
    await this.ensureTab(title);
    // Clear then write: a shorter result must not leave stale rows behind. The
    // rows themselves are never dropped — mergeRows decides that, not this method.
    await this.sa.call(`${SHEETS}/${this.id}/values/${A1(title)}:clear`, { method: 'POST', body: {} });
    await this.sa.call(`${SHEETS}/${this.id}/values/${A1(title)}`, {
      method: 'PUT',
      query: { valueInputOption: 'RAW' },
      body: { range: RANGE(title), majorDimension: 'ROWS', values: toValues(rows, this.columns) },
    });
  }

  async readCurrent() { return this.readTab(this.tab); }

  async plan(incoming) {
    const existing = await this.readCurrent();
    return planMerge(existing, incoming, { columns: this.columns, keyColumns: this.keyColumns });
  }

  async commit(incoming, { snapshotLabel } = {}) {
    const existing = await this.readCurrent();
    const rows = mergeRows(existing, incoming, this);
    await this.writeTab(this.tab, rows);
    if (snapshotLabel) await this.writeTab(`${this.snapshotPrefix}${snapshotLabel}`, rows);
    return { rows: rows.length, url: this.url };
  }

  async snapshotLabels() {
    const titles = (await this.tabs()).map((p) => p.title).filter((t) => t.startsWith(this.snapshotPrefix));
    return titles.map((t) => t.slice(this.snapshotPrefix.length)).sort();
  }

  async readSnapshot(label) { return this.readTab(`${this.snapshotPrefix}${label}`); }
}

/** One-off setup: create a spreadsheet the service account owns, and share it. */
export async function createSpreadsheet({ credentialsPath, title, shareWith }) {
  const sa = new ServiceAccount(credentialsPath);
  const created = await sa.call(SHEETS, { method: 'POST', body: { properties: { title } } });
  const id = created.spreadsheetId;
  if (shareWith) {
    await sa.call(`${DRIVE}/${id}/permissions`, {
      method: 'POST',
      query: { sendNotificationEmail: 'false' },
      body: { role: 'writer', type: 'user', emailAddress: shareWith },
    });
  }
  return { id, url: `https://docs.google.com/spreadsheets/d/${id}`, sharedWith: shareWith || null, owner: sa.email };
}
