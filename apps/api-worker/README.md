# @hive/api-worker

The Access-protected API Worker (Hono on Cloudflare Workers, D1 binding `DB`). See
[docs/architecture.md §18 and §22](../../docs/architecture.md#18-authentication-authorization-secrets-21).

## Routes

| Route                                       | Auth                                   | Purpose                                                                                        |
| ------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /healthz`                              | none                                   | Liveness                                                                                       |
| `GET /v1/me`                                | Access assertion (user)                | Returns the user principal (CLI login check)                                                   |
| `POST /v1/commands`                         | Access assertion (user)                | Command intake (see below)                                                                     |
| `GET /v1/operations/:id`                    | Access assertion (user)                | Receipt of the user's command; for `agent.send` also the inbox item, routing status and Job id |
| `GET /v1/jobs/:id`                          | Access assertion (user)                | A Job in one of the user's Workspaces                                                          |
| `GET /v1/inbox?botId=`                      | Access assertion (user)                | The Bot's inbox items (first 100, no cursor yet)                                               |
| `GET /v1/channels?workspaceId=`             | Access assertion (user)                | Channels the user is a member of, with the main `conversationId` (max 500)                     |
| `GET /v1/channels/:id/messages`             | Access assertion (user)                | Newest-first messages of a member channel (limit 1..200, default 50; 404 if not a member)      |
| `GET /v1/bots?workspaceId=`                 | Access assertion (user)                | Bots of the Workspace (max 500)                                                                |
| `GET /v1/devices?workspaceId=`              | Access assertion (user)                | Devices of the Workspace, no credentials (max 500)                                             |
| `GET /v1/jobs?limit=`                       | Access assertion (user)                | Newest-first Jobs (limit 1..200, default 50)                                                   |
| `GET /v1/sync/changes?cursor=`              | Access assertion (user)                | Permitted changes after the cursor (limit 1..500, default 100); see Sync below                 |
| `GET /v1/realtime?workspaceId=`             | Access assertion, or device Bearer     | WebSocket upgrade to the Workspace's Realtime DO; see Realtime below                           |
| `GET /v1/executor/me`                       | `Authorization: Bearer <device-token>` | Returns the device principal                                                                   |
| `POST /v1/executor/pump`                    | `Authorization: Bearer <device-token>` | Runs the outbox pump once; returns `{processed, dead}`                                         |
| `POST /v1/executor/commands`                | `Authorization: Bearer <device-token>` | Executor command intake (see below)                                                            |
| `POST /v1/executor/heartbeat`               | `Authorization: Bearer <device-token>` | Sets `devices.last_heartbeat_at` (plain update, no receipt)                                    |
| `GET /v1/executor/jobs?state=queued&limit=` | `Authorization: Bearer <device-token>` | Queued Jobs in the device's Workspace it is eligible for (limit 1..100, default 50)            |
| `GET /v1/executor/runs/:id`                 | `Authorization: Bearer <device-token>` | The device's own Run: state, generation, `active` (startup reconcile)                          |

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
  `agent.send`, `event.emit`.
- **Actors.** A user's `actors` row is created by `workspace.create` together with the membership (the only path
  that creates a membership today), unique per `(workspace_id, user_id)`. Messages and channel membership use it.
- **`channel.create`** creates the channel, its main conversation and an `owner` channel membership for the caller.
  **`bot.create`** creates the Bot and its actor; it joins no channel. A duplicate name is 422.
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
  Returns `{runId, executionId, executionGeneration, leaseExpiresAt, job: {id, botId, inboxItemId, placement}}`.
  Failures: `stale_revision` / `already_claimed` → 409 `REVISION_CONFLICT`, `resource_busy` → 409 `RESOURCE_BUSY`;
  the error body carries `reason`. Job state is checked by the CAS, not before it, so a replay of a successful claim
  returns the stored response.
- **Eligibility.** A non-empty `allowedDeviceIds` is always intersected, whatever the `mode` (§10.2: safety
  constraints are intersected); an empty list means any device of the Workspace. `GET /v1/executor/jobs` applies
  the same filter in code. Revoked devices are already rejected by device auth.
- **`run.lease.renew {runId, executionGeneration}`.** Fenced by run + device + generation (`renewLease`); a stale
  fence is 409 `STALE_GENERATION`. No receipt: renewing twice is harmless.
- **`run.result.submit {runId, executionGeneration, state, summary ≤ 8 KiB, error?}`.** `finishRun` stores the
  summary / error on the Run and, in the same batch, sets the Job's trigger inbox item (`jobs.trigger_key =
inbox:<id>`) to `processed` (succeeded) or `failed`, plus the `run.finished` outbox row. A stale fence is 409
  `STALE_GENERATION`; a replay with the same key returns `{ok: true}` again.

## Sync

The list, sync and realtime routes take the Workspace as `?workspaceId=` (required; 403 if the principal is not a
member).

- **Change log.** Every batch that changes a client-visible entity appends one `change_log` row per entity
  (`appendChange`, `packages/db`), so a rolled-back command leaves none:

  | Command / step                      | Rows (scope)                                           |
  | ----------------------------------- | ------------------------------------------------------ |
  | `workspace.create`                  | workspace (workspace)                                  |
  | `device.register` / `device.revoke` | device (workspace)                                     |
  | `channel.create`                    | channel, conversation (channel)                        |
  | `bot.create`                        | bot (workspace)                                        |
  | `agent.send`                        | message, inbox item (channel)                          |
  | event route                         | inbox item (channel), Job (workspace) for `wake`       |
  | `job.claim`                         | Job, Run (workspace)                                   |
  | `run.result.submit`                 | Run, Job (workspace), trigger inbox item (its channel) |

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
- Any other event: no subscriptions exist yet, so only the consumer receipt is written (matched = 0).
- Routing twice is a no-op (consumer receipt PK; UNIQUE trigger key as backstop). A failed row keeps its lease
  and is retried when it expires; after 5 attempts it is marked `dead`. Topics without a consumer yet
  (`run.finished`) are marked `sent`.

It runs from the `scheduled()` cron trigger (every minute) and from `POST /v1/executor/pump`.

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
  artifacts, lease expiry is not recovered automatically (an expired `active` Job stays `active`), and there is no
  scheduler / offer: executors poll `GET /v1/executor/jobs`. A page of that list is filtered after `LIMIT`, so it
  may hold fewer than `limit` eligible Jobs.
- **Sync / realtime.** No scope revocation: no command removes a member, so nothing bumps `auth_epoch` or closes
  sockets whose scopes shrank (§12.4); add it with the member commands. Socket scopes are computed once at
  upgrade, so a channel joined later needs a reconnect, and they live in the socket attachment (16 KiB cap, about
  350 channels). The list routes are bounded but not paginated. G-04
  (Access + WebSocket from native clients) is not executed. Notify hints are sent per request, not batched.
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
`test/devToken.test.ts` covers the `ACCESS_DEV_JWKS` path. `test/sync.test.ts` covers the change rows of every command, sync paging
and expiry, the list routes, and real WebSocket fan-out through the Realtime DO (two user sockets with different
scopes plus a device socket).
