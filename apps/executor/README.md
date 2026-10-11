# @hive/executor

The Local Executor (docs/architecture.md §20): a poll loop that claims queued Jobs over HTTPS, runs a provider
adapter and submits the result. Providers: `claude` (Claude Agent SDK) and `fake`. Runs on Node 24 or Bun.

## Modules

- `src/cloudClient.ts`: `fetch` wrapper for the executor routes (base URL, device token, envelope with a fresh
  `operationId`). Claim and result idempotency keys are derived from the Job revision / Run generation, so a retry
  after a lost response replays the stored receipt. Errors become `CloudError` with the `ApiError` code and
  `reason`. `fetch` is injectable.
- `src/runner.ts`: `reconcile` (startup), `runOnce` (heartbeat → list queued → claim → journal the claim → fetch the
  run context → journal the launch intent → start the adapter → renew the lease every quarter of its remaining
  time → submit the result, with `reply` when the adapter returns `replyText` and the Job has a Conversation) and
  `runLoop`. The adapter gets the context and an `observe(kind, payload)` callback for fenced observations. A `STALE_GENERATION` on renew stops the agent and submits nothing. Web-standard APIs only, so it also
  runs inside workerd tests.
- `src/journal.ts`: the Local Journal file, `<state-dir>/journal.jsonl`, one fsynced JSON line per entry
  (`claim`, `intent`, `result`). The intent is written before the adapter starts (§20.2).
- `src/adapters/fake.ts`: exits after `FAKE_DELAY_MS` (default 50) with code 0 and summary
  `fake: handled inbox item <id>`; `FAKE_FAIL=1` exits 1. It is idempotent, so reconcile may simply start it again.
- `src/adapters/claude.ts`: one SDK `query()` per Run (see below).
- `src/main.ts`: `--api-url --token-file --state-dir [--once] --provider fake|claude` (`node:util` `parseArgs`).

## Claude provider

- **Prompt.** `systemPrompt` = "You are <bot name>, a bot in a hive workspace." plus the Bot's `instructions`. The
  user message = the Task (if any), the Conversation's recent messages (oldest first) and the trigger item's body.
- **No tools by default.** `tools: []`, `allowedTools: []`, `permissionMode: "dontAsk"`, `settingSources: []`
  (no user / project settings, hooks or CLAUDE.md), `mcpServers: {}` with `strictMcpConfig`, `maxTurns: 4`,
  `cwd` = `<state-dir>/runs/<runId>`. Organization-managed plugins and bundled skills still load (seen in
  `system/init`), but no tool can be called.
- **Transcript journal.** Every SDK message is appended to `<state-dir>/transcripts/<runId>.jsonl` and fsynced
  before it is processed (§13.3: a durable local journal outside the SDK config dir). The SDK also keeps its own
  session files under `CLAUDE_CONFIG_DIR`.
- **Results.** `system/init` → `runtime.run.started` observation with `providerSessionId` (a failed observation
  is logged, not fatal). A `result` with `subtype: success` and `is_error: false` → exit 0, its text as summary
  (≤ 8 KiB) and reply; anything else → exit 1 with the subtype and errors. `requestStop` aborts the query.
- **Restart.** `start` reuses a transcript that already holds a `result` (no SDK call), resumes the journaled
  session (`resume: <session_id>`) when the transcript has only a `system/init`, and starts fresh otherwise.
- **Auth.** The SDK subprocess inherits `process.env`; no credentials pass through hive. `CLAUDE_CONFIG_DIR`
  selects the Claude login, so with a per-profile shell wrapper run
  `CLAUDE_CONFIG_DIR=<profile dir> hive executor run --provider claude`. hive never switches to an API key; an
  `ANTHROPIC_API_KEY` in the environment would be used by the SDK, so keep it unset for subscription use. The
  SDK runs its bundled Claude Code (2.1.289 with SDK 0.3.289), not the installed `claude`.

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

   `--provider claude` runs a real Claude turn instead (see Claude provider). `--once` reconciles the journal, then handles at most one queued Job and exits. If the Job is not listed yet, run the
   outbox pump first (`POST /v1/executor/pump`) or wait for the cron. Without `--once` it polls every 30 s.

## Tests

`bun run test` from the repo root. `test/runner.test.ts` runs in Node against an in-memory cloud;
`test/claude.test.ts` drives the Claude adapter with a fake `queryFn` (SDK message shapes, no subprocess); the end-to-end
loop against the real Hono app runs in `apps/api-worker/test/executor.test.ts` (workerd).

## Known gaps

- No process supervisor: the adapter runs in-process; no PID / start identity in the journal, so reconcile can only
  resume idempotent adapters.
- No R2 upload of transcripts or artifacts (the JSONL transcript stays local); no SessionStore adapter (G-07), so
  no cross-device resume.
- No tools / permission broker: the Claude provider answers without tools. No Codex adapter.
- Only `runtime.run.started` is observed; no usage / cost or other runtime events are sent to the cloud.
- `runtime.run.started` stores the provider session id but does not move the Run from `starting` to `running`.
- Lease expiry recovery is not automated; a Run whose lease expired stays active in the cloud.
- No scheduler / offers or WebSocket: the executor polls. Capacity is one Run at a time.
