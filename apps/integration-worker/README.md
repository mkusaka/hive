# @hive/integration-worker

GitHub App webhook and Slack Events API intake (Hono on Cloudflare Workers, D1 binding `DB`, the same database as
`apps/api-worker`). See [docs/architecture.md §6.1, §15 and §16](../../docs/architecture.md#6-durable-delivery-9).

Intake is verification plus ONE D1 batch: the normalized Event and its `event.route` outbox row. The response
comes after that batch commits; nothing is left to `waitUntil`. Routing to Bots happens later in api-worker's
outbox pump, through Subscriptions.

## Routes

| Route                               | Verification                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                      | none                                                                                                                                |
| `POST /hooks/github/:integrationId` | `X-Hub-Signature-256`: HMAC-SHA256 of the raw body with `GITHUB_WEBHOOK_SECRET`                                                     |
| `POST /hooks/slack/:integrationId`  | `X-Slack-Signature` (v0) over `v0:<timestamp>:<raw body>` with `SLACK_SIGNING_SECRET`, `X-Slack-Request-Timestamp` within 5 minutes |

`:integrationId` is an `integration_installations` row, created by the user command
`integration.create {kind, externalAccountId?}` (`hive integration create --kind github|slack`), which returns
the `hookPath`. An unknown, disabled or other-kind installation is 404. Signatures are compared in constant time.

| Status | When                                                                                         |
| ------ | -------------------------------------------------------------------------------------------- |
| 200    | Accepted `{ok, eventId, routed}`, or a duplicate `{ok, eventId, duplicate: true}`            |
| 200    | Slack `url_verification`: `{challenge}` (after the signature check)                          |
| 401    | Bad signature; Slack timestamp missing or older / newer than 5 minutes                       |
| 413    | Verified body over 256 KiB; an `integration.coverage_gap` row is written to `audit_log`      |
| 422    | Missing `X-GitHub-Event` / `X-GitHub-Delivery`, invalid JSON, malformed event or action name |
| 500    | The secret is not configured                                                                 |

The size check runs after the signature check, so only authenticated senders can write audit rows.

## Normalization

Only normalized fields are stored, never the raw payload (Slack's carries `token` / `authorizations`).
`actor` is `{kind: "integration", id: <integrationId>}`; `source` is the installation's kind, `integrationId` and
`externalEventId`.

- **GitHub.** Type `github.<X-GitHub-Event>.<action>` (`github.push` without an action). `externalEventId` is
  `X-GitHub-Delivery`. Subject `pull_request` or `issue` with id `<repositoryId>#<number>`. `data`:
  `repositoryId, number, action, sender, labels, branch, headSha`.
- **Slack.** Type `slack.<event.type>`, except that a `message` mentioning the app (`<@externalAccountId>`) is
  typed `slack.app_mention` instead of `slack.message`: subscribe to `slack.*` (or both types) to see every post. `externalEventId` is `event_id`. Subject `slack_thread` with id
  `<team>:<channel>:<thread_ts or ts>`. `data`: `slackTeamId, slackChannelId, slackThreadTs, slackTs,
slackUserId, subtype, text` (text capped at 8 KiB of UTF-8).

## Dedupe and echoes

- A redelivery hits `events_source_dedupe` (workspace, source, integration, external id) and answers 200
  `duplicate: true` with the first event id.
- A Slack post delivered as both `app_mention` and `message` collapses on `events.logical_key`
  `slack:<team>:<channel>:<ts>` (AT-23). Because both deliveries normalize to `slack.app_mention`, the stored
  Event does not depend on which arrives first. Edits and deletes (`subtype` set) get no logical key.
- A Slack event whose `user` is the installation's `external_account_id` (the app's bot user) is stored with the
  router's consumer receipt instead of an outbox row, so it is never routed (AT-27).

## Local development

```sh
cd apps/integration-worker
cat > .dev.vars <<'EOF'
GITHUB_WEBHOOK_SECRET=<github-webhook-secret>
SLACK_SIGNING_SECRET=<slack-signing-secret>
EOF
bunx wrangler d1 migrations apply hive --local
bunx wrangler dev --local --port 8788
```

`.dev.vars` is gitignored. In production set both with `bunx wrangler secret put`. Tests use fixed fake secrets
from `vitest.config.ts` and real HMAC math over recorded / synthetic payloads.

## Known gaps

- Gate G-10 (live GitHub / Slack installation) is not executed.
- Secrets are environment-level: one GitHub webhook secret and one Slack signing secret for every installation.
- Writes D1 directly; the design routes integration writes through api-worker's internal ingest RPC (§1.1).
- No GitHub App / installation / repository resolution, no API refetch of current PR / CI state, no redelivery
  reconciliation; no Slack team check against the installation, no context fetch, no outbound posting.
- Slack edits / deletes are stored as plain events; there is no change-version identity yet.
- No raw payload retention (R2) for replay.
