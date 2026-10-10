# @hive/api-worker

The Access-protected API Worker (Hono on Cloudflare Workers, D1 binding `DB`). See
[docs/architecture.md §18 and §22](../../docs/architecture.md#18-authentication-authorization-secrets-21).

## Routes

| Route                    | Auth                                   | Purpose                                                                                        |
| ------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /healthz`           | none                                   | Liveness                                                                                       |
| `GET /v1/me`             | Access assertion (user)                | Returns the user principal (CLI login check)                                                   |
| `POST /v1/commands`      | Access assertion (user)                | Command intake (see below)                                                                     |
| `GET /v1/operations/:id` | Access assertion (user)                | Receipt of the user's command; for `agent.send` also the inbox item, routing status and Job id |
| `GET /v1/jobs/:id`       | Access assertion (user)                | A Job in one of the user's Workspaces                                                          |
| `GET /v1/inbox?botId=`   | Access assertion (user)                | The Bot's inbox items (first 100, no cursor yet)                                               |
| `GET /v1/executor/me`    | `Authorization: Bearer <device-token>` | Returns the device principal                                                                   |
| `POST /v1/executor/pump` | `Authorization: Bearer <device-token>` | Runs the outbox pump once; returns `{processed, dead}`                                         |

- **User auth.** `Cf-Access-Jwt-Assertion` is verified with `jose` against
  `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (issuer `https://<ACCESS_TEAM_DOMAIN>`, audience
  `ACCESS_AUD`). `(issuer, sub)` maps to a `users` row, created on first login with the email claim.
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
- **Bot channel membership.** `agent.send` does not require the recipient Bot to be a member of the channel;
  `bot.create` adds no membership.

## Local development

`wrangler.jsonc` has a **placeholder `database_id`** (all zeros) until the owner provisions D1
(`bunx wrangler d1 create hive`) and replaces it. Local dev uses a local D1 and does not need the real id.

Create `apps/api-worker/.dev.vars` (gitignored) to fill the vars left empty in `wrangler.jsonc`:

```sh
ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com  # Access team domain, no scheme
ACCESS_AUD=<aud-tag>                            # Application Audience (AUD) tag of the Access app
```

```sh
cd apps/api-worker
bunx wrangler d1 migrations apply hive --local   # applies packages/db/migrations
bunx wrangler dev
```

Without Cloudflare Access in front, requests need a real Access assertion, so local dev is mostly useful for
`/healthz` and device-token routes. Tests sign assertions with a local key instead (`createApp({ jwks })`).

## Tests

`bun run test` from the repo root runs `test/` in miniflare with the `packages/db` migrations applied.
