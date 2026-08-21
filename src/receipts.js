// An append-only run log. One JSON object per line, never rewritten.
//
// "Every action logged with a receipt" is a phrase clients use when they have been
// burned by an automation that changed something and could not say what or when.

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class Receipts {
  constructor(path, { runId = randomUUID().slice(0, 8), meta = {} } = {}) {
    this.path = path;
    this.runId = runId;
    mkdirSync(dirname(path), { recursive: true });
    this.note('run_started', meta);
  }

  note(action, detail = {}) {
    // Detail is spread first: a caller passing its own `action` must not be able to
    // overwrite the event name, or the log stops being an audit trail.
    const line = JSON.stringify({ ...detail, ts: new Date().toISOString(), run: this.runId, action });
    appendFileSync(this.path, line + '\n', 'utf8');
    return line;
  }

  /** Reads back this run's entries — used by the report and by tests. */
  entries(runId = this.runId) {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && (!runId || e.run === runId));
  }
}

/**
 * A write gate. Nothing that changes a client's data happens without either an
 * explicit approval flag or a plan the human can read first.
 */
export function gate({ approved, receipts, action, plan }) {
  if (approved) {
    receipts?.note('write_approved', { op: action, ...plan });
    return { proceed: true };
  }
  receipts?.note('write_withheld_dry_run', { op: action, ...plan });
  return { proceed: false, reason: 'dry-run: re-run with --approve to write' };
}
