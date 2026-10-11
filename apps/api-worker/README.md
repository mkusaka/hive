# @hive/api-worker

The Access-protected API Worker (Hono on Cloudflare Workers, D1 binding `DB`). See
[docs/architecture.md §18 and §22](../../docs/architecture.md#18-authentication-authorization-secrets-21).

## Routes

| Route                                                            | Auth                              | Purpose                                                                                                                                                                                        |
| ---------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                                   | none                              | Liveness                                                                                                                                                                                       |
| `GET /v1/me`                                                     | Access assertion (user)           | Returns the user principal (CLI login check)                                                                                                                                                   |
| `POST /v1/commands`                                              | Access assertion (user)           | Command intake (see below)                                                                                                                                                                     |
| `GET /v1/operations/:id`                                         | Access assertion (user)           | Receipt of the user's command; for `agent.send` also the inbox item, routing status and Job id; for `message.post` `jobIds` (one per mention, null until routed)                               |
| `GET /v1/jobs/:id`                                               | Access assertion (user)           | A Job in one of the user's Workspaces, with `cancelRequestedAt` and its Job `runs`                                                                                                             |
| `GET /v1/runs/:id`                                               | Access assertion (user)           | A Run of the user's Workspaces: state, generation, device, `persistence`, started / finished, result, `hasProviderSession`, transcript parts and watermark, `git` (or null)                    |
| `GET /v1/runs?workspaceId=&kind=job\|native_child\|external`     | Access assertion (user)           | Newest-first Run metadata; external sessions are visible only to their device owner or a Workspace owner                                                                                       |
| `GET /v1/runs/:id/transcript?cursor=`                            | Access assertion (user)           | Normalized, redacted transcript, one confirmed part per page; channel member or owner (404 otherwise); see Transcripts                                                                         |
| `GET /v1/transcripts/:runId/raw`                                 | Access assertion (user, owner)    | The confirmed raw JSONL parts concatenated (`application/x-ndjson`); never indexed                                                                                                             |
| `GET /v1/inbox?botId=`                                           | Access assertion (user)           | The Bot's inbox items (first 100, no cursor yet)                                                                                                                                               |
| `GET /v1/channels?workspaceId=`                                  | Access assertion (user)           | Channels the user is a member of, with the main `conversationId`, `topic` and `memberCount` (max 500)                                                                                          |
| `GET /v1/sidebar?workspaceId=`                                   | Access assertion (user)           | The caller's own sidebar document `{workspaceName, prefs: {pinned, hidden, groups}, revision}`; the empty default at revision 0 when none                                                      |
| `GET /v1/channels/:id/presence?workspaceId=`                     | Access assertion (user)           | Members only: each member Bot's `state` from its Jobs triggered in the Channel: `working` (active), `reading` (queued / waiting_device), `idle` (ROUTE-02)                                     |
| `GET /v1/channels/:id/members`                                   | Access assertion (user)           | The channel's members (`role` owner / member / viewer), with `actorId`, `name`, `userId`, `botId`, and `canManage` (404 if not a member)                                                       |
| `GET /v1/users?workspaceId=`                                     | Access assertion (user)           | Workspace members for Channel membership pickers: `{users:[{id,label}]}`                                                                                                                       |
| `GET /v1/dms?workspaceId=`                                       | Access assertion (user)           | The caller's direct messages by Bot name: `id` = `conversationId`, `botId`, `name`, `createdAt`, `lastMessage` (as on channels)                                                                |
| `GET /v1/conversations/:id/messages?workspaceId=&limit=`         | Access assertion (user)           | A DM's or a thread's messages, newest first (who may read the DM / the thread's parent, 404 otherwise); a thread's response adds `root` (its root message)                                     |
| `GET /v1/threads?participant=me&workspaceId=`                    | Access assertion (user)           | Threads the caller started or replied in (max 50, newest reply first): `conversationId`, `channelId`, `channelName`, `parentConversationId`, `parentKind`, `root`, `replyCount`, `lastReplyAt` |
| `GET /v1/channels/:id/messages`                                  | Access assertion (user)           | Newest-first messages of a member channel (limit 1..200, default 50; 404 if not a member)                                                                                                      |
| `GET /v1/bots?workspaceId=`                                      | Access assertion (user)           | Bots with `skills`, `createdByBotId`, configuration revision and workspace-owner `canManage` (max 500)                                                                                         |
| `GET /v1/bot-conversations?workspaceId=`                         | Access assertion (user)           | `bot_pair` conversations with both Bots and their last 20 messages (max 100); see Bot messaging                                                                                                |
| `GET /v1/devices?workspaceId=`                                   | Access assertion (user)           | Devices of the Workspace, no credentials (max 500)                                                                                                                                             |
| `GET /v1/jobs?limit=&state=`                                     | Access assertion (user)           | Newest-first Jobs (limit 1..200, default 50), optionally of one state                                                                                                                          |
| `GET /v1/routines?workspaceId=`                                  | Access assertion (user)           | Routines of the Workspace with their schedule (max 500), optionally of one `botId` / `conversationId`; see Routines below                                                                      |
| `POST /v1/hooks/routines/:routineId`                             | `X-Hive-Signature` (HMAC-SHA256)  | Public signed Routine webhook; JSON ≤ 64 KiB, optional `X-Hive-Delivery` dedupe for seven days, 60/minute/routine                                                                              |
| `GET /v1/projects?workspaceId=`                                  | Access assertion (user)           | Projects of the Workspace (max 500)                                                                                                                                                            |
| `GET /v1/tasks?workspaceId=&projectKey=&status=`                 | Access assertion (user)           | Tasks with computed `display` and `prerequisites` (max 500); see Work below                                                                                                                    |
| `GET /v1/tasks/:id`                                              | Access assertion (user)           | A Task with prerequisites, dependents, Results, Jobs and the `git` rollup of its Runs                                                                                                          |
| `GET /v1/subscriptions?workspaceId=`                             | Access assertion (user)           | Subscriptions of the Workspace with their spec (max 500); see Subscriptions below                                                                                                              |
| `GET /v1/approvals?workspaceId=&state=`                          | Access assertion (user)           | Newest-first approvals (max 100), optionally one state; see Tools and approvals                                                                                                                |
| `GET /v1/effects?workspaceId=&state=&runId=`                     | Access assertion (user)           | Newest-first external effects (max 200), optionally one state / Run; see External effects                                                                                                      |
| `GET /v1/search?workspaceId=&q=&kinds=&limit=&cursor=`           | Access assertion (user)           | Full-text search over permitted scopes (limit 1..100, default 20); see Search and memory                                                                                                       |
| `GET /v1/memories?workspaceId=&scopeKind=&scopeId=`              | Access assertion (user)           | Live memories of one scope, newest first (max 200; channel needs membership)                                                                                                                   |
| `POST /v1/admin/search/rebuild?workspaceId=`                     | Access assertion (user, owner)    | Drops the Workspace's search documents and re-enqueues every source (AT-38)                                                                                                                    |
| `GET /v1/sync/changes?cursor=`                                   | Access assertion (user)           | Permitted changes after the cursor (limit 1..500, default 100); see Sync below                                                                                                                 |
| `GET /v1/realtime?workspaceId=`                                  | Access assertion, or device token | WebSocket upgrade to the Workspace's Realtime DO; see Realtime below                                                                                                                           |
| `GET /v1/audit?workspaceId=&cursor=&kinds=&actor=&since=&limit=` | Access assertion (user)           | Descending command metadata and durable lifecycle facts (default 50, max 200); `kinds` is exact comma-separated kinds, `actor` is an exact actor id, and cursor pagination keys by `(at,id)`   |
| `GET /v1/status?workspaceId=`                                    | Access assertion (user)           | Cheap health aggregates for sync, outbox, search, Jobs, effects, devices and overdue routines; owners see all, members see readable source/conversation aggregates                             |
| `POST /v1/run/commands`                                          | `X-Hive-Token: cap.<run>.<s>`     | Run command intake for the in-run hive tools; see Bot messaging                                                                                                                                |
| `GET /v1/run/me`                                                 | `X-Hive-Token: cap.<run>.<s>`     | The Run principal (`RunPrincipal`)                                                                                                                                                             |
| `GET /v1/run/tasks/:id`                                          | `X-Hive-Token: cap.<run>.<s>`     | A Task of the Run's own Task's Project (`task.read`; 403 otherwise)                                                                                                                            |
| `GET /v1/run/approvals/:id`                                      | `X-Hive-Token: cap.<run>.<s>`     | The Run's own approval at its generation (`ApprovalStatus`), polled by the executor                                                                                                            |
| `GET /v1/run/effects/:id`                                        | `X-Hive-Token: cap.<run>.<s>`     | The Run's own effect (`Effect`), polled by the executor's effect tools                                                                                                                         |
| `GET /v1/run/search?q=&kinds=&limit=`                            | `X-Hive-Token: cap.<run>.<s>`     | Search within the Run's scopes (`search.read`; limit 1..50, default 10)                                                                                                                        |
| `GET /v1/executor/me`                                            | `X-Hive-Token: <device-token>`    | Returns the device principal                                                                                                                                                                   |
| `POST /v1/executor/pump`                                         | `X-Hive-Token: <device-token>`    | Runs the outbox pump and time-driven work once; returns counts (see Outbox pump)                                                                                                               |
| `POST /v1/executor/commands`                                     | `X-Hive-Token: <device-token>`    | Executor command intake (see below)                                                                                                                                                            |
| `POST /v1/executor/heartbeat`                                    | `X-Hive-Token: <device-token>`    | Body `{capabilities?, capacity?: {background}}`; sets `last_heartbeat_at`, stores what is given and requeues the `waiting_device` Jobs it can run (no receipt)                                 |
| `GET /v1/executor/jobs?state=queued&limit=`                      | `X-Hive-Token: <device-token>`    | Queued Jobs in the device's Workspace offered to it now by the placement rule (limit 1..100, default 50)                                                                                       |
| `GET /v1/executor/runs/:id`                                      | `X-Hive-Token: <device-token>`    | The device's own Run: state, generation, `active` (startup reconcile)                                                                                                                          |
| `GET /v1/executor/jobs/:id/context?runId=&executionGeneration=`  | `X-Hive-Token: <device-token>`    | Run context for the adapter's prompt (see Executor commands)                                                                                                                                   |
| `POST /v1/executor/observations`                                 | `X-Hive-Token: <device-token>`    | Runtime observations: `runtime.run.started`, `runtime.run.stopped`, `git.collected`                                                                                                            |
| `POST /v1/executor/external-runs`                                | `X-Hive-Token: <device-token>`    | Upserts this device's external Claude / Codex session metadata and returns `{runId, state}`                                                                                                    |
| `POST /v1/executor/uploads/init`                                 | device token or `cap.`            | Authorizes one transcript part `{runId, partSeq, byteSize, sha256, provider?, session?}` (`session: {sessionId, subpath?}` = a native session stream, needs `provider`); see Transcripts       |
| `PUT /v1/executor/uploads/:uploadId`                             | device token or `cap.`            | Raw part body (≤ 8 MiB): verify, store in R2, commit the manifest                                                                                                                              |
| `POST /v1/executor/uploads/complete`                             | device token or `cap.`            | `{runId, lastPartSeq, session?}` → `persistence: complete` (with `session`: the snapshot is complete), or 409 `gap`                                                                            |
| `GET /v1/executor/sessions/:provider/:sessionId?subpath=`        | `X-Hive-Token: <device-token>`    | Newest complete native session snapshot in the device's Workspace, raw JSONL; 404 when none                                                                                                    |

**`X-Hive-Token`.** Device tokens and Run capabilities travel in `X-Hive-Token`, because behind Cloudflare Access
with Managed OAuth `Authorization: Bearer` belongs to Access (it would try to resolve the token as its own OAuth
token). The Worker falls back to `Authorization: Bearer <token>` for local dev and older clients (`hiveToken` in
`src/auth/device.ts`). Behind Access, executors also send their Access Service Token (`CF-Access-Client-Id` /
`CF-Access-Client-Secret`, `infra/README.md`).

**External sessions.** `POST /v1/executor/external-runs` accepts `{provider, externalSessionId, cwd,
startedAt, lastActivityAt, repository, title, firstUserMessage?}` from a device token. Identity is
Workspace + device + provider + external session id. The Worker classifies a session as `finished` after
30 minutes without activity; external Runs never create Jobs, Executions, capabilities, leases, or recovery work.
`run.link_task {runId, taskId}` links a visible external Run to a same-Workspace Task. External metadata, normalized
transcripts, raw transcripts, Task external-session lists, and search results are private to the device owner or a
Workspace owner. The external uploader sends only normalized JSONL `{kind, text, toolName?}`; the Worker redacts it
again and indexes only the title and first user message.

- **User auth.** `Cf-Access-Jwt-Assertion` is verified with `jose` against
  `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (issuer `https://<ACCESS_TEAM_DOMAIN>`, audience
  `ACCESS_AUD`), or against `ACCESS_DEV_JWKS` in local dev (below). `(issuer, sub)` maps to a `users` row, created on first login with the email claim.
- **Device auth.** The token is `<deviceId>.<secret>`. Only SHA-256(secret) is stored in `device_credentials`; it
  is compared in constant time, and a revoked credential or device is rejected.
- **Commands.** The envelope `{operationId, idempotencyKey, workspaceId, command}` and command schemas live in
  `@hive/contracts`. Membership of `workspaceId` is required (403 otherwise). Each command runs inside
  `withOperationReceipt`, so a replay with the same key returns the stored response and a different payload under
  the same key is 409 `IDEMPOTENCY_CONFLICT`.
- **Command types:** `workspace.create`, `device.register`, `device.revoke`, `channel.create`, `channel.update`,
  `channel.join`, `channel.leave`, `channel.member.add` / `update` / `remove`, `dm.open`, `bot.create`,
  `agent.send`, `event.emit`, the Work commands, the Subscription / integration commands, the Routine commands,
  `job.cancel` / `job.resolve` / `run.link_task` below, `bot.update`, `device.environment.register`,
  `approval.resolve` (Tools and approvals), `memory.write` / `memory.delete` (Search and memory),
  `effect.resolve` (External effects) and `sidebar.update`.
- **Actors.** A user's `actors` row is created by `workspace.create` together with the membership (the only path
  that creates a membership today), unique per `(workspace_id, user_id)`. Messages and channel membership use it.
- **`channel.create`** creates the channel, its main conversation and an `owner` channel membership for the caller.
  **`channel.member.add {channelId, userId|botId, role}`**, **`channel.member.update`** and
  **`channel.member.remove`** require a Channel owner (or Workspace owner); the last owner cannot be demoted or
  removed. `viewer` members can read but cannot post, and viewer Bots are never woken.
  **`channel.update {channelId, topic}`** sets the topic (≤ 250 chars; empty or blank clears it); non-viewer
  members only (403), 404 for an unknown channel.
  **`bot.create`** stores optional `skills` (at most 20; each instructions field ≤ 8 KiB); optional skill policies
  are restrictions of the Bot policy. A Bot's `toolPolicy.manage` flags default false and only a Workspace owner may
  grant them through `bot.update`.
  `POST /v1/run/commands` acts as the Run's Bot, never an impersonated user. With the corresponding `manage` flag,
  it may manage only itself or Bots it created; created Channels add the Bot and Workspace owners as owners, and
  child Bots receive a no-wider policy with all `manage` flags false.
  **`sidebar.update {prefs, expectedRevision}`** replaces the caller's own sidebar document (`SidebarPrefs`: pinned /
  hidden `{kind: channel|bot, id}` lists and named groups, ≤ 64 KiB of JSON, also a SQL CHECK). Revision CAS:
  `expectedRevision` 0 creates it (a row already there fails on the primary key), otherwise a guarded conditional
  UPDATE; a stale revision is 409 `REVISION_CONFLICT`. Ids are not checked against Channels / Bots (clients skip
  unknown ones).
  **`bot.create`** creates the Bot and its actor; it joins no channel. A duplicate name is 422. Optional
  `instructions` (≤ 64 KiB, default `""`) is the Bot's system prompt for its runs.
- **`agent.send`** requires a non-viewer Channel member caller and a non-viewer Bot member (403 otherwise). One batch
  commits the Message, the `agent.message.sent` Event, the Bot's inbox item (lane = channel, purpose `agent.send`,
  `delivery_mode` wake/notify), an `event.route` outbox row and the receipt. The response has `jobId: null` and
  `routingStatus: "pending"`; the Job appears after routing (`GET /v1/operations/:id`).
- **`message.post`** `{channelId | conversationId, text, mentions?, replyToMessageId?}` requires non-viewer channel
  membership (403) or being the DM's user (404). It commits one Message (body kept with its `<@bot:ID>` tokens) and,
  per woken Bot, the `agent.send` request / `wake` delivery rows above (Event, inbox item, outbox), so routing creates
  one Job per Bot. In a Channel's main conversation (group chat, ROUTE-02) every non-viewer member Bot is woken;
  mentions narrow that to the mentioned non-viewer members, `<@everyone>` is every non-viewer member, and
  `replyToMessageId` (a message of the same conversation, 404 otherwise) on a Bot's message addresses that Bot
  only while it remains a non-viewer member. Those deliveries coalesce: a Bot with a queued / active Job triggered
  in the conversation gets no second Job (its inbox item stays for `since`), and the Run's result queues one
  follow-up Job when posts arrived while it worked. The response has `inboxItemIds` (empty: posted, nobody woken).
  An unknown Bot id in a token, or `mentions` not equal to the tokens, is 422. Run contexts show tokens as `@name`.
  Membership is explicitly managed; mentioning an unjoined or viewer Bot does not wake it or change its membership.
  In a DM the DM's Bot is always the one recipient; a mention of another Bot is 422.
  With **`threadOf`** (a message of that Channel / DM, else 404) the message goes to the root's thread
  (`thread-<rootMessageId>`, created by the first reply in the same batch) and every Bot that already took part in
  the thread (posted there or was delivered there) is woken too, mentioned or not. The response's `conversationId`
  is where the message landed. Change rows keep the parent's `channel:<id>` scope. Every message in a list carries
  `thread` (`conversationId`, `replyCount`, `lastReplyAt`, `participants` ≤ 5 actor ids) or null.
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
  placement must offer it to the device now (403 `FORBIDDEN`, `reason: "not_eligible"`, the message names the
  placement reason; 409 `RESOURCE_BUSY` `at_capacity` when the device is full). Then `claimJob` commits the Job CAS,
  root Run, Execution, reservations and receipt in one batch with a 90 s lease. `resourceKeys` defaults to
  `["bot:<botId>"]`, so one Bot runs one root Run at a time (a simplification of §7.3's per-binding concurrency).
  Returns `{runId, executionId, executionGeneration, leaseExpiresAt, capability, job: {id, botId, inboxItemId,
placement}}` (capability: see Bot messaging).
  Failures: `stale_revision` / `already_claimed` → 409 `REVISION_CONFLICT`, `resource_busy` → 409 `RESOURCE_BUSY`;
  the error body carries `reason`. Job state is checked by the CAS, not before it, so a replay of a successful claim
  returns the stored response. A `waiting_device` Job is claimable like a `queued` one (the claiming device is
  evidently online).
- **Placement** (`src/placement.ts`, pure; §9.2 step 1, §10.2). Constraints, always intersected: the device is in a
  non-empty `allowedDeviceIds`, `pinned` runs only on its single `preferredDeviceIds` entry, the `environmentId` is
  registered on the device and `requiredCapabilities` ⊆ the heartbeat's `capabilities` (reasons `not_allowed`,
  `environment_missing`, `capability_missing`). Rank: `preferredDeviceIds` in order, every other device after them
  (equal); `any` ranks none. Offer rule: a device that meets the constraints and has a free slot may take the Job
  unless a higher-ranked device that meets them blocks it: online with a free slot always does
  (`higher_ranked_online`), online and full does unless `overflowToFallback`, offline (no heartbeat within 45 s)
  does unless `fallbackOnUnavailable` (`fallback_disabled`). Capacity: the device's active root Runs (starting /
  running / waiting_approval / stopping) against `devices.capacity_background` (`at_capacity`). `GET
/v1/executor/jobs` filters by the rule and `job.claim` re-validates it (§9.2 step 3) for a `queued` /
  `waiting_device` Job; `claimJob` checks capacity again inside its batch. There is no offers table: the
  deterministic rank is the offer. Revoked devices are rejected by device auth and left out of the rank.
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
  key and a different reply is accepted as a replay and inserts nothing. A reply in a Channel's main conversation is
  a group post for the other member Bots (ROUTE-02): `@name` becomes a token, and each delivery carries `hop + 1` and
  the Job's correlation id; past 4 hops or 20 correlated Jobs it wakes nobody. `pass: true` (only with `succeeded`
  and no `reply`, else 422) posts nothing, sets `runs.outcome = 'pass'` and records a `runtime.run.passed` Event. In a
  Channel's main conversation the same batch queues the Bot's coalescing follow-up Job and settles the deliveries this
  Run read through `since`. A `failed` result for a Job with a cancel
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
  reply in that Conversation. In a Channel's main conversation the context also has `peers` (other member Bots with
  the first line of their instructions) and `since` (≤ 50 messages after this Bot's previous Run there, with
  `speakerKind`, `speakerName`, `isSelf`, `replyTo` quote); both are empty elsewhere.
- **`POST /v1/executor/observations {runId, executionGeneration, kind, payload}`.** `runtime.run.started`:
  `payload.providerSessionId` goes to `runs.provider_session_id`, `started_at` is set once and a `starting` Run
  becomes `running`, with the same fence (409 when stale, 422 when missing). `runtime.run.stopped` with
  `payload.confirmed: true` (422 otherwise) confirms that the agent of an `unknown` Run is gone: the Run and its
  Execution become `interrupted` and its reservations are released, in one guarded batch (`confirmRunStopped`). It
  is fenced by run + device + generation, 200 again for an already terminal Run, 404 for another device's Run and
  409 `reason: "not_unknown"` for a Run that is still active. `git.collected` (GIT-01, `GitCollected` payload, 422
  otherwise) stores what Git produced in the Run's environment checkout in `run_git`, fenced like `runtime.run.started`;
  the first stored row wins, so a repeat returns 200 and changes nothing. `GET /v1/runs/:id` returns it as `git`
  (`repository` `host/owner/repo`, `branch`, `before` / `after`, `commits`, `partial`, `prs`, `prError`), and
  `GET /v1/tasks/:id` rolls it up over the Task's Runs as `git: { commits, prs, repositories }` (distinct commit SHAs,
  PRs unique by URL). Any other `kind` returns 202 and is dropped.

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
- **`waiting_device`** (pump, `parkWaitingJobs`): a `queued` Job with a constraint (allowed devices, pinned,
  environment or capabilities) that no online device meets becomes `waiting_device` (AT-30, AT-22). A heartbeat of a
  device that meets the constraints returns it to `queued` (`setJobsWaitingDevice`, one batch with the change
  rows). Both bump the revision, so the executor claims with the revision it just listed. A Job without constraints
  is never parked, and a busy online device does not park one. `GET /v1/jobs/:id` carries `waitingReason`: for a
  `queued` / `waiting_device` Job no device can take now, `{code: "no_eligible_device", devices: [{deviceId,
reasons}]}` (constraint reasons plus `offline` / `at_capacity`), otherwise null.

## Routines

docs/architecture.md §17.2. A Routine (`routines`) names a Bot, input text, an optional Conversation (lane and reply
target) and Task, a schedule and a misfire policy. It creates Inbox items and Jobs; it never calls a model.

- **Schedule.** `{kind: "cron", expr, timezone}` (5 fields, numbers / `*` / lists / ranges / steps, an IANA zone;
  `@hive/contracts` `cron.ts`), `{kind: "once", at}`, `{kind: "webhook"}` or
  `{kind: "event", filter}` (the Subscription filter AST). Only timed triggers have `next_fire_at`.
  A local time in a DST gap is skipped; a repeated local time fires once.
- **Tick** (pump, `fireDueRoutines`): every enabled Routine with `next_fire_at <= now` gets, in one guarded batch,
  its occurrences (`routine_occurrences`, UNIQUE (routine, schedule_revision, occurrence_key); timed keys are
  `scheduled_at`), each with a
  `routine.fired` Event (source `routine`, never routed), an Inbox item (purpose `routine`, lane = Conversation or
  `routine:<id>`) and a queued Job (`trigger_key = inbox:<item>`, like every Inbox-triggered Job, so the run context
  and result settle the item; the body is the input text), and `next_fire_at` advanced by a CAS on
  (schedule_revision, next_fire_at). A duplicate tick loses the CAS or the UNIQUE and creates nothing (AT-31).
- **Misfire.** `coalesce` (default) runs only the latest due occurrence; `skip` runs those at most 5 minutes late.
  The others are recorded `skipped` (the latest 50). A fired `once` has no next occurrence.
- **Commands** (receipts as usual): `routine.create {botId, name, schedule, inputText, conversationId?, taskId?,
misfire?}` (Conversation membership as for Subscriptions), `routine.update {routineId, expectedRevision, name?,
schedule?, inputText?, misfire?}` (revision CAS; a new schedule bumps `schedule_revision` and restarts from now),
  `routine.pause`, `routine.resume` (restarts from now, no catch-up), `routine.run` (manual: an occurrence at now
  through the same statements; the schedule is not advanced) and `routine.delete` (the Routine and its occurrences in
  one batch; Jobs it created stay; 404 when missing).
- **Webhook (ROUTINE-02).** Creation, switching to a webhook trigger, and
  `routine.rotate_secret {routineId}` return a `secret` once and `hookPath`. Resolve the path against the API URL.
  List responses and operation receipts never disclose the secret; retrying a creation/rotation receipt cannot
  recover it. Sign the exact POST bytes using the displayed secret as the HMAC-SHA256 key and send
  `X-Hive-Signature: sha256=<lowercase hex>`. The secret is a prefixed encoding of 32 random bytes, longer than
  HMAC-SHA256's 64-byte block; its stored SHA-256 digest is the equivalent normalized HMAC key, not plaintext.
  Rotate to invalidate the old key. Auth does not use Access: deploy the custom-domain path bypass in
  `infra/README.md`. Disabled Routines return 409, bad signatures 401, oversized bodies 413 and the per-routine
  budget 429. Optional `X-Hive-Delivery` dedupes per Routine for seven days. JSON is stored as occurrence `payload`
  and appended to the Run's inbox text as a fenced JSON block after `inputText`.
- **Event (ROUTINE-02).** The existing event router evaluates enabled Routine filters as well as Subscriptions
  for `event.emit` and normalized integration events. An occurrence uses the same Inbox / Job path and dedupe /
  misfire rules. A Routine supplies `inputText`, Conversation and Task; a Subscription routes raw events.
  For example, `{kind: "event", filter: {op: "eq", field: "type", value: "custom.demo.ping"}}`.
  Users still emit only `custom.*`; changing trigger kinds through `routine.update` bumps `schedule_revision`.
  Event occurrence keys are `event:<eventId>`: retries collapse, but distinct events sharing a timestamp do not.
  `skip` records events routed more than five minutes after `received_at` as skipped; `coalesce` processes the
  matched event even after that delay. Webhook delivery ids may be reused after seven days because expiry applies
  to the delivery receipt, not the permanent occurrence history. Acceptance is fenced in the same D1 batch against
  pause, trigger replacement and secret rotation.

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
- **`task.delegate {taskId, toBotId, mode: read | write, instructions (≤ 8 KiB), deadline?, expectedRevision}`**
  (§8.1). Also a Run command. One batch writes a `delegations` row (`active`; Task `scope_revision`, delegator, from a
  Run its parent Run / Execution and `hop`), a queued Job for the receiving Bot (trigger key `delegation:<id>`,
  `jobs.delegation_id`, the Task, the Bot's placement, the delegating Run's `correlation_id`) and a Task CAS that changes
  no field but bumps the revision (409 `stale_revision`; 422 `invalid_status` for a closed Task). The assignee is not
  changed. From a Run the instructions are also a `delegation` message in the two Bots' `bot_pair` conversation, and the
  Run's Bot must be the Task's assignee or hold an active `write` delegation on it (403 `not_delegator`); 422
  `self_delegation`, `hop_limit` (hop > 4), `budget_exceeded` (20 correlated Jobs). One active delegation per (Task,
  Bot): 409 `already_delegated`. Returns `{delegationId, jobId}`.
- **`task.delegate.revoke {delegationId}`.** User only. `active` → `revoked` (409 `delegation_<state>` otherwise); the
  Job is cancelled at once, or gets a cancel request when it is `active`.
- **Delegated Runs.** The run context carries `delegation {id, mode, deadline, fromBot | fromUser, instructions}`
  and, from a Bot, the `bot_pair` conversation; the principal's hop is the delegation's. Task writes from a delegated
  Run need an active `write` delegation (403 `delegation_read_only`); reads work in both modes. Other Task Runs keep
  the Project rule below.
- **Delegation close** (pump, `settleDelegations`): an `active` delegation whose Job is `succeeded` / `failed` /
  `cancelled` (Run result, `job.cancel`, `job.resolve`) goes `completed` with `outcome_summary` `<job state>:
<last Run summary>`; a Bot delegator gets a `delegation_result` message from the receiver in the `bot_pair`
  conversation and a `notify` Inbox item (`delegation.result`, no Job); a user delegator sees the delegation's change
  row. Past `deadline` it goes `expired` and a Job not yet started is cancelled (an active Run is left alone). One
  guarded batch per delegation, so a repeat or a concurrent pump closes it once. `GET /v1/tasks/:id` lists
  `delegations`.
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
  | `channel.update`                           | channel (channel)                                                        |
  | `bot.create`                               | bot (workspace)                                                          |
  | `sidebar.update`                           | sidebar, entity id = the user (workspace)                                |
  | `agent.send`                               | message, inbox item (channel)                                            |
  | `message.post`                             | message, one inbox item per woken Bot (channel)                          |
  | event route                                | inbox item (channel), Job (workspace) for `wake`                         |
  | `job.claim`                                | Job, Run (workspace)                                                     |
  | `run.result.submit`                        | Run, Job (workspace), trigger inbox item (its channel)                   |
  | `project.create`                           | project (workspace)                                                      |
  | `task.create / assign / complete / cancel` | task (workspace)                                                         |
  | `task.plan`                                | task, task_dependency `<prereq>:<dependent>` upsert / delete (workspace) |
  | `job.start`                                | Job, task (workspace)                                                    |
  | `task.delegate`                            | task, Job, delegation, from a Run conversation and message (workspace)   |
  | `task.delegate.revoke`, delegation close   | delegation, Job; message, inbox item for a Bot delegator (workspace)     |
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
  authenticates: an `X-Hive-Token` header, or an `Authorization: Bearer` token without an Access assertion, selects
  device auth; else the Access assertion (a Bearer next to it is the user's OAuth token, already resolved by Access).
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
- Any other event: Subscription and event Routine routing (see above); no match writes only the consumer receipt.
- Then due Inbox batches are sealed into one Job each, due Routines fire, expired leases are recovered and Jobs of
  offline devices are parked (see Recovery and Routines), timed-out approvals expire and delegations are closed (see
  Work). The response is `{processed, dead, sealed, routineJobs, expired, parked, approvalsExpired, delegations}`; the
  last four count Workspaces.
- Routing twice is a no-op (consumer receipt PK; UNIQUE trigger key as backstop). A failed row keeps its lease
  and is retried when it expires; after 5 attempts it is marked `dead`. Topics without a consumer yet
  (`run.finished`) are marked `sent`.
- `search.index {sourceKind, sourceId}` rows are handled by the search indexer (see Search and memory).
- `effect.perform {effectId, attempt}` and `effect.reconcile {effectId, round}` rows are handled by the effect broker
  (see External effects). Provider errors never throw there, so the outbox retry never re-sends a write.

It runs from the `scheduled()` cron trigger (every minute) and from `POST /v1/executor/pump`.

## Bot messaging

Bot-to-bot requests (docs/architecture.md §8, §18.2; AT-03, AT-26, AT-29).

- **Run capability.** `job.claim` also returns `capability: {token, expiresAt}` with `token = cap.<runId>.<secret>`;
  `run_capabilities` stores SHA-256(secret), the generation, the scopes and `expires_at` = lease expiry + 5 min, in
  the claim batch. Like a device token it is returned once: a replayed claim has `capability: null`. `run.lease.renew`
  extends `expires_at`; `run.result.submit` revokes it. Auth (`auth/run.ts`) requires the hash, not revoked, not
  expired and the Run still active at that generation; anything else is 401. Scopes: `agent.send`, `agent.reply`,
  `task.read`, `memory.write`, `search.read`, plus `task.write` for a Task Job. The principal also carries its
  Conversation's `channelId` (memory and search scopes). The principal's `hop` is its trigger item's, its `correlationId`
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
    Run's own Task (403 otherwise); a delegated Run also needs an active `write` delegation.
  - `task.delegate`: see Work; the delegator is the Run's Bot.
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

## External effects

The effect broker (docs/architecture.md §19; EFFECT-01, AT-28, AT-40): a Bot's external writes are performed by this
Worker with the integration's credentials. Tokens never reach a device or a model. Code: `src/effects.ts`.

- **Policy.** `toolPolicy.effects` is `{"slack.post" | "github.comment": allow | ask | deny}`; a missing kind (and
  every Bot created before EFFECT-01) is `deny`.
- **`effect.prepare`** (run command): `{kind: "slack.post", integrationId?, request: {channel (conversation id), text,
threadTs?}}` or `{kind: "github.comment", integrationId?, request: {owner, repo, issueNumber, body}}`, request ≤ 32
  KiB. The installation must be in the Run's Workspace (404), of the kind's provider and enabled (422
  `integration_kind` / `integration_disabled`); without `integrationId` the Workspace's only enabled one is used (422
  `integration_ambiguous` for none or several). `deny` → 403 `effect_denied`. `ask` → the effect is `prepared` and
  the same batch inserts a pending approval (`action_kind` = the kind, `args_hash` = the request digest,
  `args_summary` = target + text ≤ 2 KiB, `cwd_label: cloud`) and moves the Run to `waiting_approval`, exactly like
  `approval.request`. `allow` → `approved` + `effect.perform` in the same batch. Response `{effectId, state,
approvalId}`. `request_digest` = SHA-256 of `{kind, integrationId, request}`; UNIQUE (run_id, request_digest)
  makes the same request twice from one Run return the existing effect (the tools' random idempotency keys would
  not dedupe it).
- **Approval.** `approval.resolve` on an effect approval moves the effect `approved` + `effect.perform` or `failed`
  (`approval_denied`) in its batch; the expiry sweep fails it with `approval_expired`.
- **Perform.** CAS `approved → executing` with `attempts = attempt` (`attempts + 1`; a duplicate message is a
  no-op). The first perform also needs the requesting Run active at the effect's generation, else `failed`
  `run_not_current` without a request (AT-40). The outbound object carries the operation marker `hive:<effectId>`:
  Slack `chat.postMessage` with `metadata: {event_type: "hive_effect", event_payload: {marker}}`; GitHub
  `POST /repos/{owner}/{repo}/issues/{n}/comments` with a trailing `<!-- hive:<effectId> -->`, after minting an
  installation token with an RS256 App JWT (`iat` −60 s, `exp` +9 min). 2xx → `succeeded` with `external_id` (Slack
  `ts`, GitHub comment id) and `external_url` (GitHub `html_url`; null for Slack). Definite errors (4xx except 408 /
  429, Slack `ok: false` errors) → `failed`, never retried. A network error, a 10 s timeout, 408, 429, 5xx or Slack
  `ratelimited / internal_error / fatal_error / service_unavailable / request_timeout` → `unknown`, never re-sent
  (§19), with `effect.reconcile` due in 30 s. A message redelivered after its handler died mid-perform also makes
  the effect `unknown`.
- **Reconcile.** Looks the object up by its marker among objects since `created_at` − 60 s: GitHub lists the issue's
  comments (`since`, 100 per page, ascending by id); Slack reads `conversations.replies` (thread) or
  `conversations.history` with `include_all_metadata`, which needs a `*:history` scope besides `chat:write`. Found →
  `succeeded`. Definitely absent → `approved` and performed again while `attempts < 3`, else it stays `unknown`
  (`resolve manually`). A failed lookup is retried with backoff (30 s × 2^round, 5 rounds), then left `unknown`.
- **`effect.resolve {effectId, action, externalId?, externalUrl?}`** (any member): `mark_succeeded` (needs
  `externalId`) / `mark_failed` an `unknown` effect; `retry` an `unknown` or `failed` effect that was performed at
  least once (an effect that was never approved cannot be retried). Wrong state → 409 `effect_<state>`.
- **Changes.** Every state change writes an `effect` change row (scope `workspace:<id>`).
- **Secrets.** Workers secrets (`.dev.vars` locally): `SLACK_BOT_TOKEN`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`
  (PKCS#8 PEM; GitHub downloads PKCS#1, convert with `openssl pkcs8 -topk8 -nocrypt -in app.pem`; `\n` escapes
  are accepted), `GITHUB_INSTALLATION_ID`. Unset → the kind fails with `... not configured`. They are
  environment-level: one Slack app and one GitHub App installation for every `integration_installations` row.

## Search and memory

D1 FTS5 search projection and explicit Memory (docs/architecture.md §13.5, §13.6, §14; SEARCH-01).

- **Indexing.** The batch that writes a message (`agent.send`, the Bot reply of `run.result.submit`, run
  `agent.send` / `agent.reply`), a Task (`task.create`, every Task CAS, `job.start`) or a memory enqueues
  `search.index {sourceKind, sourceId}`. The pump's indexer (`src/search.ts`) reads the source's current state and
  upserts its `search_documents` row only if `source_revision >= ` the indexed one (messages use `seq`, Tasks and
  memories `revision`), so an older read never overwrites a newer one. The FTS rows follow through triggers. A
  deleted memory becomes a tombstone (`deleted_at`, empty title / body); since the indexer only ever writes current
  state, a late `search.index` row cannot resurrect it (AT-39). No consumer receipt: the guarded upsert is
  idempotent. A cancelled Task stays indexed. Task documents are titled `<key> <title>`.
- **Scopes.** A message document has its Conversation's `channel:<id>` (a `botpair:` channel for bot-to-bot
  messages); a Task `workspace:<id>`; a memory `channel:<id>`, `bot:<id>`, `task:<id>`, or `workspace:<id>` for
  Workspace and Project memories. `permittedScopes(principal)` (`src/sync.ts`) is shared with sync: a user gets the
  Workspace and their channels, and search adds every `bot:` / `task:` scope (Bots and Tasks are Workspace-visible);
  a Run gets the Workspace, its Conversation's channel, its own `bot:` and its Task's `task:`.
- **`GET /v1/search`.** `q` of 3+ code points is matched with FTS5 `MATCH` as one quoted phrase (`"` doubled), never
  as FTS syntax, ranked by `bm25`, with `snippet()` (matches in `[` `]`, ≤ 200 characters). A shorter `q` (trigram
  needs 3) takes the short path: a `LIKE` substring match on title / body over the 200 newest permitted documents
  only, never an unbounded scan; that covers Task key prefixes. `kinds` defaults to `message,task,memory,run`. The
  response is `{hits: [{sourceKind, sourceId, title, snippet, scope, sourceRevision}], indexedThrough, cursor}`;
  `indexedThrough` is the Workspace's newest `indexed_at` (AT-32) and `cursor` an offset, set when the page is full.
  A hit's source must be re-fetched through its normal route; Task / Job state never comes from search.
- **`memory.write {scopeKind, scopeId, content (≤ 16 KiB), supersedesId?}`.** A user may write to the Workspace, a
  channel they are a member of (403) or an existing Project / Bot / Task (404). A Run (`memory.write` capability
  scope) may write only to its own Bot, its Task or its Conversation's channel; anything else, Workspace scope
  included, is 403 `scope_not_permitted`: promotion beyond the source's ACL needs policy (AT-33). One batch inserts
  the memory (revision 1), its `memory_revisions` copy, the `search.index` row and a `memory` change row (scope:
  the channel for a channel memory, else the Workspace). `supersedesId` (same scope only, 422 otherwise) tombstones
  the old memory in the same batch.
- **`memory.delete {memoryId, expectedRevision}`** (user, same scope rule): revision CAS to a tombstone (409
  `stale_revision`, 422 `deleted`), with its revision copy and `search.index` row. Content never changes, so a
  live memory is at revision 1.
- **Run context.** `memories`: up to 20 live memories of the Bot, the Task and the Conversation's channel, newest
  first, cut at 8 KiB. `related`: up to 5 hits for the trigger item's body within the Run's scopes, never the
  trigger message: its words of 3+ characters (split on whitespace and punctuation, at most 8) each quoted and
  ORed; a body without such a word gets none.
- **Rebuild** (`POST /v1/admin/search/rebuild`, Workspace owner, 403 otherwise): one batch deletes the Workspace's
  documents and enqueues a `search.index` row per message, Task and memory (`INSERT ... SELECT`); the pump indexes
  them 50 per pass. Other Workspaces are untouched (AT-38).

## Transcripts

Raw provider transcripts in R2 with a D1 manifest (docs/architecture.md §3.3, §9.1, §13.2; UPLOAD-01;
`src/transcripts.ts`). Binding `R2`, bucket `hive` (created by Terraform in
`infra/`; `wrangler dev` uses a local bucket).

- **Auth and fencing.** The upload routes take the device token, or a Run capability (`cap.` token) while the Run is
  active. The executor uses the device token, because the capability is revoked when the result is submitted. A
  device may upload only for its own Runs (`runs.device_id`), in any state: parts of a terminal or stale attempt are
  stored as its history (§10.3) and never change Job or Task state.
- **init** `{runId, partSeq ≥ 0, byteSize 1..8 MiB, sha256 (hex), provider?}` creates the Run's
  `transcript_streams` row on first use and returns `{uploadId, partId, committed}`. It stores nothing else: the
  upload id encodes the request, and PUT re-authorizes and re-verifies it. Same seq and hash again → the same answer
  (`committed: true` once stored); a different hash for a committed seq → 409 `IDEMPOTENCY_CONFLICT`.
- **PUT** the raw bytes. A body over 8 MiB, of the wrong size or the wrong SHA-256 is 422 (`size_mismatch`,
  `sha256_mismatch`) and nothing is stored. Otherwise the object is put at
  `workspace/<wsId>/transcript/<streamId>/<partSeq>` (never a client path) with `sha256`, so R2 verifies it too;
  then one batch inserts the `transcript_parts` row (with `entry_count` = JSONL lines) and recomputes
  `confirmed_through_seq`, the highest seq with every part from 0 present. A replay of a stored part is a no-op.
- **complete** `{runId, lastPartSeq}` (-1: empty transcript) sets `runs.persistence = complete` and writes a `run`
  change row when the watermark reached `lastPartSeq`; a gap is 409 `REVISION_CONFLICT` with reason `gap` and the
  missing seqs in the message (the Run stays `pending`); parts beyond `lastPartSeq` are 422. A new immutable part
  after a completed stream returns it to `pending`; the next complete ACK advances its stored `lastPartSeq`.
  Idempotent.
- **Reads.** `GET /v1/runs/:id` needs Workspace membership (like `GET /v1/jobs/:id`). The transcript needs a
  Workspace owner or a member of the Channel of the Run's trigger Conversation; a `bot_pair` Conversation, or a
  Job without one (Task, Routine, batch), is owner-only; anything else is 404. Each page is one confirmed part
  (`cursor` = part seq, `nextCursor` the next or null). Entries are
  `{seq, kind: system | assistant | tool_use | tool_result | user | result, text, toolName?}`: `seq` is the line
  number in the raw stream (blocks of one message share it); SDK messages of other types are skipped; `text` is
  redacted (`sk-`, `ghp_`, `xox?-`, `AKIA` tokens and PEM blocks → `[redacted]`) and then cut to 4 KiB. The raw
  route is owner-only and streams one part at a time.
- **Codex streams** (`provider: codex`, lines `{dir, msg}` from the executor's Codex adapter) map by
  `normalizeCodex`: `turn/start` → `user`; `item/completed` agent message → `assistant`, command execution →
  `tool_use` `Bash` + `tool_result`, file change → `tool_use` `Edit` + `tool_result`, dynamic / MCP tool call →
  `tool_use` (+ `tool_result`); approval requests and decisions, `thread/started`, `error` and the spawn line →
  `system`; `turn/completed` → `result`. Sub-agent items appear as `system` only with their explicit thread id
  (AT-20: never attributed to the Bot); unknown item types → `system` `item <type>`; deltas and status
  notifications are skipped.
- **Never indexed.** Neither the raw parts nor the normalized view go into `search_documents`.

## Known gaps

- **Effect generation fence.** Only an effect's first perform requires its Run to be active at the effect's
  generation (AT-40). A re-perform after reconcile proved the object absent, or a human `effect.resolve retry`, runs
  even after the Run ended, because the write was already authorized. Effect secrets are environment-level, not per
  installation.
- **No Queues yet.** The design (docs/architecture.md §6.1, §6.3) hands outbox rows to Cloudflare Queues and
  routes in a Queue consumer. The cron pump does both in-process, so routing lag is up to a minute without a
  manual pump.
- **Pump scope.** `POST /v1/executor/pump` lets any device pump every Workspace's outbox (it returns counts only).
- **Owner actor for older dev Workspaces.** Workspaces created before migration `0001_event_routing` have no
  owner actor row, so `channel.create` / `agent.send` return 403 there until one is inserted.
- **Inbox scoping.** `GET /v1/inbox` is scoped to the user's Workspaces, not to channel membership.
- **Inbox `handled`.** The design's terminal inbox state `handled` (§7.1) is stored as the schema's `processed`;
  changing the CHECK values makes drizzle-kit rebuild `inbox_items`, which is left for the inbox state work.
- **Transcripts.** No GC of R2 objects left by a PUT whose manifest commit failed, no 30-day retention sweep of raw
  transcripts (§6.1 of the roadmap), no artifacts, no SessionStore / `GET /v1/transcripts/:bindingId/manifest`
  restore path (G-07) and no cross-PC exact resume; encryption at rest is R2's default only. Two concurrent PUTs
  of different content for one uncommitted seq can overwrite each other's object (the executor never does that).
  The watermark is recomputed over all parts per commit. `GET /v1/runs/:id` has no Channel ACL (Workspace
  membership only). Normalized entries carry no timestamp (SDK messages have none).
- **Executor.** No process supervisor (the fake adapter runs in-process), no artifact upload, and there is no scheduler / offers table or notification: executors poll `GET /v1/executor/jobs`. A page of that list is filtered after `LIMIT`, so it
  may hold fewer than `limit` eligible Jobs. The pump parks at most 200 queued Jobs per sweep and a heartbeat resumes
  at most 200.
- **Placement.** No provider auth-profile shared budget (§10.2), no interactive vs background lanes (§7.3: only
  `capacity_background` exists and every root Run counts against it), no per-Bot concurrency beyond the `bot:<id>`
  reservation, and no `safe_auto` failover.
- **Sync / realtime.** No scope revocation: no command removes a member, so nothing bumps `auth_epoch` or closes
  sockets whose scopes shrank (§12.4); add it with the member commands. Socket scopes are computed once at
  upgrade, so a channel joined later needs a reconnect, and they live in the socket attachment (16 KiB cap, about
  350 channels). The list routes are bounded but not paginated. G-04
  (Access + WebSocket from native clients) is not executed. Notify hints are sent per request, not batched.
- **Work.** Only the `declaration` completion policy; no `task.replan`, `task_holds`, Git/PR collector
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
- **Delegation.** The receiver's authority is Workspace membership plus the assignee / `write`-delegate rule and the
  mode; Bots have no pause state and Channel / Project ACL is not built, so neither is checked. No resource scope,
  reservations or requirement versions beyond `scope_revision`; the assignee rule applies to delegated Runs and to
  `task.delegate` only, not to every Task Run. A `write` delegate's own write delegation being revoked does not
  narrow the delegations it made. Closing and expiry lag up to a pump tick; an expired delegation's active Run keeps
  running. No Run-side revoke.
- **Bot messaging.** No approval for external effects, no reply policy or
  deadline (a request nobody answers leaves the requester `waiting_input` until `job.cancel`), no per-conversation
  token / time budget. The chain budget is checked before the batch, so concurrent requests can overshoot it
  slightly. Limits are fixed at the roadmap defaults (no user setting yet).
- **Tools and approvals.** No `effects` table / external-write broker (§19); no approver policy (any member may
  resolve); `argsSummary` is the device's redaction (the Bash command with the cwd replaced by `<cwd>`), visible to
  every member, so a command line holding a secret is shown. No Slack / mobile approvals. Environment repository
  identity is not compared across devices, and no environment list route exists. `approval.request` uses a fresh
  idempotency key per call and the executor never retries it, so a lost response leaves an orphan `pending` approval
  (and the Run `waiting_approval`) until the 10 min expiry.
- **Search and memory.** G-06 is executed on miniflare only (2026-10-11): trigram tokenizer, Japanese substrings,
  external-content triggers, short-query fallback, ACL and rebuild; real D1 (tokenizer, triggers, export of the
  virtual table) is pending. No NFKC projection, summaries / compaction jobs, memory promotion policy, extracted
  memory candidates, `memory.propose` / `memory.promote`, index lag metrics, or `search_document_scopes` table (one
  scope per document). The cursor is an offset, so concurrent indexing can shift pages. Rebuild is one batch over
  the whole Workspace, and documents are one chunk per source. `related` uses a plain word split, so a Japanese
  request without spaces is one phrase. Memory has no confidence / valid time / approval state yet. Bot and Task memories are
  Workspace-visible to users in search and `GET /v1/memories`, even when a Run wrote them from a private channel:
  §13.6 inheritance of the source's read restrictions waits for the promotion / ACL policy. Bot-pair messages are
  indexed under their `botpair:` channel, so users never find them in search although `GET /v1/bot-conversations`
  shows them.
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
