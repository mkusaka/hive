# @hive/executor

The Local Executor (docs/architecture.md §20): a poll loop that claims queued Jobs over HTTPS, runs a provider
adapter and submits the result. Providers: `claude` (Claude Agent SDK), `codex` (`codex app-server`) and `fake`. Runs on Node 24 or Bun.

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
- `src/retention.ts`: `pruneRunData`, local Run data retention (see Local retention).
- `src/adapters/fake.ts`: exits after `FAKE_DELAY_MS` (default 50) with code 0 and summary
  `fake: handled inbox item <id>`; `FAKE_FAIL=1` exits 1. It is idempotent, so reconcile may simply start it again.
- `src/adapters/claude.ts`: one SDK `query()` per Run (see below).
- `src/adapters/codex.ts`: one `codex app-server` process and thread per Run (see Codex provider);
  `src/adapters/codexProtocol.ts` holds the hand-written protocol types it uses.
- `src/toolPolicy.ts`: the Bot tool policy as SDK options, the PreToolUse hook and the `canUseTool` approval gate
  (see Tool policy and approvals).
- `src/environments.ts`: `<state-dir>/environments.json`, environment name → local checkout root; `runCwd`, the
  per-Run cwd both real adapters use.
- `src/capabilities.ts`: `executorHeartbeat` builds the heartbeat body (§10.1): capabilities `bash` (always),
  `claude` (Claude provider configured; no probe), `codex` (Codex provider and a `codex` binary on `PATH`) and
  `env:<name>` per environment in `environments.json`; `capacity.background` = `--concurrency`. Bots match their
  `requiredCapabilities` against these.
- `src/main.ts`: `--api-url --token-file --state-dir [--once] [--concurrency N] --provider fake|claude|codex`
  (`node:util` `parseArgs`). `--concurrency N` (1..64, default 1) runs N worker loops in `runLoop`, each sequential,
  and reports N as the device's background capacity; the cloud refuses claims past it (409 `at_capacity`).

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
  "Replies to your requests". A Bot's final text is posted into a Channel or a `dm` conversation (DM-01) the same way, never into a bot pair.
  A thread Run (THREAD-01) posts into its thread; its prompt has "Earlier in the channel, before this thread
  (read-only context)" (`parentMessages`) and then "Thread (root message first)" instead of "Recent conversation".
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

## Codex provider

`codexAdapter` (CODEX-01; docs/architecture.md §13.4, §20.2, §20.4; gate G-08 passed 2026-10-11, see
docs/roadmap.md Status).

- **Protocol pin.** codex-cli **0.162.1**, `codex app-server` (v2 API), stdio: JSON-RPC 2.0 messages without the
  `"jsonrpc"` field, one per line. Methods used, taken from `codex app-server generate-ts --experimental` (not
  guessed): requests `initialize` (+ `initialized` notification), `config/read`, `thread/start`, `turn/start`,
  `turn/interrupt`; notifications `item/started`, `item/completed`, `turn/completed`; server requests
  `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/call`. Any other server
  request is answered with error `-32601` (an unanswered request would hang the turn). Other versions are
  untested; regenerate the bindings and recheck `adapters/codexProtocol.ts` before bumping.
- **Process.** `spawn("codex", ["app-server"], {cwd, env: process.env, detached: true})`: an argv array, never a
  shell string, in its own process group. The first transcript line is `{dir: "local", event: "spawn", pid,
spawnedAt, binary, argv}` (§20.2 PID + start identity). After the turn, stdin is closed and the process exits.
- **Thread.** `initialize` with `experimentalApi: true` (needed for `dynamicTools`), then `config/read {cwd}` for
  the user's MCP server names, then `thread/start {cwd, approvalPolicy: "untrusted", sandbox: "read-only",
developerInstructions: <system prompt>, config, dynamicTools}`. `config` switches off every configured MCP
  server (`mcp_servers.<name>.enabled = false`) and the features `hooks`, `apps`, `plugins`, `multi_agent`,
  `computer_use`, `browser_use` and `memories` for this thread, the counterpart of the Claude adapter's
  `settingSources: []`. The cwd rule is the Claude adapter's (`runCwd`). `thread.id` → `runtime.run.started`
  `{providerSessionId}`. One `turn/start` with the same user prompt as the Claude adapter.
- **Transcript journal.** Every inbound and outbound protocol message is appended to
  `<state-dir>/transcripts/<runId>.jsonl` as `{dir: "in" | "out", msg}` and fsynced before it is processed or
  written to the process (serialized; a failed write fails the Run). Two inbound messages are journaled redacted,
  because the transcript is uploaded: the `config/read` result (the user's whole Codex config, including MCP
  server env and headers) keeps only the MCP server names, and `account/rateLimits/updated` (credit balance) keeps
  no params. Uploaded by the same uploader with provider `codex`. Codex also keeps its own rollout under
  `CODEX_HOME`.
- **Approvals.** With `untrusted` + read-only sandbox, Codex asks before every command it does not consider safe
  and before every file change. A command approval goes through the same approval gate as Claude's `canUseTool` as
  action `Bash` with input `{command, cwd}`; a file change as `Edit` with `{file_path: <paths>, changes}` (paths
  from the `fileChange` item of `item/started`; a path outside the cwd is declined without asking). `allow` →
  `accept`, `ask` → cloud approval → `accept` / `decline`, `deny` → `decline` without the cloud. An approved
  command runs outside the read-only sandbox (as the executor's OS user).
- **Hive tools.** The same tools as the Claude adapter (`src/tools.ts`), offered as experimental `dynamicTools`
  (JSON Schema from the Zod shapes) and answered in this process on `item/tool/call` (arguments validated with Zod
  first), so the Run capability never reaches Codex. `hive_wait_for_reply` → `turn/interrupt` and a `waiting`
  exit (`{dir: "local", event: "waiting"}` is journaled for a restart).
- **Results.** `turn/completed` `completed` → exit 0, the last `final_answer` agent message (else the last agent
  message) as summary (≤ 8 KiB) and reply; `failed` / `interrupted` → exit 1 with the turn error. The process
  closing before the turn ends → exit 1 `codex app-server exited (code, signal)`; a missing binary → `spawn
failed: ...`.
- **Stop.** `requestStop` aborts a pending approval poll (→ `decline`) and sends `turn/interrupt`; after 5 s
  without exit, SIGTERM to the process group, after 5 s more SIGKILL. No signal is sent after the process closed
  (the PID may be reused).
- **Restart.** A transcript that already holds `turn/completed` is reused without spawning; otherwise a new
  process and thread start (no `thread/resume` yet).
- **Auth.** The process inherits `process.env`; `CODEX_HOME` (default `~/.codex`) selects the Codex login (G-08
  used the ChatGPT login). With a per-profile shell wrapper run `CODEX_HOME=<profile dir> hive executor run
--provider codex`. `codex` must be on `PATH`.
- **Capabilities (`describe`).** All false: no resume, no steering, no native child identity, and
  `enforceToolApproval: false`: under `untrusted` Codex may run a command it classifies as safe without an
  approval request, even when Bash is `deny`. That classification is Codex's, not hive's (in G-08 even `ls`, run
  as `zsh -lc ls`, asked).

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
- **Retention.** The local transcript file is kept until the retention sweep (see Local retention).

## Local retention

`pruneRunData(stateDir)` (LOG-01) runs once when `hive executor run` starts, before the journal is opened and the
loop reconciles, so nothing appends meanwhile. Rules, with a 30-day cutoff:

- **Pruned Run.** Its journal has a `claim`, its last `result` is not `stale_generation`, and an `uploaded` entry
  after that result was journaled more than 30 days ago (its `at`). Its `transcripts/<runId>.jsonl`, its
  `runs/<runId>/` scratch dir and its journal lines are deleted. Never pruned: an active Run (no result), an
  unconfirmed `stale_generation`, a Run pending upload, a `missing` Run (the uploader skips it, so it is never
  `uploaded`), anything the journal does not know.
- **Session journals.** `sessions/<sessionId>[.<subpath>].jsonl` is deleted when no remaining transcript names that
  session in `system/init` and the file was last written more than 30 days ago. The cloud keeps the uploaded snapshot,
  so a later resume `load`s it from there.
- **Journal compaction.** After the deletions, `journal.jsonl` is rewritten without the pruned Runs' lines (and
  without a torn last line) to `journal.jsonl.tmp`, fsynced and renamed over it. A crash before the rename leaves the
  old journal; the next start prunes the same Runs again.
- A failing sweep is logged and the executor starts anyway. The standalone `src/main.ts` does not run it.

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

## Effect tools

`hive_slack_post {integrationId?, channel, text, threadTs?}` and `hive_github_comment {integrationId?, owner, repo,
issueNumber, body}` (`src/tools.ts`; docs/architecture.md §19) are offered only for kinds the Bot's
`toolPolicy.effects` allows or asks. Each sends `effect.prepare` and polls `GET /v1/run/effects/:id` every 2 s until
the effect is `succeeded` (returns `{effectId, state, externalUrl?}`), `failed` (an error text with the reason) or
`unknown` (returns the state and a note not to post again; the cloud reconciles). While a human approval is pending
the effect stays `prepared` and the Run is `waiting_approval` through the cloud's approval path. The Run's stop
aborts the wait. The provider response never reaches the model. Codex gets the same tools as `dynamicTools`.

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
`test/codex.test.ts` drives the Codex adapter against `test/fakeCodex.mjs`, a scripted app-server spawned with
`process.execPath` (happy path, journaling order, approvals, deny, outside paths, stop, kill, crash, hive tools);
`test/tools.test.ts` covers the hive tools and the `waiting` exit; `test/retention.test.ts` the retention rules on a
fake state dir; `test/toolPolicy.test.ts` the SDK options, the
path hook, the approval gate and the environment cwd; the end-to-end
loop against the real Hono app runs in `apps/api-worker/test/executor.test.ts` (workerd).

## Known gaps

- No process supervisor: the adapter runs in-process; no PID / start identity in the journal, so reconcile can only
  resume idempotent adapters.
- Transcripts are uploaded after the Run, not streamed while it runs; no artifact upload and no SessionStore
  adapter (G-07), so no cross-device resume. A failed upload is retried only at the
  next start.
- No OS sandbox and no Bash path restriction. External writes are brokered only through `hive_slack_post` /
  `hive_github_comment`: a GitHub or Slack token reachable from Bash bypasses the broker's duplicate prevention
  (§19), and nothing warns about it yet. A Run
  resumed by reconcile has no capability, so no hive tools and every `ask` tool is denied.
- Only `runtime.run.started` and `runtime.run.stopped` are observed; no usage / cost or other runtime events are
  sent to the cloud. The fake adapter sends no `runtime.run.started`, so its Runs stay `starting`.
- Stop confirmation trusts the in-process adapter: with a real process supervisor it must check the process (PID +
  start identity) before confirming. A long-running loop confirms a stale Run only when its own renewal hits
  `STALE_GENERATION`; a Run journaled by an earlier process is confirmed at the next start.
- No scheduler / offers or WebSocket: the executor polls. Capacity is one Run at a time.
- Codex: no same-device `thread/resume` and no cross-PC resume (§13.4: a new thread with the current context);
  the user's `AGENTS.md`, skills and model defaults from `CODEX_HOME` still apply; commands Codex classifies as safe
  may bypass approvals; `dynamicTools` is an experimental protocol field; token usage is only in the transcript.
