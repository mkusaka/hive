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
  `runLoop`. The adapter gets the context and an `observe(kind, payload)` callback for fenced observations. A
  `STALE_GENERATION` on renew stops the agent, submits nothing and, once the agent exited, sends
  `runtime.run.stopped {confirmed: true}` (journal result `stopped`, or `stale_generation` if the cloud could not be
  told). `cancelRequested` on a renewal (`job.cancel`) stops the agent with reason `cancelled` and submits `failed`
  with error `cancelled`; the cloud finishes the Job `cancelled`. Web-standard APIs only, so it also runs inside
  workerd tests.
- `src/journal.ts`: the Local Journal file, `<state-dir>/journal.jsonl`, one fsynced JSON line per entry
  (`claim`, `intent`, `result`, `uploaded`). The intent is written before the adapter starts (§20.2).
  `transcriptReader(stateDir)` reads `<state-dir>/transcripts/<runId>.jsonl` (null when absent).
- `src/uploader.ts`: transcript upload (see Transcript upload).
- `src/adapters/fake.ts`: exits after `FAKE_DELAY_MS` (default 50) with code 0 and summary
  `fake: handled inbox item <id>`; `FAKE_FAIL=1` exits 1. It is idempotent, so reconcile may simply start it again.
- `src/adapters/claude.ts`: one SDK `query()` per Run (see below).
- `src/toolPolicy.ts`: the Bot tool policy as SDK options, the PreToolUse hook and the `canUseTool` approval gate
  (see Tool policy and approvals).
- `src/environments.ts`: `<state-dir>/environments.json`, environment name → local checkout root.
- `src/main.ts`: `--api-url --token-file --state-dir [--once] --provider fake|claude` (`node:util` `parseArgs`).

## Claude provider

- **Prompt.** `systemPrompt` = "You are <bot name>, a bot in a hive workspace." plus the Bot's `instructions`. The
  user message = the Task (if any), the Conversation's recent messages (oldest first), a "Memory" section (the
  context's memories with their scope) and a "Related" section (search hits with source kind and snippet), then the
  trigger item's body. Plain text.
- **Tools.** The Bot's tool policy (below) decides the native tools; `settingSources: []` (no user / project
  settings, hooks or CLAUDE.md), `strictMcpConfig`, `maxTurns: 4`. With a Run capability, `mcpServers: {hive}` is an
  in-process SDK MCP server (`src/tools.ts`) whose tools are in `allowedTools`; without one (a Run resumed after a
  restart: the token is returned once and not journaled) there are no hive tools and no approvals.
- **Hive tools.** `hive_send_request {botId | botName, text}`, `hive_notify {botId | botName, text}`,
  `hive_wait_for_reply {requestMessageId}`, `hive_reply {text}` (only when the trigger item is a request from another
  Bot), `hive_task_get {taskId}` and `hive_task_update {status?: "completed", assignee?}` (only for a Task Job),
  `hive_memory_write {content, scope: bot | task | channel}` (the scope id is the context's Bot, Task or
  Conversation channel; `task` / `channel` only when the context has one) and `hive_memory_search {q}`
  (`GET /v1/run/search`, the Run's scopes only). They
  call `/v1/run/*` with the capability (`cloud.forRun`); the token never enters a prompt. Inputs are Zod shapes,
  which the SDK turns into the model's JSON Schema and validates before a handler runs. A cloud error comes back
  as tool text with `isError`, never as an exception in the SDK loop.
- **Waiting.** When the tool result of `hive_wait_for_reply` appears in the stream, the adapter aborts the query
  (no further model turn is spent) and exits with `waitingFor`; the runner submits `state: "waiting"` and the Job
  waits in the cloud without holding the executor. The successor Run's prompt holds the original request and
  "Replies to your requests". A Bot's final text is posted only into a Channel conversation, not a bot pair.
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

## Transcript upload

`transcriptUploader` (UPLOAD-01; docs/architecture.md §3.3, §13.3, AT-21), wired by `main.ts` and `hive executor run`:

- **When.** Right after a Run's `result` is journaled (also for a stale or stopped attempt: late parts are kept as
  history), and at startup for every journaled result without an `uploaded` marker (Runs the cloud reported
  `missing` are skipped).
- **How.** `splitParts` cuts the transcript into parts of ≤ 1 MiB after a newline (a single longer line is a part
  of its own; the cloud refuses parts over 8 MiB). For each part: SHA-256, `POST /v1/executor/uploads/init`, and
  `PUT /v1/executor/uploads/:uploadId` unless the cloud already has it; then `POST /v1/executor/uploads/complete`
  with the last part seq (-1 when the Run wrote no transcript, e.g. the fake provider). The split is deterministic
  and init is idempotent, so a retry restarts from part 0 safely. The device token is used: the Run capability is
  revoked at result submit.
- **ACK.** `{kind: "uploaded", runId, lastPartSeq}` is journaled only after `complete` succeeded. A failure is retried
  3 times (1 s, 2 s backoff), then logged; the Run stays `persistence: pending` until the next start. The poll loop
  never fails because of an upload.
- **Retention.** The local transcript file is kept; there is no local cleanup yet.

## Tool policy and approvals

The run context's `bot.toolPolicy` (docs/architecture.md §19, §20.3; TOOLS-01):

- **SDK options.** `tools` = the `allow` + `ask` tools (the others do not exist for the model), `allowedTools` = the
  `allow` tools + the hive tools, `disallowedTools` = the `deny` tools, `permissionMode: "default"` (so a prompt
  reaches `canUseTool`; `dontAsk` would deny without asking). The SDK warns that `canUseTool` is not invoked for
  the pre-allowed tools; that is intended, the hook still gates them.
- **PreToolUse hook (mandatory).** Runs before any permission rule: a `deny` or unknown tool is denied; a
  Read / Edit / Write / Glob / Grep path (`file_path`, `path`, `pattern`, `glob`) outside the cwd (`..`, absolute,
  `~`) is denied; an `ask` tool returns `ask`, which forces the prompt even where Claude Code would auto-allow.
- **`canUseTool` (the broker).** Re-checks the policy first (a `deny` tool is denied even if asked), then for `ask`
  sends `approval.request` with the SHA-256 of the canonical (sorted-key) input and a summary (the Bash command or
  the path, ≤ 2 KiB, cwd replaced by `<cwd>`), and polls `GET /v1/run/approvals/:id` every 2 s. `approved` with the
  same hash → allow with that input; `denied`, `expired`, a cloud error, no capability or an abort (stop / cancel)
  → deny with a message the model sees. It never fails open and never returns null. The lease keeps renewing
  while it waits; the cloud expires the approval after 10 min.
- **cwd.** `run_scratch`: `<state-dir>/runs/<runId>`. `environment`: the checkout root mapped to the placement's
  `environmentId` in `<state-dir>/environments.json` (`hive device env add`); when it is missing or not a
  directory the adapter exits 1 with reason `environment_missing` without calling the SDK (the cloud already lists
  the Job only to devices that registered the environment).
- **Security.** The path check is not a sandbox (§18.3): **Bash is not path-restricted**. A Bot with Bash (`allow`
  or `ask`) runs as the executor's OS user with its files, network and credentials; treat its environment as
  `unsafe_host_access` (excluded from `safe_auto` recovery, which does not exist yet). `ask` puts a human in front
  of each call; `allow` does not. Symlinks inside the cwd are not resolved by the path check.

**Reconcile.** For each journaled claim without a result, or whose last result is an unconfirmed
`stale_generation`, `GET /v1/executor/runs/:id` decides: a Run the cloud reports `unknown` (its lease expired) is
confirmed stopped with `runtime.run.stopped {confirmed: true}` and journaled `stopped`, because nothing survives a
restart (the adapter runs in-process); it is never restarted (AT-14). An active Run with the same generation and no
result is resumed (lease renewed, adapter started again); a terminal Run gets its state as the result marker and a
Run the cloud does not know gets `missing`. A failed confirmation is retried on the next start. Only then does the
loop claim new Jobs.

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
`test/uploader.test.ts` covers the splitter and the uploader's ACK / retry rules; `test/claude.test.ts` drives the Claude adapter with a fake `queryFn` (SDK message shapes, no subprocess);
`test/tools.test.ts` covers the hive tools and the `waiting` exit; `test/toolPolicy.test.ts` the SDK options, the
path hook, the approval gate and the environment cwd; the end-to-end
loop against the real Hono app runs in `apps/api-worker/test/executor.test.ts` (workerd).

## Known gaps

- No process supervisor: the adapter runs in-process; no PID / start identity in the journal, so reconcile can only
  resume idempotent adapters.
- Transcripts are uploaded after the Run, not streamed while it runs; no artifact upload, no local retention
  cleanup and no SessionStore adapter (G-07), so no cross-device resume. A failed upload is retried only at the
  next start.
- No OS sandbox and no Bash path restriction; no effect broker for external writes (§19). No Codex adapter. A Run
  resumed by reconcile has no capability, so no hive tools and every `ask` tool is denied.
- Only `runtime.run.started` and `runtime.run.stopped` are observed; no usage / cost or other runtime events are
  sent to the cloud. The fake adapter sends no `runtime.run.started`, so its Runs stay `starting`.
- Stop confirmation trusts the in-process adapter: with a real process supervisor it must check the process (PID +
  start identity) before confirming. A long-running loop confirms a stale Run only when its own renewal hits
  `STALE_GENERATION`; a Run journaled by an earlier process is confirmed at the next start.
- No scheduler / offers or WebSocket: the executor polls. Capacity is one Run at a time.
