# n8n workflows

Two importable workflows. Neither needs any credentials configured, so they run
immediately after import.

| File | What it does |
|---|---|
| `01-sync-then-verify.json` | Sync, then refuse to pass the data on unless it matches the export |
| `02-verify-someone-elses-pipeline.json` | Only verify — for a sheet some other pipeline already builds |

Both talk to syncproof over HTTP, so both work on self-hosted n8n and on n8n Cloud.

## Run them

```bash
syncproof serve    --port 8790            # the API the workflows call
syncproof simulate --port 8787            # stand-in source, matching jobs/ads-to-sheet.json
syncproof demo     --clean                # give the sheet a clean starting state
```

Import each file via **Workflows → ⋯ → Import from File**, then press **Execute
workflow**. Both start with a manual trigger next to the schedule, so they can be run
by hand or headlessly:

```bash
n8n execute --id syncproof0000001
```

The interesting run is the failing one. Restart the simulator with a fault and execute
again:

```bash
syncproof simulate --port 8787 --faults micros
```

`01` now stops at **Stop: do not report from this**, and the error message carries the
diagnosis — *"423 cell(s) disagree — every one in spend, each exactly 1000000× the
export"*. `02` takes its alert branch with the same detail in the payload.

## Four things learned building these

**Never Error + Full Response on the verify node.** Both must be on. Without them a 422
aborts the run instead of arriving at the IF node as data, and you lose the ability to
react to a failed check at all.

**Do NOT set Never Error on the sync node.** A failed sync has to stop the run. The first
version of `01` had it on both nodes, and the workflow went green while the sync was
failing — the sheet was simply stale, and stale data still matched the stale export.
A green run that proves nothing is worse than a red one.

**Branch on `statusCode`, not on a body field.** `POST /verify` answers 200 when the sheet
matches and 422 when it does not. A status code is hard to ignore; a boolean buried in a
response body is easy to ignore.

**The Execute Command node is not a usable integration path.** Two reasons, both
measured, not assumed:

- n8n 2.x **disables it by default** for security, along with `localFileTrigger`. Re-enabling
  needs `NODES_EXCLUDE=[]` on the server — a change a client's ops team may well refuse.
  (`NODES_INCLUDE` is not the flag: it is an instance-wide allowlist, and setting it to just
  that one node leaves every other node unavailable.)
- Once enabled, it returned **empty `stdout`** on this build even for
  `node -e "console.log(...)"`. It reports `exitCode: 0` and no output, so a command's
  result cannot be read. And with `onError: continueRegularOutput` set, a non-zero exit
  replaces the output entirely with `{ error: "Command failed with exit code 1" }`.

So the HTTP surface is the integration, not the fallback. If you do want to shell out from
somewhere else — cron, CI, a Make.com self-hosted agent — `syncproof verify` supports
`--cwd` (paths in a job file resolve against the working directory, and `cd X && …` differs
between `cmd.exe` and `sh`) and `--exit-zero` (put the verdict in the JSON body instead of
the exit status).

## Where the alert goes

`02` ends in a Code node that only logs. Replace it with Slack, Gmail, Linear — whatever
the team already reads. It is left as a Code node so the workflow imports and runs without
asking you to connect an account first.
