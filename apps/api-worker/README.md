# @hive/api-worker

The Access-protected API Worker (Hono on Cloudflare Workers, D1 binding `DB`). See
[docs/architecture.md §18 and §22](../../docs/architecture.md#18-authentication-authorization-secrets-21).

## Routes

| Route                                                           | Auth                                   | Purpose                                                                                         |
| --------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /healthz`                                                  | none                                   | Liveness                                                                                        |
| `GET /v1/me`                                                    | Access assertion (user)                | Returns the user principal (CLI login check)                                                    |
| `POST /v1/commands`                                             | Access assertion (user)                | Command intake (see below)                                                                      |
| `GET /v1/operations/:id`                                        | Access assertion (user)                | Receipt of the user's command; for `agent.send` also the inbox item, routing status and Job id  |
| `GET /v1/jobs/:id`                                              | Access assertion (user)                | A Job in one of the user's Workspaces, with `cancelRequestedAt` and its root `runs`             |
| `GET /v1/inbox?botId=`                                          | Access assertion (user)                | The Bot's inbox items (first 100, no cursor yet)                                                |
| `GET /v1/channels?workspaceId=`                                 | Access assertion (user)                | Channels the user is a member of, with the main `conversationId` (max 500)                      |
| `GET /v1/channels/:id/messages`                                 | Access assertion (user)                | Newest-first messages of a member channel (limit 1..200, default 50; 404 if not a member)       |
| `GET /v1/bots?workspaceId=`                                     | Access assertion (user)                | Bots of the Workspace (max 500)                                                                 |
| `GET /v1/bot-conversations?workspaceId=`                        | Access assertion (user)                | `bot_pair` conversations with both Bots and their last 20 messages (max 100); see Bot messaging |
| `GET /v1/devices?workspaceId=`                                  | Access assertion (user)                | Devices of the Workspace, no credentials (max 500)                                              |
| `GET /v1/jobs?limit=&state=`                                    | Access assertion (user)                | Newest-first Jobs (limit 1..200, default 50), optionally of one state                           |
| `GET /v1/routines?workspaceId=`                                 | Access assertion (user)                | Routines of the Workspace with their schedule (max 500); see Routines below                     |
| `GET /v1/projects?workspaceId=`                                 | Access assertion (user)                | Projects of the Workspace (max 500)                                                             |
| `GET /v1/tasks?workspaceId=&projectKey=&status=`                | Access assertion (user)                | Tasks with computed `display` and `prerequisites` (max 500); see Work below                     |
| `GET /v1/tasks/:id`                                             | Access assertion (user)                | A Task with prerequisites, dependents, Results and Jobs                                         |
| `GET /v1/subscriptions?workspaceId=`                            | Access assertion (user)                | Subscriptions of the Workspace with their spec (max 500); see Subscriptions below               |
| `GET /v1/approvals?workspaceId=&state=`                         | Access assertion (user)                | Newest-first approvals (max 100), optionally one state; see Tools and approvals                 |
| `GET /v1/sync/changes?cursor=`                                  | Access assertion (user)                | Permitted changes after the cursor (limit 1..500, default 100); see Sync below                  |
| `GET /v1/realtime?workspaceId=`                                 | Access assertion, or device Bearer     | WebSocket upgrade to the Workspace's Realtime DO; see Realtime below                            |
| `POST /v1/run/commands`                                         | `Authorization: Bearer cap.<run>.<s>`  | Run command intake for the in-run hive tools; see Bot messaging                                 |
| `GET /v1/run/me`                                                | `Authorization: Bearer cap.<run>.<s>`  | The Run principal (`RunPrincipal`)                                                              |
| `GET /v1/run/tasks/:id`                                         | `Authorization: Bearer cap.<run>.<s>`  | A Task of the Run's own Task's Project (`task.read`; 403 otherwise)                             |
| `GET /v1/run/approvals/:id`                                     | `Authorization: Bearer cap.<run>.<s>`  | The Run's own approval at its generation (`ApprovalStatus`), polled by the executor             |
| `GET /v1/executor/me`                                           | `Authorization: Bearer <device-token>` | Returns the device principal                                                                    |
| `POST /v1/executor/pump`                                        | `Authorization: Bearer <device-token>` | Runs the outbox pump and time-driven work once; returns counts (see Outbox pump)                |
| `POST /v1/executor/commands`                                    | `Authorization: Bearer <device-token>` | Executor command intake (see below)                                                             |
| `POST /v1/executor/heartbeat`                                   | `Authorization: Bearer <device-token>` | Sets `devices.last_heartbeat_at` and requeues its `waiting_device` Jobs (no receipt)            |
| `GET /v1/executor/jobs?state=queued&limit=`                     | `Authorization: Bearer <device-token>` | Queued Jobs in the device's Workspace it is eligible for (limit 1..100, default 50)             |
| `GET /v1/executor/runs/:id`                                     | `Authorization: Bearer <device-token>` | The device's own Run: state, generation, `active` (startup reconcile)                           |
| `GET /v1/executor/jobs/:id/context?runId=&executionGeneration=` | `Authorization: Bearer <device-token>` | Run context for the adapter's prompt (see Executor commands)                                    |
| `POST /v1/executor/observations`                                | `Authorization: Bearer <device-token>` | Runtime observations: `runtime.run.started`, `runtime.run.stopped`                              |

- **User auth.** `Cf-Access-Jwt-Assertion` is verified with `jose` against
  `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (issuer `https://<ACCESS_TEAM_DOMAIN>`, audience
  `ACCESS_AUD`), or against `ACCESS_DEV_JWKS` in local dev (below). `(issuer, sub)` maps to a `users` row, created on first login with the email claim.
- **Device auth.** The token is `<deviceId>.<secret>`. Only SHA-256(secret) is stored in `device_credentials`; it
  is compared in constant time, and a revoked credential or device is rejected.
- **Commands.** The envelope `{operationId, idempotencyKey, workspaceId, command}` and command schemas live in
  `@hive/contracts`. Membership of `workspaceId` is required (403 otherwise). Each command runs inside
  `withOperationReceipt`, so a replay with the same key returns the stored response and a different payload under
  the same key is 409 `IDEMPOTENCY_CONFLICT`.
- **Command types:** `workspace.create`, `device.register`, `device.revoke`, `channel.create`, `bot.create`,
  `agent.send`, `event.emit`, the Work commands, the Subscription / integration commands, the Routine commands,
  `job.cancel` / `job.resolve` below, and `bot.update`, `device.environment.register`, `approval.resolve` (Tools and
  approvals).
- **Actors.** A user's `actors` row is created by `workspace.create` together with the membership (the only path
  that creates a membership today), unique per `(workspace_id, user_id)`. Messages and channel membership use it.
- **`channel.create`** creates the channel, its main conversation and an `owner` channel membership for the caller.
  **`bot.create`** creates the Bot and its actor; it joins no channel. A duplicate name is 422. Optional
  `instructions` (≤ 64 KiB, default `""`) is the Bot's system prompt for its runs.
- **`agent.send`** requires channel membership (403) and a Bot in the Workspace (404). One batch commits the
  Message, the `agent.message.sent` Event, the Bot's inbox item (lane = channel, purpose `agent.send`,
  `delivery_mode` wake/notify), an `event.route` outbox row and the receipt. The response has `jobId: null` and
  `routingStatus: "pending"`; the Job appears after routing (`GET /v1/operations/:id`).
- **`event.emit`** takes `{event: {type, subject?, data, occurredAt?}}` (data ≤ 64 KiB of JSON). Users may emit
  only `custom.*` (403 otherwise). One batch commits the Event, an `event.route` outbox row and the receipt.
- **`device.register` returns the plaintext token once.** The receipt stores the response with
  `deviceToken: null`; only the first execution adds the token. A lost token means registering a new device.
- **`workspace.create` is a dev bootstrap.** It is allowed only for a user with no memberships; the envelope's
  `workspaceId` becomes the new Workspace and the caller its owner.
- **Errors** use the `ApiError` shape and `apiErrorStatus` from `@hive/contracts`. Every response carries an
  `X-Request-Id` header (`cf-ray`, or a generated UUID), which error bodies repeat as `requestId`.

## Executor commands

`POST /v1/executor/commands` takes the same envelope as `/v1/commands` with the command schemas from
`@hive/contracts` (`ExecutorCommand`). The envelope's `workspaceId` must be the device's Workspace (403). The
`idempotencyKey` is the receipt key passed to `claimJob` / `finishRun`.

- **`job.claim {jobId, expectedRevision, resourceKeys?}`.** The Job must be in the device's Workspace (404) and the
  placement must allow the device (403 `FORBIDDEN`, `reason: "not_eligible"`). Then `claimJob` commits the Job CAS,
  root Run, Execution, reservations and receipt in one batch with a 90 s lease. `resourceKeys` defaults to
  `["bot:<botId>"]`, so one Bot runs one root Run at a time (a simplification of §7.3's per-binding concurrency).
  Returns `{runId, executionId, executionGeneration, leaseExpiresAt, capability, job: {id, botId, inboxItemId,
placement}}` (capability: see Bot messaging).
  Failures: `stale_revision` / `already_claimed` → 409 `REVISION_CONFLICT`, `resource_busy` → 409 `RESOURCE_BUSY`;
  the error body carries `reason`. Job state is checked by the CAS, not before it, so a replay of a successful claim
  returns the stored response. A `waiting_device` Job is claimable like a `queued` one (the claiming device is
  evidently online).
- **Eligibility.** A non-empty `allowedDeviceIds` is always intersected, whatever the `mode` (§10.2: safety
  constraints are intersected); an empty list means any device of the Workspace. `GET /v1/executor/jobs` applies
  the same filter in code. Revoked devices are already rejected by device auth.
- **`run.lease.renew {runId, executionGeneration}`.** Fenced by run + device + generation (`renewLease`); a stale
  fence is 409 `STALE_GENERATION`. No receipt: renewing twice is harmless. Returns `{leaseExpiresAt,
cancelRequested}`; `cancelRequested` is true once a user sent `job.cancel` for the Job.
- **`run.result.submit {runId, executionGeneration, state, summary ≤ 8 KiB, error?}`.** `finishRun` stores the
  summary / error on the Run and, in the same batch, sets the Job's trigger inbox item (`jobs.trigger_key =
inbox:<id>`) to `processed` (succeeded) or `failed`, plus the `run.finished` outbox row. A stale fence is 409
  `STALE_GENERATION`; a replay with the same key returns `{ok: true}` again. Optional `reply {conversationId,
text}` inserts a message from the Bot's actor (`client_message_id = run:<runId>`) plus its `change_log` row
  (`channel:<id>`) in the same batch. The reply must go to the trigger inbox item's Conversation (403 otherwise),
  so a Task Job without an item cannot reply. `reply` is not part of the receipt digest: a replay with the same
  key and a different reply is accepted as a replay and inserts nothing. A `failed` result for a Job with a cancel
  request finishes `cancelled`: Run and Job `cancelled`, Execution `interrupted`, inbox item `failed`, no Task
  Result.

Executor reads and observations, outside the command envelope:

- **`GET /v1/executor/jobs/:id/context?runId=&executionGeneration=`.** Fenced like a renew: the Run must be this
  device's (404 otherwise), of this Job (404) and active at that generation (409 `STALE_GENERATION`). Returns
  `{bot: {id, name, instructions}, task: {key, title, description} | null, conversation: {id, channelId, recent}
| null, inboxItem: {id, body} | null}`. `recent` is the Conversation's last 20 messages, oldest first, as
  `{actorKind, actorId, body, createdAt}`. The item body is the trigger message's text, else the event's data JSON.
  A batch Job (`jobs.inbox_batch_id`) has `inboxItem: null` and `batch: {id, items: [{id, body}]}` (oldest
  first); its `conversation` is the batch lane's. `run.result.submit` then settles every batch member and may
  reply in that Conversation.
- **`POST /v1/executor/observations {runId, executionGeneration, kind, payload}`.** `runtime.run.started`:
  `payload.providerSessionId` goes to `runs.provider_session_id`, `started_at` is set once and a `starting` Run
  becomes `running`, with the same fence (409 when stale, 422 when missing). `runtime.run.stopped` with
  `payload.confirmed: true` (422 otherwise) confirms that the agent of an `unknown` Run is gone: the Run and its
  Execution become `interrupted` and its reservations are released, in one guarded batch (`confirmRunStopped`). It
  is fenced by run + device + generation, 200 again for an already terminal Run, 404 for another device's Run and
  409 `reason: "not_unknown"` for a Run that is still active. Any other `kind` returns 202 and is dropped.

## Recovery

docs/architecture.md §9.1, §9.3, §10.4. Lease expiry is not proof of a stop, so nothing is re-run automatically.

- **Lease expiry** (pump, `expireLeases`): an active Run whose lease expired becomes `unknown` and its `active` Job
  `recovery_required`, one guarded batch per Run. `result_error` is `lease_expired_before_start` when no
  `runtime.run.started` arrived (AT-14, "unknown after launch intent") and `lease_expired` otherwise (AT-13). The
  reservations stay, so the Bot's next Job is `resource_busy` until the stop is confirmed. The old executor's renew
  / result / context calls are 409 `STALE_GENERATION` from then on (AT-15).
- **`job.resolve {jobId, action: retry | cancel | mark_failed}`** (user) only for a `recovery_required` Job (409
  `reason: "job_<state>"` otherwise). `retry` needs every root Run of the Job terminal, i.e. the `unknown` Run's
  stop confirmed by `runtime.run.stopped`; until then 409 `RESOURCE_BUSY` `reason: "unconfirmed_stop"`. It queues
  the Job again (revision + 1, cancel request cleared); the next claim, by any eligible device, gets generation + 1
  (AT-12). `cancel` → `cancelled`, `mark_failed` → `failed`; the `unknown` Run keeps its reservations until its
  stop is confirmed.
- **`job.cancel {jobId}`** (user): a `queued` / `waiting_device` Job becomes `cancelled` at once; an `active` Job
  gets `cancel_requested_at` and stays `active` until the executor sees `cancelRequested` on renewal, stops the agent
  and submits `failed` (finished as `cancelled`, see `run.result.submit`). Other states are 409 (a
  `recovery_required` Job goes through `job.resolve`). Both commands are revision CASes with a receipt.
- **`waiting_device`** (pump, `parkOfflineJobs`): a `queued` Job whose non-empty `allowedDeviceIds` are all offline
  (no heartbeat within 45 s = 3 × 15 s, or revoked) becomes `waiting_device` (AT-30). A heartbeat of one of those
  devices returns it to `queued` (`resumeWaitingJobs`, one batch with the change rows). Both bump the revision, so
  the executor claims with the revision it just listed. A Job with an empty `allowedDeviceIds` (any device) is never
  parked.

## Routines

docs/architecture.md §17.2. A Routine (`routines`) names a Bot, input text, an optional Conversation (lane and reply
target) and Task, a schedule and a misfire policy. It creates Inbox items and Jobs; it never calls a model.

- **Schedule.** `{kind: "cron", expr, timezone}` (5 fields, numbers / `*` / lists / ranges / steps, an IANA zone;
  `@hive/contracts` `cron.ts`) or `{kind: "once", at}`. `next_fire_at` is the next UTC occurrence. A local time in a
  DST gap is skipped; a repeated local time fires once.
- **Tick** (pump, `fireDueRoutines`): every enabled Routine with `next_fire_at <= now` gets, in one guarded batch,
  its occurrences (`routine_occurrences`, UNIQUE (routine, schedule_revision, scheduled_at)), each with a
  `routine.fired` Event (source `routine`, never routed), an Inbox item (purpose `routine`, lane = Conversation or
  `routine:<id>`) and a queued Job (`trigger_key = inbox:<item>`, like every Inbox-triggered Job, so the run context
  and result settle the item; the body is the input text), and `next_fire_at` advanced by a CAS on
  (schedule_revision, next_fire_at). A duplicate tick loses the CAS or the UNIQUE and creates nothing (AT-31).
- **Misfire.** `coalesce` (default) runs only the latest due occurrence; `skip` runs those at most 5 minutes late.
  The others are recorded `skipped` (the latest 50). A fired `once` has no next occurrence.
- **Commands** (receipts as usual): `routine.create {botId, name, schedule, inputText, conversationId?, taskId?,
misfire?}` (Conversation membership as for Subscriptions), `routine.update {routineId, expectedRevision, name?,
schedule?, inputText?, misfire?}` (revision CAS; a new schedule bumps `schedule_revision` and restarts from now),
  `routine.pause`, `routine.resume` (restarts from now, no catch-up) and `routine.run` (manual: an occurrence at now
  through the same statements; the schedule is not advanced).

## Work

Projects, Tasks and explicit Task Jobs (docs/architecture.md §4). Every Task edit carries the Task's
`expectedRevision`. State conditions (revision, status, readiness, a Result for the scope) sit in a guarded
`UPDATE tasks` inside the command batch, not in a pre-check, so a replay with the same key returns the stored
receipt and a concurrent change rolls the batch back; the failure is then re-read and named in `reason`.

- **`project.create {key, name}`.** `key` is `[A-Z][A-Z0-9]{1,9}`, UNIQUE per Workspace (422 if taken).
- **`task.create {projectKey?, parentTaskId?, title, description?, priority?, completionPolicy?}`.** Needs
  `projectKey` or `parentTaskId` (422); a subtask stays in its parent's Project (422 if `projectKey` differs). The
  key `<projectKey>-<n>` comes from `projects.task_counter`, advanced by CAS in the same batch; a concurrent create
  in the same Project gets 409 `REVISION_CONFLICT` (`reason: "concurrent_create"`, retryable). Returns
  `{taskId, key}`. `completionPolicy` defaults to `declaration`; the others are stored but cannot complete yet.
- **`task.assign {taskId, assignee: {kind: user|bot, id} | null, expectedRevision}`.** The Bot or Workspace member
  must exist (404).
- **`task.plan {taskId, addPrerequisites, removePrerequisites, expectedRevision}`.** Removes, then adds start
  dependencies. A cycle through dependencies or the hidden parent/child completion relation (`wouldCreateCycle`,
  AT-18) is 422 `reason: "cycle"`. Bumps `scope_revision`.
- **`task.complete {taskId, expectedRevision}`.** `declaration` policy only: needs a `succeeded` Task Result for
  the current `scope_revision`. Otherwise 422 with `reason` `no_result`, `unsupported_policy` or
  `invalid_status`.
- **`task.cancel {taskId, expectedRevision}`.** `pending` / `in_progress` → `cancelled`. Running Jobs are not
  stopped.
- **`job.start {taskId, botId, deviceId?}`.** One batch moves a `pending` Task to `in_progress` (only if every
  prerequisite is `completed`: 422 `blocked`; 422 `invalid_status` for a completed / cancelled Task) and queues a
  Job with `task_id` and trigger key `task:<taskId>:<scope_revision>:<n>` (n = prior Jobs of the Task + 1). The
  placement is the Bot's policy; with `deviceId` it is pinned to that device, which must be inside the Bot's
  non-empty `allowedDeviceIds` (422 `not_eligible`) and not revoked (404). Returns `{jobId, taskId, triggerKey}`.
- **Executor side.** `job.claim` copies `jobs.task_id` and the Task's `scope_revision` into the Execution.
  `run.result.submit` on such a Run inserts an immutable `task_results` row (state, summary, the Execution's scope
  revision) in `finishRun`'s batch. It never changes the Task status: Run success is not Task completion (AT-16).
  The Execution still goes `finished` / `failed`, not the design's `submitted`.
- **Display states.** `GET /v1/tasks` and `/v1/tasks/:id` add `display`: the status, or `ready` / `blocked` while
  `pending` (`displayState`); a cancelled prerequisite blocks (AT-17). Never stored.

## Subscriptions

Bot Subscriptions decide which Bot inbox an event reaches (docs/architecture.md §6.4, §17.1). Only users manage
them for now: there is no Bot principal yet. Every change bumps `revision` and copies the row into the immutable
`subscription_revisions` in the same batch.

- **`subscription.create {botId, integrationId?, eventTypes, filter?, destination, delivery?, expiresAt?}`.**
  `eventTypes` are exact types or `prefix.*` globs (1..20). `filter` is the AST from `@hive/contracts`
  (`FilterExpression`: `and / or / not / eq / neq / in / contains / prefix` over a fixed field list, depth ≤ 4,
  ≤ 32 nodes, rejected at parse with 422); omitted, it matches every event of `eventTypes`. `destination`
  `{conversationId, projectId?, taskId?}`: the Conversation must be in the Workspace (404) and the caller a member
  of its Channel (403); Project / Task must exist (404). `delivery` `{mode: notify|wake|batch, debounceMs = 10000,
maxBatchItems = 30, ttlSeconds = 86400}` (`ttlSeconds` is stored, not enforced). The Bot and `integrationId`
  must exist (404). Returns `{subscriptionId, revision: 1}`.
- **`subscription.update {subscriptionId, expectedRevision, eventTypes?, filter?, destination?, delivery?,
expiresAt?, enabled?}`.** Replaces the given fields under a revision CAS (409 `REVISION_CONFLICT`, `reason:
"stale_revision"`). `enabled: true` resumes a paused Subscription.
- **`subscription.pause {subscriptionId}`** sets `enabled = 0` (a no-op when already paused).
  **`subscription.delete {subscriptionId}`** removes the row; revisions, pending inbox items and Jobs stay.
- **`subscription.test {subscriptionId, limit = 50}`** is a dry-run: it evaluates the Subscription over the
  Workspace's last `limit` (≤ 200) events and returns `{evaluated, matched: [{eventId, type, receivedAt}]}`. It
  writes nothing, not even a receipt.
- **`integration.create {kind: github|slack, externalAccountId?}`** adds an `integration_installations` row and
  returns `{integrationId, hookPath}` for `apps/integration-worker`. `externalAccountId` is the app's own
  provider account (the Slack bot user id), whose posts are never routed (AT-27).

Routing (in the pump) for any event other than `agent.message.sent`:

- Candidates are the Workspace's enabled Subscriptions with no `expires_at` in the past. One matches when an
  `eventTypes` pattern matches, its `integration_id` is null or the event's, and the filter is true for the
  envelope (`type`, `source.kind`, `subject`, `data`).
- Matches collapse to one recipient per (Bot, lane), lane = destination Conversation (§6.2): one
  `event_deliveries` row with purpose `subscription` and every matched id in `matched_subscription_ids`, one inbox
  item and at most one Job. When the matched Subscriptions' modes differ, `wake` beats `batch` beats `notify`.
- `wake` queues a Job (`inbox:<itemId>`), `notify` only stores the item. `batch` joins the (Bot, lane)'s open
  `inbox_batches` row, opening one with `seal_at = now + debounceMs` and `max_items = maxBatchItems`. After each
  pump pass, batches past `seal_at` or at `max_items` are sealed with ONE Job (`batch:<batchId>`,
  `inbox_batch_id`); items arriving later open the next batch.
- All recipients of one event are committed with the consumer receipt in one batch. No match writes the receipt
  only (matched = 0, AT-06).

## Sync

The list, sync and realtime routes take the Workspace as `?workspaceId=` (required; 403 if the principal is not a
member).

- **Change log.** Every batch that changes a client-visible entity appends one `change_log` row per entity
  (`appendChange`, `packages/db`), so a rolled-back command leaves none:

  | Command / step                             | Rows (scope)                                                             |
  | ------------------------------------------ | ------------------------------------------------------------------------ |
  | `workspace.create`                         | workspace (workspace)                                                    |
  | `device.register` / `device.revoke`        | device (workspace)                                                       |
  | `channel.create`                           | channel, conversation (channel)                                          |
  | `bot.create`                               | bot (workspace)                                                          |
  | `agent.send`                               | message, inbox item (channel)                                            |
  | event route                                | inbox item (channel), Job (workspace) for `wake`                         |
  | `job.claim`                                | Job, Run (workspace)                                                     |
  | `run.result.submit`                        | Run, Job (workspace), trigger inbox item (its channel)                   |
  | `project.create`                           | project (workspace)                                                      |
  | `task.create / assign / complete / cancel` | task (workspace)                                                         |
  | `task.plan`                                | task, task_dependency `<prereq>:<dependent>` upsert / delete (workspace) |
  | `job.start`                                | Job, task (workspace)                                                    |
  | `subscription.*` (not `test`)              | subscription, delete on `delete` (workspace)                             |
  | `integration.create`                       | integration (workspace)                                                  |
  | event route via Subscriptions              | inbox item (destination channel), Job (workspace) for `wake`             |
  | batch seal (pump)                          | Job (workspace)                                                          |
  | `run.result.submit` of a Task Job          | also task_result (workspace)                                             |

  `run.lease.renew` and heartbeats are not logged. `event.emit` logs nothing itself (events are not a synced
  entity). Rows carry no payload: clients refetch the entity.

- **Cursor.** Opaque to clients; today base64url of the JSON `{workspaceId, epoch, seq}`. `epoch` is
  `workspaces.auth_epoch`. An undecodable cursor, one from another Workspace, or one whose epoch is not current is
  410 `CURSOR_EXPIRED`: bootstrap again.
- **`GET /v1/sync/changes`** returns `{changes: [{seq, entityKind, entityId, op, revision, scope, createdAt}],
cursor, hasMore}`. It scans `limit` rows after the cursor, drops rows outside the caller's scopes
  (`workspace:<id>` plus `channel:<id>` of each channel the user is a member of) and returns the last _scanned_
  seq, so a page of hidden rows still advances (§12.3).
- **Bootstrap.** Without `cursor` the response is `{changes: [], cursor: <head>, hasMore: false}`. Take that cursor
  first, then read current state through the list routes, then follow `sync/changes` from the cursor, comparing
  `revision` / `seq` so older data never overwrites newer.

## Realtime

`src/realtime.ts`: one Durable Object per Workspace (`idFromName(workspaceId)`, binding `REALTIME`) using the
WebSocket Hibernation API. It holds connections only, never state (ADR-04); every message is a refetch hint.

- **Upgrade.** `GET /v1/realtime?workspaceId=` with `Upgrade: websocket` (otherwise 422). The Worker
  authenticates: a `Authorization: Bearer <device-token>` header selects device auth, else the Access assertion.
  It then computes the socket's scopes (user: as for sync; device: `workspace:<id>`) and forwards a fresh request
  to the DO with the principal in `X-Hive-Principal`. The DO rejects a connect request without it (403); DOs are
  reachable only through the binding, and the Worker never forwards client headers. Scopes are fixed at upgrade.
- **Messages.** `{"type":"sync.changed","workspaceId","cursor","scopes"}` goes to sockets whose scopes intersect
  the change, carrying only the intersecting scopes; `cursor` is the head cursor when the hint was sent.
  `{"type":"job.available","workspaceId"}` goes to device sockets when routing queued a Job. Clients send nothing.
- **Notify path.** After a non-replayed command, executor command or routed event, the Worker calls the DO's
  `/notify` inside `waitUntil`. A failure is logged and dropped (§12.2): clients reconcile over HTTP.
- **Executor.** `apps/executor` still polls `GET /v1/executor/jobs`; it does not open the socket yet.

## Outbox pump

`src/pump.ts` acquires ready outbox rows (lease 60 s) and routes `event.route` rows:

- `agent.message.sent`: one batch writes the consumer receipt, an `event_deliveries` row, links the existing
  inbox item to it and, for `wake`, inserts a `queued` Job with trigger key `inbox:<inboxItemId>`.
- Any other event: Subscription routing (see Subscriptions above); no match writes only the consumer receipt.
- Then due Inbox batches are sealed into one Job each, due Routines fire, expired leases are recovered and Jobs of
  offline devices are parked (see Recovery and Routines). The response is `{processed, dead, sealed, routineJobs,
expired, parked}`; the last two count Workspaces.
- Routing twice is a no-op (consumer receipt PK; UNIQUE trigger key as backstop). A failed row keeps its lease
  and is retried when it expires; after 5 attempts it is marked `dead`. Topics without a consumer yet
  (`run.finished`) are marked `sent`.

It runs from the `scheduled()` cron trigger (every minute) and from `POST /v1/executor/pump`.

## Bot messaging

Bot-to-bot requests (docs/architecture.md §8, §18.2; AT-03, AT-26, AT-29).

- **Run capability.** `job.claim` also returns `capability: {token, expiresAt}` with `token = cap.<runId>.<secret>`;
  `run_capabilities` stores SHA-256(secret), the generation, the scopes and `expires_at` = lease expiry + 5 min, in
  the claim batch. Like a device token it is returned once: a replayed claim has `capability: null`. `run.lease.renew`
  extends `expires_at`; `run.result.submit` revokes it. Auth (`auth/run.ts`) requires the hash, not revoked, not
  expired and the Run still active at that generation; anything else is 401. Scopes: `agent.send`, `agent.reply`,
  `task.read`, plus `task.write` for a Task Job. The principal's `hop` is its trigger item's, its `correlationId`
  the Job's (or the Job id when it has none).
- **`POST /v1/run/commands`**, same envelope; the receipt is keyed by the Run.
  - `agent.send {recipientBotId | recipientBotName, message: {kind: request | notification, text},
replyToMessageId?}`. The sender is the Run's Bot. The message goes to the pair's private conversation
    (`conversations.kind = 'bot_pair'`, id `botpair:<botId>:<botId>`, created by the first message), with
    `hop = run hop + 1`, `job_id` = the Run's Job; an Event (correlation = the chain's), the recipient's Inbox item and
    an Outbox row follow in the same batch, and the pump routes it like a user's `agent.send`: a `request` wakes the
    recipient (Job with the same `correlation_id`), a `notification` is recorded only. 422: `self_send`,
    `hop_limit` (hop > 4) and, for a request, `budget_exceeded` (20 Jobs already share the correlation).
  - `agent.reply {requestMessageId, text}`: only the recipient of a Bot's request (404 otherwise). A `response`
    message with `reply_to_message_id` in the same conversation, an Inbox item for the requester (`agent.reply`) and,
    if its Job is `waiting_input` for that request, the Job back to `queued` (revision + 1).
  - `task.create / assign / plan / complete`: the user handlers, only with `task.write` and inside the Project of the
    Run's own Task (403 otherwise).
- **Waiting (AT-29).** `run.result.submit {state: "waiting", waitingFor: {requestMessageId}}` (a request this Job sent;
  422 `unknown_request` otherwise; 422 `already_replied` when the reply predates this Run, which would loop): the Run `succeeded`, Execution `finished`, reservations released, Job
  `waiting_input` with `waiting_for_message_id`, or `queued` at once when the reply already arrived. Its Inbox items
  stay pending. The successor Run (next claim, new generation) gets the original `inboxItem` plus `replies` in its
  context; its final result settles the trigger item and the reply items.
- **Why a backing Channel.** A bot pair is backed by a member-less Channel row with the same id instead of a nullable
  `conversations.channel_id`: rebuilding `conversations` fails on D1 once messages reference it (D1 cannot switch
  foreign keys off, and a renamed parent rewrites its children's REFERENCES). Its rows use the `workspace:<id>` scope.

## Tools and approvals

Bot tool policy, device environments and the approval broker (docs/architecture.md §10.1, §19; TOOLS-01, AT-35).

- **Tool policy.** `bots.tool_policy` is `{tools: {Read|Grep|Glob|Edit|Write|Bash: allow|ask|deny}, cwdMode:
run_scratch|environment}`; a missing tool is `deny`, and the default (`{tools: {}, cwdMode: "run_scratch"}`) denies
  every native tool. `bot.create {toolPolicy?}` sets it; `bot.update {botId, expectedRevision, instructions?,
toolPolicy?}` replaces the given fields with a CAS on `config_revision` (409 `stale_revision`) and a `bot` change
  row. The run context carries `bot.toolPolicy` and `environment` (the Job's placement `environmentId`). The
  executor reads the policy once per Run, so an update never widens a running one.
- **Environments.** `device.environment.register {deviceId, name, repository}` on the caller's own unrevoked device
  (404 otherwise) upserts `device_environments` (unique per device + name; re-registering replaces `repository`).
  Only the name and the repository identity are stored: the checkout root stays in the executor's
  `environments.json`. A Bot's `placementPolicy.environmentId` names an environment; its Jobs are listed and
  claimable (`not_eligible` otherwise) only by devices that registered that name, so the same environment on PC1 and
  PC2 makes both eligible.
- **`approval.request`** (run command, `POST /v1/run/commands`): `{actionKind (tool), argsHash (SHA-256 hex of the
canonical tool input), argsSummary (≤ 2 KiB), cwdLabel}`. One batch inserts a `pending` approval bound to the Run,
  its generation, Job and Bot, `expires_at` = now + 10 min (roadmap §1), moves the Run to `waiting_approval` (fenced
  on generation; the lease and the capability keep renewing) and writes `approval` + `run` change rows (scope
  `workspace:<id>`, so a realtime hint follows). The raw tool input never reaches the cloud. Each call is a new
  approval; none is reused for another call.
- **`approval.resolve {approvalId, decision: allow | deny, reason?}`** (any member of the Workspace): one CAS
  `pending → approved | denied` that also requires `expires_at > now` and the requesting Run still active at the
  approval's generation. A second resolve is 409 `approval_<state>`; a Run that is no longer current (lease expired,
  finished, replaced by a newer generation) is 409 `STALE_GENERATION`; a timed-out one is 409 `approval_expired`.
  `resolved_by` is the user. The Run goes back to `running` in the same batch once it has no pending approval left.
- **Expiry.** The pump sweeps `pending` approvals past `expires_at` (`decision_reason: timeout`) or whose Run is not
  current (`run_not_current`) to `expired`, which the executor treats as deny, and resumes their Run
  (`approvalsExpired` counts Workspaces).

## Known gaps

- **No Queues yet.** The design (docs/architecture.md §6.1, §6.3) hands outbox rows to Cloudflare Queues and
  routes in a Queue consumer. The cron pump does both in-process, so routing lag is up to a minute without a
  manual pump.
- **Pump scope.** `POST /v1/executor/pump` lets any device pump every Workspace's outbox (it returns counts only).
- **Owner actor for older dev Workspaces.** Workspaces created before migration `0001_event_routing` have no
  owner actor row, so `channel.create` / `agent.send` return 403 there until one is inserted.
- **Inbox scoping.** `GET /v1/inbox` is scoped to the user's Workspaces, not to channel membership.
- **Inbox `handled`.** The design's terminal inbox state `handled` (§7.1) is stored as the schema's `processed`;
  changing the CHECK values makes drizzle-kit rebuild `inbox_items`, which is left for the inbox state work.
- **Executor.** No process supervisor (the fake adapter runs in-process), no R2 upload of transcripts or
  artifacts, and there is no scheduler / offer or notification: executors poll `GET /v1/executor/jobs`. A page of that list is filtered after `LIMIT`, so it
  may hold fewer than `limit` eligible Jobs.
- **Sync / realtime.** No scope revocation: no command removes a member, so nothing bumps `auth_epoch` or closes
  sockets whose scopes shrank (§12.4); add it with the member commands. Socket scopes are computed once at
  upgrade, so a channel joined later needs a reconnect, and they live in the socket attachment (16 KiB cap, about
  350 channels). The list routes are bounded but not paginated. G-04
  (Access + WebSocket from native clients) is not executed. Notify hints are sent per request, not batched.
- **Work.** Only the `declaration` completion policy; no `task.replan`, delegation, `task_holds`, Git/PR collector
  or Task-scoped Realtime / sync scopes (all Work rows use `workspace:<id>`). `task.plan` reads the Workspace's whole
  graph and its CAS covers only the edited Task, so two concurrent plans on different Tasks can still close a
  cycle (`workspaces.control_revision`, §11.2, does not exist yet). `task.cancel` does not stop Jobs. Task lists
  are bounded at 500 without a cursor.
- **Subscriptions.** No Bot principal, so Bots cannot manage their own Subscriptions (§17.1 gives them
  `subscription.*`); no policy / approval for widening scope. A batch is a fixed window from its first item, not a
  sliding debounce, and it can briefly exceed `max_items` until the next pump pass seals it. `ttlSeconds` and
  `destination.projectId / taskId` are stored only (Jobs carry no Task). `subscription.test` sees every event of
  the Workspace, including echoes that never route. No `append` mode. `data.keyword` is in the filter field list
  but no normalizer fills it yet, so a filter on it never matches.
- **Recovery.** Every recovery is manual: `placement.recovery: "safe_auto"` is stored but treated as `manual`.
  Expired leases are swept by the pump, so detection lags up to a minute plus the 90 s lease. A cancelled `queued`
  Job leaves its trigger inbox item `pending`. A cancel request on an `active` Job whose lease then expires still
  goes `recovery_required`. Parking applies only to Jobs that name devices: Jobs with an empty `allowedDeviceIds` are never parked, even with no device online.
- **Routines.** No `bounded_catch_up`, concurrency, retry or approval settings; a tick enumerates at most 1440 missed
  occurrences and records the latest 50 as `skipped` (a longer outage restarts from now). Bots cannot manage
  Routines (user principal only); `routine.update` cannot change the Bot, Conversation or Task. A Task Routine's
  Job carries the Task but does not move it to `in_progress` or check readiness like `job.start`. No sync change
  row when only `next_fire_at` advances.
- **Bot messaging.** No `task.delegate` / delegation table, no approval for external effects, no reply policy or
  deadline (a request nobody answers leaves the requester `waiting_input` until `job.cancel`), no per-conversation
  token / time budget. The chain budget is checked before the batch, so concurrent requests can overshoot it
  slightly. Limits are fixed at the roadmap defaults (no user setting yet).
- **Tools and approvals.** No `effects` table / external-write broker (§19); no approver policy (any member may
  resolve); `argsSummary` is the device's redaction (the Bash command with the cwd replaced by `<cwd>`), visible to
  every member, so a command line holding a secret is shown. No Slack / mobile approvals. Environment repository
  identity is not compared across devices, and no environment list route exists. `approval.request` uses a fresh
  idempotency key per call and the executor never retries it, so a lost response leaves an orphan `pending` approval
  (and the Run `waiting_approval`) until the 10 min expiry.
- **Bot channel membership.** `agent.send` does not require the recipient Bot to be a member of the channel;
  `bot.create` adds no membership.

## Local development

`wrangler.jsonc` has a **placeholder `database_id`** (all zeros) until the owner provisions D1
(`bunx wrangler d1 create hive`) and replaces it. Local dev uses a local D1 and does not need the real id.

`apps/api-worker/.dev.vars` (gitignored) fills the vars left empty in `wrangler.jsonc`. For local dev without
Access in front, let `scripts/dev-token.ts` write it:

```sh
cd apps/api-worker
bun scripts/dev-token.ts --dev-vars > .dev.vars  # ACCESS_TEAM_DOMAIN, ACCESS_AUD, ACCESS_DEV_JWKS
bunx wrangler d1 migrations apply hive --local   # applies packages/db/migrations
bunx wrangler dev --local
export HIVE_ACCESS_JWT=$(bun scripts/dev-token.ts)  # 12 h dev assertion for the hive CLI
```

- **`ACCESS_DEV_JWKS`** (optional, `.dev.vars` only, **never** in `wrangler.jsonc` or a deployed Worker): a JSON
  Web Key Set. When set, user assertions are verified with `createLocalJWKSet` against it instead of the Access
  certs; issuer and audience are still checked. Anyone holding the matching private key can sign in as anyone.
- **`scripts/dev-token.ts`** generates an ES256 keypair once into `apps/api-worker/.dev-keys.json` (gitignored,
  mode 0600) and reuses it. `--dev-vars` prints the three `.dev.vars` lines; otherwise it prints a JWT (iss
  `https://<ACCESS_TEAM_DOMAIN>`, aud `ACCESS_AUD`, `--sub` default `dev`, `--email` default `dev@example.test`,
  12 h). It reads `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` from the environment, defaulting to the values `--dev-vars`
  writes. `mintDevToken` is exported for `test/devToken.test.ts`.
- **With real Access** (G-02 not executed yet): put `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` in `.dev.vars` without
  `ACCESS_DEV_JWKS`, then get an assertion with `cloudflared access login <api url>` and
  `cloudflared access token -app <api url>`.
- `wrangler dev` does not fire the cron trigger, so the outbox is routed by `POST /v1/executor/pump`, which
  `hive executor run` calls before each poll.

## Tests

`bun run test` from the repo root runs `test/` in miniflare with the `packages/db` migrations applied.
`test/cli.test.ts` drives the Phase 1 loop through the `hive` CLI's command functions (`@hive/cli/commands`);
`test/devToken.test.ts` covers the `ACCESS_DEV_JWKS` path. `test/work.test.ts` covers Projects, Tasks, the DAG
(AT-17, AT-18), `job.start`, Task Results (AT-16) and completion; `test/cli.test.ts` also runs project → task →
job start → executor → task complete. `test/sync.test.ts` covers the change rows of the Phase 1 commands (`test/work.test.ts` those of the Work commands), sync paging
and expiry, the list routes, and real WebSocket fan-out through the Realtime DO (two user sockets with different
scopes plus a device socket).
