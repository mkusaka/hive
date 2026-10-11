# Roadmap, validation and operations

## Status

Updated per ticket. See [the ticket DAG](#ticket-dag) for dependencies.

| Ticket    | State   | Notes                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BOOT-01   | done    | Bun workspaces monorepo, `packages/contracts` (ids, idempotency key, event envelope, API error, `parse`), CI                                                                                                                                                                                                                                                                          |
| AUTH-01   | done    | `apps/api-worker`: Access + device-token principals, `POST /v1/commands` (workspace/device), `/v1/me`; G-02/G-04 not executed                                                                                                                                                                                                                                                         |
| DB-01     | done    | `packages/db`: Phase 1 schema + migration, `claimJob` / `renewLease` / `finishRun`, receipts, outbox, inbox                                                                                                                                                                                                                                                                           |
| EVENT-01  | done    | `channel/bot.create`, `agent.send`, `event.emit`, outbox pump → Delivery / Inbox / queued Job; no Queues yet (cron + manual pump)                                                                                                                                                                                                                                                     |
| EXEC-01   | done    | `job.claim` / `run.lease.renew` / `run.result.submit`, heartbeat, `apps/executor` poll runner + journal + fake adapter; no supervisor                                                                                                                                                                                                                                                 |
| CLI-01    | done    | `apps/cli` `hive` (workspace/device/channel/bot, agent send --wait, event emit, op/job/inbox, executor run), `ACCESS_DEV_JWKS` + `dev-token.ts`; **Phase 1 complete**; no OAuth login / op store / offline queue                                                                                                                                                                      |
| SYNC-01   | done    | `change_log` in command batches, `GET /v1/sync/changes` (cursor, auth epoch, 410), list routes, Realtime DO; G-04 not run; no revocation                                                                                                                                                                                                                                              |
| SDK-01    | done    | Claude adapter (SDK 0.3.289, no tools), JSONL transcript journal, run context route, Bot reply, `runtime.run.started` observation; no R2 / SessionStore / tool broker / Codex                                                                                                                                                                                                         |
| UI-01     | done    | `apps/desktop` Electron + React: Channel / Inbox / Activity / Devices views, sync cursor + Realtime via main, typed IPC; no OAuth login, no approval view, no Run inspector, no threads                                                                                                                                                                                               |
| WORK-01   | done    | Projects, Tasks, dependency DAG (cycle check incl. parent/child), `job.start`, Execution → Task, Task Results, `declaration` completion; no human/checks/children policies, `task.replan`, delegation, Git/PR collector                                                                                                                                                               |
| INTEG-01  | done    | Subscriptions (filter AST, revisions, notify / wake / batch, collapse per bot/lane), `apps/integration-worker` (GitHub / Slack signatures, normalization, dedupe AT-23, echo AT-27, 413 coverage gap); G-10 not run; no Routine, Approval / Effect broker, GitHub API refetch, Slack context fetch, outbound posting, per-installation secrets, bot-managed subscriptions, ingest RPC |
| MOBILE-01 | pending |                                                                                                                                                                                                                                                                                                                                                                                       |

Gates: **G-01 executed 2026-10-11, passed** on the owner's Mac: `hive agent send` → `hive executor run --once
--provider claude` → reply posted in the channel. The SDK subprocess authenticated with the Claude subscription
login of the inherited `CLAUDE_CONFIG_DIR` (no extra env, no API key): `system/init.apiKeySource` was `none`
(OAuth) and the stream carried a `rate_limit_event` with subscription windows (`five_hour`, `seven_day`), which
identifies the billing mode. Result: 1 turn, 1.5 s SDK duration, 5 s executor wall time, 2 input / 12 output /
582 cache-creation tokens, estimated list cost 0.012 USD. G-02..G-10 not executed.

## 1. Initial defaults (§29)

Initial product settings, not external service guarantees. Bots / Projects can never exceed Workspace limits.

| Item                             | Initial value / policy                                             |
| -------------------------------- | ------------------------------------------------------------------ |
| Device heartbeat                 | 15 s                                                               |
| Run lease                        | 90 s, renewed every 20 s                                           |
| Offer lifetime                   | 30 s                                                               |
| Executor Job reconcile           | WebSocket plus every 30 s with jitter                              |
| UI reconcile                     | On foreground / reconnect; about every 60 s with jitter while open |
| Bot interactive capacity         | At least one slot budgeted separately from background              |
| Background concurrency           | Start low per device / Bot / provider profile                      |
| Slack/GitHub debounce            | 10 s, max 30 items per batch                                       |
| Bot-to-bot chain                 | Max 4 hops / max 20 correlated Jobs                                |
| Approval timeout                 | 10 min; per-Task shorter or longer                                 |
| Internal event payload limit     | 256 KiB; larger data by permitted object reference                 |
| Context snapshot                 | Saved for every new Run and every reconstruction                   |
| Automatic billing switch         | Forbidden. API / subscription changes are explicit                 |
| Auto fallback for unstarted Jobs | Enabled when an eligible device exists                             |
| Auto fallback for running writes | Disabled by default                                                |

Long-term retention and large-ingestion limits are revisited with real data. D1 / Worker / Queue platform limits
are not baked into settings; the runbook records the values in effect when adopted.

<a id="gates"></a>

## 2. Verification gates (§30.1)

> **Only G-01 executed (2026-10-11, passed; see Status).** Every gate requires the owner's real accounts, Cloudflare environment or devices.
> A capability whose gate has not passed is shown as unavailable in UI / adapters. An option existing in an
> SDK does not count as accepted.

| Gate | Verify                                 | Pass condition                                                                |
| ---- | -------------------------------------- | ----------------------------------------------------------------------------- |
| G-01 | Personal Claude auth, SDK calls, usage | Works with a permitted method; the chosen billing mode is identifiable        |
| G-02 | Access Managed OAuth / refresh         | Login, refresh and revocation work from CLI / Electron                        |
| G-03 | Access + Android                       | HTTPS callback / App Link / PKCE / refresh work on a real device              |
| G-04 | Access + WebSocket                     | Authenticated upgrade from native clients, revocation, reconnect              |
| G-05 | D1 atomic commands                     | batch rollback, 0-row CAS, concurrent claim, UNIQUE/FK on real D1             |
| G-06 | FTS5                                   | Real D1 tokenizer, Japanese, short-term fallback, permissions, index rebuild  |
| G-07 | Claude SessionStore                    | Journal, duplicate append, mirror_error, exit cleanup, resume on another PC   |
| G-08 | Codex adapter                          | thread / turn / approval / stop and obtainable actor identity                 |
| G-09 | OS service                             | Continues after UI close, restart, process-tree stop, Keychain                |
| G-10 | Slack/GitHub live                      | Real installation scope, signatures, duplicates, edits, permission revocation |

The design was accompanied by local SQLite checks of the claim/CAS/FTS invariants. Those are not acceptance:
G-05 / G-06 against real D1, plus G-01..G-10 and AT-01..AT-40, are the product acceptance criteria.

## 3. Acceptance scenarios (§30.2)

| ID    | Action / fault                            | Expected result                                                  |
| ----- | ----------------------------------------- | ---------------------------------------------------------------- |
| AT-01 | Request to a Bot from Electron            | Durable message / inbox / Job are traceable                      |
| AT-02 | CLI on PC2 asks a PC1-preferred Bot       | PC1 claims via the cloud                                         |
| AT-03 | Bot A → Bot B on the same PC              | Recorded in cloud Conversation / Inbox                           |
| AT-04 | Same operation sent multiple times        | No duplicate Message / Job                                       |
| AT-05 | Same key, different payload               | 409; existing request not overwritten                            |
| AT-06 | event.emit with no subscription           | Acceptance record only; no Bot started                           |
| AT-07 | agent.send with no subscription           | Delivered to the target Bot's Inbox                              |
| AT-08 | WS notification lost                      | HTTP reconcile fetches state and Jobs                            |
| AT-09 | Worker dies before Queue enqueue          | Outbox pump resends                                              |
| AT-10 | ACK lost after Queue consumption          | Consumer receipt prevents double processing                      |
| AT-11 | Two PCs claim at once                     | Exactly one active root Run and writer reservation               |
| AT-12 | PC1 offline before start                  | Placed on eligible PC2                                           |
| AT-13 | PC1 disconnects while writing             | unknown / recovery_required; no automatic double run on PC2      |
| AT-14 | Launch intent only, response unknown      | No re-spawn until the real process is checked                    |
| AT-15 | Old generation submits a Result           | Control change rejected; past logs may be stored in limited form |
| AT-16 | Run succeeds, Task Check fails            | Task not marked verified complete                                |
| AT-17 | Cancelled dependency Task                 | Not treated as success; dependent is blocked                     |
| AT-18 | Dependency cycle including parent-child   | Update rejected                                                  |
| AT-19 | Assigned Task changes during a tool call  | Recorded to the ToolDispatch's original Execution                |
| AT-20 | Native child identity unknown             | Stays unassigned, not misattributed to the parent Execution      |
| AT-21 | SDK mirror failure / temporary cleanup    | Independent journal retained; incomplete resume refused          |
| AT-22 | PC2 lacks the same code                   | Environment mismatch; restore / wait made explicit               |
| AT-23 | Slack app_mention and message both arrive | No duplicate wake for the same post                              |
| AT-24 | Subscription to a Slack private thread    | ACLs kept for intake, fetch, storage and search                  |
| AT-25 | Slack poster not permitted                | Observation only; never a remote execution command               |
| AT-26 | Bot requests broad watch / permissions    | Controlled by scope / budget ceilings or approval                |
| AT-27 | Echo of the Bot's own post                | No recursive wake                                                |
| AT-28 | Only the PR-creation response is lost     | Reconcile against external object; stays unknown if unclear      |
| AT-29 | Bot A waits for B's reply                 | No wait loop that exhausts execution slots                       |
| AT-30 | All PCs offline for a long time           | D1 Jobs and Inbox remain; handled per TTL policy                 |
| AT-31 | Duplicate Routine tick                    | One Job per UTC occurrence                                       |
| AT-32 | Search index lagging                      | Freshness shown; Task decisions use authoritative queries        |
| AT-33 | Promote a private source to shared Memory | Sharing beyond source ACL rejected                               |
| AT-34 | Channel permission revoked                | WS / cache / search revoked; context rebuilt                     |
| AT-35 | Run / command changes after approval      | Old approval rejected                                            |
| AT-36 | User closes the window                    | Resident executor keeps running                                  |
| AT-37 | Mobile stopped / notification delayed     | Foreground HTTP sync recovers                                    |
| AT-38 | FTS index recreated                       | Recovered from sources; no other-scope results                   |
| AT-39 | Old index / outbox arrives after delete   | Deleted data does not reappear                                   |
| AT-40 | Run loses API authentication              | New side effects stop; no silent switch to other billing         |

## 4. Test layers (§30.3)

- **Domain unit**: Task DAG, filter AST, policy intersection, Job state, Inbox batch, Memory ACL.
- **DB integration**: D1 rollback, CAS, outbox, FTS migrations on workerd (`@cloudflare/vitest-pool-workers`)
  and a remote test D1.
- **Process integration**: fake provider subprocess for spawn receipt, kill, orphan, journal, upload; then real
  Claude / Codex. Fake-process success is never counted as real-provider acceptance.
- **End-to-end**: PC1 / PC2 / Android with a test GitHub repository and Slack channel. Never test against a
  production broad installation or the existing `wr` DB.

## 5. Observability and runbook (§31)

### 5.1 Required metrics

Request-to-receipt time, outbox age, event routing lag, oldest Inbox item age, Job waiting reason, start time,
unknown Run count, lease renewal failures, stale-generation rejects, approval timeouts, unknown external effects,
transcript confirmed watermark, FTS indexing lag.

Metric labels never contain message text, user secrets or raw commands. Major logs are joined by opaque
workspace / operation / correlation / job / run IDs.

### 5.2 Targets

In a healthy test environment: intake API p95 ≤ 1 s, state change visible on another client p95 ≤ 3 s, eligible
Job notification p95 ≤ 5 s. Provider inference, cold start and offline time are measured separately; misses are
not hidden. Minimum data-integrity conditions: cloud-ACKed input is never lost to a WS disconnect, and un-ACKed
local records are never treated as sent. No cloud-wide disaster-recovery guarantee is promised by this design.

### 5.3 Runbook

| Alert               | Procedure                                                                          |
| ------------------- | ---------------------------------------------------------------------------------- |
| outbox backlog      | Check consumer / queue / permission; resend after reclaiming leases                |
| many waiting_device | Check device online, provider auth, environment, capacity                          |
| unknown writer      | Check old PC process, worktree, external effects. Forced handover is audited       |
| mirror_error        | Reconcile journal and watermark; stop resume until integrity is confirmed          |
| effect unknown      | Reconcile external object via operation markers etc.; human resolves if needed     |
| FTS stale           | Check projection source version; re-index                                          |
| auth revoked        | Show device / user credential revocation reason; re-register or log in             |
| source event gap    | Refetch what is possible (GitHub redelivery, Slack context fetch); record coverage |

Retrying a transient failure and re-running an unknown side effect are never the same button. An operator force
action is not shown as making side effects safe unless the old execution's stop was recorded.

## 6. Retention, deletion, backup (§32)

### 6.1 Initial retention

| Data                                     | Initial retention                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| Conversations / Tasks / Memory / Results | Until user deletion; storage budget and export provided                         |
| Raw provider transcripts                 | 30 days; important sessions can be pinned                                       |
| Detailed tool logs / raw source payloads | 30 days; shorter for sensitive sources                                          |
| Audit / execution summaries              | 180 days initially                                                              |
| Processed Inbox / Delivery details       | 90 days; summaries needed for tracing are kept                                  |
| Unresolved Jobs / Effects / Reservations | Per TTL and explicit resolution policy; never removed by normal cleanup         |
| Local journal                            | Short grace period after cloud ACK; un-ACKed data kept with capacity monitoring |
| Search index                             | Derived; follows source existence and ACL                                       |

- After raw transcripts expire, exact resume may be impossible but reconstruction from LogicalSession / summaries /
  Memory remains; the UI shows `native_resume_unavailable`.
- Idempotency receipts and deletion tombstones are kept longer than the allowed offline-command / replay window;
  out-of-window resends are rejected. Receipts of unresolved effects are never deleted.

### 6.2 Deletion propagation

User deletion tracks the original, search projection, R2, caches and source links of derived Memory / summaries.
Audit keeps a minimal deletion record, not content. ProviderBindings containing deleted sources are retired when
needed and a new context is built. Artifacts already produced from pre-deletion context cannot be undone
automatically; the affected range is made explicit.

### 6.3 Backup / restore

- Back up normal tables via versioned logical export plus R2 manifests, in addition to D1's built-in backup. FTS is
  rebuilt after restore. The export API and virtual-table handling are part of G-06 [S15].
- On restore: stop new Job starts, reconcile the restored DB with live devices, revoke and reissue execution
  generations so old PCs cannot write with pre-restore rights. A DB restore never re-executes GitHub / Slack side
  effects.
- Restore tests run in a separate Cloudflare environment. Production DBs and credentials of `tk` / `wr` / `cxsl` are
  never shared; imports go read-only export → mapping → dry-run → operator approval.

## 7. Phases (§33)

Each phase completes a working end-to-end path. Safety foundations (claim / idempotency / auth) are never
deferred.

| Phase | Scope                                                                                                     | Done when                                                                  |
| ----- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 0     | PoCs: SDK auth / SessionStore, Access OAuth + WS, D1 atomicity / FTS, OS service                          | Gate outcomes and adopted versions are recorded                            |
| 1     | contracts, CommandService, Identity, Device, Event, Receipt, Outbox, Inbox, Job claim, fake executor, CLI | CLI → Cloud → PC → Cloud result; duplicate and disconnect tests pass       |
| 2     | Electron, Channel, Bot, LogicalSession, Claude adapter, Journal, basic Memory / Search                    | Long conversations, input during background work, continues after UI close |
| 3     | Project, Task, Assignee, DAG, Execution, Git/PR collector, bot-to-bot Message / Delegation                | Run from a Task and aggregate outcomes and provenance                      |
| 4     | GitHub / Slack gateway, Subscription, Routine, Batch, Approval / Effect broker                            | Permitted Bots wake from external events; loops and redelivery suppressed  |
| 5     | PC2, placement, recovery, Codex, Android / notifications / approvals                                      | Unstarted fallback, limited recovery, both providers and mobile work       |
| 6     | Memory consolidation, semantic routing, MCP event adapters, Templates, advanced plugins                   | Added according to measured demand                                         |

Phase 1 implements correct claim and generation even with a single PC; consistency is not bolted on in Phase 5.
Android OAuth risk is retired in Phase 0.

<a id="ticket-dag"></a>

### 7.1 Ticket DAG (§33.1)

| Ticket    | Deliverable                                           | Depends on                                                                                                                                                                    |
| --------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BOOT-01   | Monorepo / contracts / CI / local environments        | —                                                                                                                                                                             |
| AUTH-01   | Access user login / device identity / principal model | BOOT-01                                                                                                                                                                       |
| DB-01     | Migrations / critical atomic repository / receipts    | BOOT-01                                                                                                                                                                       |
| EVENT-01  | Event schema / ingest / outbox / consumer receipts    | AUTH-01, DB-01                                                                                                                                                                |
| EXEC-01   | Inbox / Job / claim / lease / fake executor           | EVENT-01                                                                                                                                                                      |
| CLI-01    | send / emit / start / watch / JSON contract           | AUTH-01, EXEC-01                                                                                                                                                              |
| SYNC-01   | Change log / HTTP cursor / Realtime DO                | DB-01, AUTH-01                                                                                                                                                                |
| SDK-01    | done                                                  | Claude adapter (SDK 0.3.289, no tools), JSONL transcript journal, run context route, Bot reply, `runtime.run.started` observation; no R2 / SessionStore / tool broker / Codex |
| UI-01     | Electron Channel / Activity / Approval views          | SYNC-01, SDK-01                                                                                                                                                               |
| WORK-01   | Project / Task / Assignment / DAG / Execution links   | EXEC-01                                                                                                                                                                       |
| INTEG-01  | GitHub + Slack normalization / Subscription UI        | EVENT-01, WORK-01                                                                                                                                                             |
| MOBILE-01 | Android auth / sync / push / approval                 | AUTH-01, SYNC-01                                                                                                                                                              |
