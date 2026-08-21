// Destination selection. Both sinks expose the same methods; the local one is
// synchronous and the Sheets one is not, so callers await either way.

import { resolve } from 'node:path';
import { LocalWorkbook } from './workbook.js';
import { SheetsWorkbook } from './sheets.js';

export function openSink(sink, { cwd = process.cwd() } = {}) {
  const type = sink.type || (sink.spreadsheetId ? 'sheets' : 'local');
  if (type === 'local') {
    return new LocalWorkbook({ ...sink, dir: resolve(cwd, sink.dir || 'out/sheet') });
  }
  if (type === 'sheets') {
    const credentialsPath = resolve(cwd, sink.credentialsPath
      || process.env.SYNCPROOF_GOOGLE_CREDENTIALS
      || '.secrets/google-service-account.json');
    return new SheetsWorkbook({ ...sink, credentialsPath });
  }
  throw new Error(`unknown sink type "${type}" (expected "local" or "sheets")`);
}
