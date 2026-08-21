# syncproof

**Sync a reporting API into a spreadsheet — then prove the spreadsheet matches it.**

Most reporting automation is judged by whether it runs. That is the wrong bar. A pipeline
that runs every morning and is quietly 8% short is worse than one that visibly breaks,
because decisions get made from it for months before anyone checks.

`syncproof` does the sync, and then does the part almost nobody ships: it compares the
result against the platform's own export and tells you, in writing, whether the numbers
can be trusted.

```bash
npx syncproof demo             # end to end against the bundled simulator, faults on
npx syncproof demo --clean     # the same suite with every fault switched off
```

```
verdict: NOT TRUSTWORTHY  (sheet 422 rows · export 423 rows · 2 snapshots)

  ✗ key_coverage         14 row(s) present in the export are missing from the sheet
  ✗ aggregate_tolerance  spend differs from the export by more than 0.5%
  ✗ row_level_diff       409 cell(s) disagree with the export
  ✓ unique_keys          primary key is unique across the sheet
  ✓ date_continuity      40 consecutive days present, 2026-07-05 to 2026-08-13
  ✓ history_preserved    no row present in the previous snapshot has been lost
  ! restatement          7 value(s) revised inside the attribution window (expected)
  ✗ join_integrity       1 value(s) in "ad_name" do not match any known entity
```

Exit code is non-zero when a check fails, so a scheduled run can stop rather than
overwrite a good sheet with a bad one.

---

## The four rules it is built on

**The sheet is never the evidence — the export is.** Verification compares against the
file a human would download from the platform to spot-check by hand. Anything else is a
pipeline agreeing with itself.

**History is not disposable.** Writes upsert by primary key and never truncate. Rows the
source stops returning are retained, not deleted. Every run leaves an immutable snapshot,
so last month's numbers can still be reproduced next quarter.

**Nothing is written without approval.** `sync` prints exactly what would change — added,
revised cell by cell, retained — and stops. It writes only with `--approve`.

**Every run leaves receipts.** One append-only JSONL line per action: pages read,
throttling absorbed, row counts against the platform's own hint, what was written, what
was withheld and why.

---

## The checks, and the failure each one exists for

| Check | The failure it catches | Why a dashboard won't show you |
|---|---|---|
| `key_coverage` | Rows silently dropped, usually at a page boundary | Totals stay plausible; nothing looks broken |
| `aggregate_tolerance` | Unit mismatches (micros vs currency), wrong date range | The one check a client performs on day one |
| `row_level_diff` | Individual cells disagreeing | Separates "the connector is wrong" from "one day was restated" |
| `unique_keys` | Duplicate rows from a retried, non-idempotent append | Double-counts spend, and the sheet still adds up |
| `date_continuity` | A missing day — a failed nightly run, or a timezone offset | A monthly total absorbs a missing Tuesday without a trace |
| `history_preserved` | A rolling window that wiped older rows | You only notice when someone asks about last quarter |
| `restatement` | Values changing on days that should be final | Late conversions are normal; a changed *settled* day is not |
| `join_integrity` | An entity renamed in the platform, breaking the join | Performance detaches from plan, and the plan looks empty |

Tolerances are stated, not implied: `aggregate_tolerance` defaults to 0.5% and reports
anything outside it rather than rounding it away.

### Every check has been observed failing

A check that has never been seen to fail is not evidence of anything. The bundled
simulator can switch on each fault so the corresponding check can be watched catching it:

```bash
npx syncproof demo --faults micros          # → aggregate_tolerance, row_level_diff
npx syncproof demo --faults cursor_drift    # → key_coverage
npx syncproof demo --faults rename          # → join_integrity
npx syncproof demo --faults tz_shift        # → key_coverage, aggregate_tolerance
npx syncproof demo --faults window_change   # → restatement
npx syncproof demo --faults missed_run      # → date_continuity
npx syncproof demo --faults dupe_page --naive     # → unique_keys
npx syncproof demo --clean --rolling 20           # → history_preserved
```

`--naive` switches the destination to plain row-appending and `--rolling N` to a rolling
window: the two behaviours this tool exists to argue against, kept in the codebase so the
difference can be demonstrated instead of asserted.

The simulator's faults are all things that happen in production: cost returned in micros,
a reporting day that starts at 07:00 UTC, a cursor that skips a row, a 429 mid-run, an ad
renamed by whoever was in the ads manager that afternoon, an attribution window changed
without notice, a scheduled run that failed at 03:00 and told nobody.

---

## Use it on a real pipeline

A job file describes source, destination and how to verify. It is plain JSON and lives in
the repo next to the pipeline it documents.

```jsonc
{
  "name": "Ad-level performance → reporting sheet",
  "receipts": "out/receipts.jsonl",

  "source": {
    "url": "https://api.example.com/v1/ads",
    "params": { "since": "2026-07-01", "until": "2026-08-14" },
    "cursorParam": "cursor", "cursorField": "next_cursor", "dataField": "data",
    "pageSize": 250,
    "transforms": { "spend": { "divide": 1000000, "round": 2 } }   // micros → currency
  },

  "sink": {
    "dir": "out/sheet",
    "keyColumns": ["date", "ad_name"],
    "columns": ["date", "ad_name", "impressions", "link_clicks", "purchases", "spend", "revenue"]
  },

  "truth": { "csv": "out/platform-export.csv" },

  "verify": {
    "keyColumns": ["date", "ad_name"],
    "metrics": ["impressions", "link_clicks", "purchases", "spend", "revenue"],
    "tolerancePct": 0.5,
    "joinColumn": "ad_name",
    "entityCsv": "out/roadmap-ads.csv",
    "settledAfterDays": 3
  }
}
```

```bash
syncproof sync   jobs/ads.json            # dry run: prints the plan, writes nothing
syncproof sync   jobs/ads.json --approve  # writes, and snapshots
syncproof verify jobs/ads.json            # exit 1 if the sheet disagrees with the export
syncproof report jobs/ads.json --out report.html
```

### Alongside n8n, Make or Zapier

This does not replace your workflow platform and does not ask you to move anything.
Keep the scenario you have; put a verification step in front of the decisions it feeds.

**Self-hosted n8n** — an Execute Command node:

```bash
syncproof verify jobs/ads.json --json     # exit 1 on failure, JSON summary on stdout
```

**n8n Cloud, Make, Zapier** — they cannot run shell commands, so run the HTTP surface
next to your data instead:

```bash
syncproof serve --port 8790 --token "$SYNCPROOF_TOKEN"
```

| Route | Meaning |
|---|---|
| `POST /verify?job=…` | **200** the sheet matches the export · **422** it does not |
| `POST /sync?job=…&approve=true` | perform the sync; without `approve` it returns the plan and writes nothing |
| `GET /healthz` | liveness, and whether a token is required |

A failed check is **422, not 200 with a flag in the body** — no-code platforms branch on
status codes, and a flag in a body gets ignored. An ignored check is not a check.

In an n8n HTTP Request node, set **Never Error** and **Full Response** so a 422 arrives
at your IF node as data instead of killing the run. Two importable workflows are in
[`n8n/`](n8n/): one that syncs then verifies, and one that only verifies — for a sheet
some other pipeline already builds.

The receipts file is append-only JSONL, so whatever already watches your logs can read it.

---

## Writing to a real Google Sheet

Two destinations exist and both go through the same merge rules, so testing against one
and shipping the other proves something:

| `sink.type` | Destination |
|---|---|
| `local` | a CSV workbook on disk — what the demo and the tests use |
| `sheets` | a Google Sheet: `current` tab plus one `snapshot <label>` tab per run |

Setup is deliberately narrow. Create a service account, give it **no project roles at
all**, and share the one spreadsheet with its address as an Editor. The credential can
then reach exactly one sheet and nothing else in the project.

```jsonc
"sink": {
  "type": "sheets",
  "credentialsPath": ".secrets/google-service-account.json",
  "spreadsheetId": "1buM…",
  "tab": "current",
  "snapshotPrefix": "snapshot ",
  "keyColumns": ["date", "ad_name"],
  "columns": ["date", "ad_name", "impressions", "link_clicks", "purchases", "spend", "revenue"]
}
```

Auth is a service-account JWT signed with `node:crypto` — still no dependencies. If a
403 comes back, the error says which address to share the sheet with.

If your network only allows outbound through a SOCKS5 proxy, set `SYNCPROOF_SOCKS5`
(e.g. `127.0.0.1:7890`). Unset, that code path is inert.

## What it does not do

No connector library. `source` speaks paginated JSON with a cursor, which covers a large
share of reporting APIs, but a platform with an unusual auth or export flow needs a small
adapter written for it.

The bundled dataset is **synthetic**, and clearly labelled as such in every report it
produces. Absolute numbers from the demo mean nothing; the checks and the failures they
catch are the point.

## Install and test

```bash
npm test        # 35 tests, standard library only, no network
```

Node 20+. No dependencies.

## Licence

MIT.
