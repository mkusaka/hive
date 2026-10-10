# @hive/executor

The Local Executor (docs/architecture.md §20), Phase 1: a poll loop that claims queued Jobs over HTTPS, runs a
provider adapter and submits the result. Only the `fake` provider exists. Runs on Node 24 or Bun.

## Modules

- `src/cloudClient.ts`: `fetch` wrapper for the executor routes (base URL, device token, envelope with a fresh
  `operationId`). Claim and result idempotency keys are derived from the Job revision / Run generation, so a retry
  after a lost response replays the stored receipt. Errors become `CloudError` with the `ApiError` code and
  `reason`. `fetch` is injectable.
- `src/runner.ts`: `reconcile` (startup), `runOnce` (heartbeat → list queued → claim → journal the claim and launch
  intent → start the adapter → renew the lease every quarter of its remaining time → submit the result) and
  `runLoop`. A `STALE_GENERATION` on renew stops the agent and submits nothing. Web-standard APIs only, so it also
  runs inside workerd tests.
- `src/journal.ts`: the Local Journal file, `<state-dir>/journal.jsonl`, one fsynced JSON line per entry
  (`claim`, `intent`, `result`). The intent is written before the adapter starts (§20.2).
- `src/adapters/fake.ts`: exits after `FAKE_DELAY_MS` (default 50) with code 0 and summary
  `fake: handled inbox item <id>`; `FAKE_FAIL=1` exits 1. It is idempotent, so reconcile may simply start it again.
- `src/main.ts`: `--api-url --token-file --state-dir [--once] --provider fake` (`node:util` `parseArgs`).

**Reconcile.** For each journaled claim without a result, `GET /v1/executor/runs/:id` decides: an active Run with
the same generation is resumed (lease renewed, adapter started again); a terminal or unknown Run gets a result
marker in the journal. Only then does the loop claim new Jobs.

## Running against `wrangler dev`

1. Start the API Worker locally (see `apps/api-worker/README.md`, Local development).
2. As a user, register a device and keep the token (returned only once). `hive device register` (see
   `apps/cli/README.md`) does this and writes the token file; by hand it is:

   ```sh
   curl -s http://localhost:8787/v1/commands -H "Cf-Access-Jwt-Assertion: <assertion>" \
     -H "Content-Type: application/json" -d '{"operationId":"op-1","idempotencyKey":"dev-1",
     "workspaceId":"<workspace-id>","command":{"type":"device.register","name":"pc1","os":"darwin",
     "agentVersion":"0.0.0"}}' | jq -r .deviceToken > ~/.hive-device-token
   chmod 600 ~/.hive-device-token
   ```

3. Send a request to a Bot (`agent.send`), then run the executor once:

   ```sh
   bun run apps/executor/src/main.ts --api-url http://localhost:8787 \
     --token-file ~/.hive-device-token --state-dir ~/.hive-executor --once --provider fake
   ```

   `--once` reconciles the journal, then handles at most one queued Job and exits. If the Job is not listed yet, run the
   outbox pump first (`POST /v1/executor/pump`) or wait for the cron. Without `--once` it polls every 30 s.

## Tests

`bun run test` from the repo root. `test/runner.test.ts` runs in Node against an in-memory cloud; the end-to-end
loop against the real Hono app runs in `apps/api-worker/test/executor.test.ts` (workerd).

## Known gaps

- No process supervisor: the adapter runs in-process; no PID / start identity in the journal, so reconcile can only
  resume idempotent adapters.
- No R2 upload of transcripts or artifacts; no `runtime.run.started` observations.
- Lease expiry recovery is not automated; a Run whose lease expired stays active in the cloud.
- No scheduler / offers or WebSocket: the executor polls. Capacity is one Run at a time.
