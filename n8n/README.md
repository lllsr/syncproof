# n8n workflows

Two importable workflows. Neither needs any credentials configured, so they run
immediately after import.

| File | What it does | Where it runs |
|---|---|---|
| `01-sync-then-verify.json` | Sync, then refuse to pass the data on unless it matches the export | anywhere, including n8n Cloud (HTTP only) |
| `02-verify-someone-elses-pipeline.json` | Only verify — for a sheet some other pipeline already builds | self-hosted (Execute Command node) |

## Import

**Workflows → ⋯ → Import from File**, pick the JSON. Then:

1. Start the API next to your data:
   ```bash
   syncproof serve --port 8790          # add --token X in anything but a local test
   ```
2. Start the bundled simulator if you are trying this without a real platform yet:
   ```bash
   syncproof simulate --port 8811
   ```
3. Edit the `job` query parameter in each HTTP node to point at your own job file.

Run it once by hand before scheduling it. The interesting run is the failing one:

```bash
syncproof demo --faults micros      # leaves a sheet that disagrees with the export
```

Execute the workflow again — the IF node now takes its second branch.

## Two things worth copying into your own scenarios

**Never Error + Full Response.** In the HTTP Request node's options, both must be on.
Without them a 422 aborts the run instead of arriving at your IF node as data, and you
lose the ability to react to a failed check at all.

**Branch on `statusCode`, not on a body field.** `POST /verify` answers 200 when the
sheet matches the export and 422 when it does not. That is deliberate: a status code is
hard to ignore, and a boolean buried in a response body is easy to ignore.

## Where the alert goes

`02` ends in a Code node that only logs. Replace it with Slack, Gmail, Linear — whatever
the team already reads. It is left as a Code node so the workflow imports and runs
without asking you to connect an account first.

## On n8n Cloud, Make and Zapier

None of them can run a shell command, so `02`'s Execute Command node will not work there.
Use the HTTP pattern from `01` instead: the API has to be reachable from the platform,
which means either running it on a box with a public address or putting a tunnel in front
of it. Keep `--token` set if you do.
