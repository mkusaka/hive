# Architecture

Distilled from the v1.0 design. Section numbers in brackets (§n) refer to the original design document.
Code blocks and tables marked as contracts are this product's own proposals; they are the spec for
implementation tickets, not descriptions of existing SDK APIs.

## 1. Overall picture (§4)

```text
Electron / Android / hive CLI / Bot A
                    │ HTTPS: Command / Query / Event
                    ▼
             api-worker (Access)
              │  CommandService / Authorization
              ├── D1: source of truth, Inbox, Job, Lease, Change Log, FTS5
              ├── R2: Transcripts, Logs, Artifacts
              ├── WorkspaceRealtimeDO: WebSocket / Signal
              └── Transactional Outbox
                            │
                         Queues
                            │
                   background-worker
                   Router / Scheduler / Indexer
                            │ private service binding
                            └────────→ api-worker internal API

GitHub / Slack / external webhooks
              │ signed HTTPS
              ▼
       integration-worker (not behind Access login)
              │ signature verification, installation resolution
              └── private service binding → api-worker / Event Inbox

Local Executor PC1 / PC2
    ├── WebSocket: notifications (new work, cancellation, ...)
    ├── HTTPS: Job claim / lease / event upload / search / transcript
    ├── Local SQLite: Journal / Outbox / Cache / Process Registry
    └── Claude Adapter / Codex Adapter / Local Tools
```

### 1.1 Worker split (§4.1)

| Component           | Public surface / responsibility                                          | Writes to source of truth             |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------- |
| api-worker          | Access-protected API, authorization, shared CommandService, internal RPC | Owns D1 / R2                          |
| integration-worker  | GitHub / Slack / webhook intake, signature verification, fast ACK        | Via internal ingest API               |
| background-worker   | Queue consumer, Cron, Router, Scheduler, Indexing                        | Via internal command / projection API |
| WorkspaceRealtimeDO | WebSocket subscriptions, fan-out, hibernation                            | Holds no Job or Task truth            |

- Domain writes with a D1 binding are concentrated in api-worker. One `CommandService` applies the same
  invariants to public and internal-service requests.
- Internal callers are identified by dedicated Service Binding methods. An external request cannot gain internal
  rights by adding a header such as `X-Service-Role`. Internal RPC is scope-limited; there is no arbitrary-SQL
  or arbitrary-state-replace API.
- Recreating, hibernating or disconnecting the DO never loses truth. WebSocket Hibernation is used and
  subscription info is restorable from connection attachments. [S10]

### 1.2 Stack (§4.2)

| Area             | Technology / initial choice                                        |
| ---------------- | ------------------------------------------------------------------ |
| Common           | TypeScript / Bun workspaces / pinned lockfile                      |
| Worker runtime   | Cloudflare Workers / workerd (not the Bun runtime)                 |
| HTTP / contracts | Hono / Valibot, in a standalone contracts package                  |
| DB               | Drizzle ORM + D1; FTS and constraints via reviewed SQL migrations  |
| Realtime         | SQLite-backed Durable Object class + hibernating WebSocket         |
| Async            | Cloudflare Queues + D1 outbox + dead-letter queue                  |
| Scheduler        | Cron Triggers; fine-grained timers later via DO Alarm              |
| Storage / search | R2 / D1 FTS5                                                       |
| Auth             | Cloudflare Access / Managed OAuth / Service Auth / jose            |
| Desktop          | Electron / React / Vite, typed IPC between renderer and main       |
| Mobile           | React Native Android / native secure storage / FCM                 |
| Executor         | Pinned supported Node.js LTS, running as an OS service             |
| CLI              | Node.js TypeScript CLI; wr-style JSON output and exit codes        |
| Tests            | Vitest / Workers pool / Node integration / device acceptance tests |
| Infra            | Terraform / Wrangler / GitHub Actions                              |

Hono / Drizzle / Valibot / Bun match `wr` [S02]. wr's web-only Inertia page structure is not inherited; a JSON
API shared by Electron / Android / CLI is the common surface. Terraform owns Access / DNS / service tokens,
Wrangler owns Workers / bindings / deploy, the migration runner owns the DB schema. No resource has two owners.

## 2. Domain boundaries (§5)

| Entity                | Meaning                                                               |
| --------------------- | --------------------------------------------------------------------- |
| Workspace             | Boundary for users, Bots, Devices, settings, permissions              |
| Channel               | Long-lived area of interest; home of conversation and shared context  |
| Conversation / Thread | A group of posts: channel thread, private bot-to-bot, external thread |
| Project               | Outcome goal or ongoing work group that collects Tasks                |
| Task                  | Goal, assignee, requirements, completion criteria                     |
| Bot                   | Persistent role, Skills, Memory, execution policy                     |
| LogicalSession        | Ongoing dialogue relation between a Bot and a Conversation            |
| ContextEpoch          | A version of context reconstructed by the app                         |
| ProviderBinding       | Real Claude session / Codex thread ID and restore info                |
| RuntimeAgent          | Root or native-child actor running inside a provider                  |
| Event                 | An observed fact or accepted signal                                   |
| Delivery              | Where and how an Event was delivered                                  |
| BotInboxItem          | Durable input a Bot is asked to handle                                |
| Job                   | A logical request to execute asynchronously                           |
| Run                   | A concrete actor invocation on a specific PC                          |
| Execution             | Record of a Run working on a specific Task                            |
| Delegation            | Limited authority over a Task / scope handed to another actor         |
| Result / Check        | A submission, and verification records against it                     |
| Memory                | Long-lived knowledge with source, version and access conditions       |
| Approval / Effect     | Human approval, and the record of an external side effect             |

### 2.1 Cardinality and IDs (§5.1)

- A Workspace has many Channels / Projects / Bots / Devices. Project ↔ Channel is many-to-many;
  `primary_channel_id` is only the default notification target and grants nothing on other Channels.
- A Task belongs to at most one Project. Initially Subtasks stay in the same Project. Conversation ↔ Task is
  many-to-many. Conversations without Tasks and Routine Jobs without conversations are allowed.
- LogicalSession identity is `(workspace_id, bot_id, conversation_id, lane)`, with `lane=interactive` vs
  `background:<task-or-purpose>`. A Bot never shares one giant session.
- A LogicalSession has many ContextEpochs and ProviderBindings. A provider session ID is never the app's
  persistent ID; mapping combines provider ID, working-directory namespace and auth profile.
- A Job has many root Runs as history but **at most one unresolved active root Run**. Native subagent Runs use
  `kind=native_child` + `parent_run_id` under the same root Job. A different Bot started by delegation gets its
  own Job.
- A Run can have several Executions in sequence. The Execution is fixed on each ToolDispatch at dispatch time;
  history is never attributed later via "the latest Task".
- IDs are opaque UUIDs generated by the server or a trusted launcher. `APP-123` is a display key, distinct from
  DB identity and external issue IDs. Times are stored in UTC; UI and Routines use IANA time zones.

### 2.2 Four relations never mixed (§5.2)

| Relation                   | Representation                                                            |
| -------------------------- | ------------------------------------------------------------------------- |
| Work decomposition         | `task.parent_task_id`                                                     |
| Start dependency           | `task_dependencies(prerequisite, dependent)`                              |
| Runtime actor parent/child | `runtime_agents.parent_runtime_agent_id` / `runs.parent_run_id`           |
| Delegation / continuation  | `delegation_id` / `continued_from_run_id` / `continued_from_execution_id` |

When a provider gives several native agents the same session ID, no fictitious provider session is invented.
A parent Run ending does not mean its children ended.

## 3. Storage (§6)

### 3.1 D1 table groups (§6.1)

Every shared row has `workspace_id`. Foreign keys reference `(workspace_id, id)` where possible so IDs from
another Workspace cannot be linked.

| Group          | Tables                                                                  | Key constraints / indexes                                        |
| -------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Identity       | users, workspaces, workspace_members, actors                            | Access (issuer, subject) UNIQUE; actor kind user/bot/service     |
| Devices        | devices, device_credentials, device_environments                        | device owner, credential revoke, environment revision            |
| Channel        | channels, channel_members, bot_memberships                              | workspace + channel + actor UNIQUE                               |
| Conversation   | conversations, conversation_members, messages, message_revisions        | `(conversation_id, seq)`, `(actor_id, client_message_id)` UNIQUE |
| Bot            | bots, bot_config_revisions, skills, bot_skill_bindings                  | Bot config history, Skill version pin                            |
| Work           | projects, project_channels, tasks, task_dependencies, task_holds        | Project key UNIQUE, self-dependency rejected, dependency UNIQUE  |
| Session        | logical_sessions, context_epochs, provider_bindings, runtime_agents     | logical session key UNIQUE, real provider identity mapping       |
| Inputs         | events, event_receipts, subscriptions, subscription_revisions           | source event dedupe, schema version, filter revision             |
| Delivery       | event_deliveries, inbox_items, inbox_batches                            | dedupe on logical input + recipient + lane                       |
| Execution      | jobs, job_inputs, runs, executions, tool_dispatches                     | root attempt UNIQUE, task scope revision, tool ID                |
| Coordination   | resource_reservations, provider_budgets, delegations                    | resource UNIQUE, execution generation, scope and expiry          |
| Results        | task_results, result_checks, task_acceptances                           | immutable result, artifact digest, requirement version           |
| Side effects   | approvals, effects, outbound_messages                                   | approval one-use, effect operation UNIQUE                        |
| Knowledge      | memories, memory_revisions, context_snapshots, source_refs              | original source, ACL inheritance, memory version                 |
| Search         | search_documents, search_document_scopes, search_fts                    | source ID + chunk + revision, FTS rowid                          |
| Objects        | artifacts, artifact_links, transcript_streams, transcript_parts         | transcript stream + part_seq UNIQUE, object hash                 |
| Automation     | routines, routine_occurrences, integration_installations, external_refs | routine version + scheduled_at UNIQUE                            |
| Infrastructure | operation_receipts, change_log, outbox, audit_log                       | operation key UNIQUE, outbox lease, change cursor                |

Migrations are split per feature; tables are not all introduced at once. Schema comments classify each table as
current state, immutable history, or rebuildable projection.

### 3.2 Core fields (§6.2)

```ts
// Domain contract example. Persisted rows also carry workspaceId / timestamps / audit actor.
type Assignee = { kind: "user" | "bot"; id: string } | null;

type Task = {
  id: string;
  projectId: string | null;
  parentTaskId: string | null;
  key: string;
  title: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  assignee: Assignee;
  priority: number;
  revision: number;
  scopeRevision: number;
  completionPolicy: "declaration" | "human" | "checks" | "children";
};

type PlacementPolicy = {
  mode: "pinned" | "preferred" | "any";
  allowedDeviceIds: string[];
  preferredDeviceIds: string[];
  fallbackOnUnavailable: boolean;
  overflowToFallback: boolean;
  environmentId: string;
  requiredCapabilities: string[];
  recovery: "manual" | "safe_auto";
};

type Run = {
  id: string;
  jobId: string;
  kind: "root" | "native_child";
  parentRunId: string | null;
  deviceId: string;
  providerBindingId: string | null;
  executionGeneration: number;
  state:
    | "starting"
    | "running"
    | "waiting_approval"
    | "stopping"
    | "unknown"
    | "succeeded"
    | "failed"
    | "interrupted"
    | "cancelled";
  leaseExpiresAt: string | null;
  continuedFromRunId: string | null;
};
```

Four distinct version counters, never shared: `revision` (UI/config edit conflicts), `scopeRevision` (semantic
change of requirements, completion criteria, dependencies), `executionGeneration` (rejects updates from stale
executions), `ContextEpoch` (conversation reconstruction).

### 3.3 R2 and local split (§6.3)

- R2 object keys are `workspace / object-kind / opaque-id / part`; never a user-supplied path. Access is through
  signed, limited uploads or the authenticated API. Clients never get broad R2 credentials.
- R2 is not treated as appendable: immutable part objects + a D1 manifest. Store and verify the object first,
  then commit the manifest to D1. Unreferenced objects from partial failures are garbage-collected later.
- Local SQLite holds the durable upload journal, unsent commands, process records and cache. The local cache is
  not a second source of truth. PC-specific files, keys and auth stay on the PC.

## 4. Task / Project / DAG (§7)

### 4.1 Lightweight status (§7.1)

- Task status is `pending → in_progress → completed`, plus `cancelled`. Reopening is an explicit operation.
  `blocked`, `ready`, `waiting_approval`, `waiting_device`, `failed_attempt` are **computed display states**,
  never stored in Task status.
- Assignee is the responsible party; Execution / Reservation is a temporary right to work. A Task can be ready
  with an assignee set. A Bot adding research to a human-assigned Task does not change the assignee.
- `task.claim` checks permission, dependencies, holds and resources, then creates an Execution. If execution is
  needed, `job.start` performs the claim. Bots never get a blanket right to steal Tasks.

### 4.2 Dependencies and hierarchy (§7.2)

- Start dependencies link Tasks within one Workspace. The MVP UI focuses on one Project, but the model can
  express cross-project dependencies. Access to both Tasks is required.
- Cycle checks include not only `task_dependencies` but also "parent completion depends on child completion",
  rejecting hidden cycles such as a child whose start depends on its parent's completion.
- DAG updates bump the requirement version; a plan computed from a stale read snapshot never overwrites a
  concurrent edit. Changing requirements of a started Task goes through `task.replan`, which marks active
  Executions as needing stop/re-evaluation.

### 4.3 Completion (§7.3)

| Policy      | Completion condition                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| declaration | An authorized actor submits a Result for the target requirement version. UI shows "declared complete" |
| human       | A human approves the Result                                                                           |
| checks      | Required Checks pass against the Result's artifact digest / commit SHA                                |
| children    | All required child Tasks are validly complete; optionally a parent integration Check                  |

- Exit code 0, a created PR, or a Bot saying "done" never produces verified Task completion. Cancelled children
  or dependencies never count as success; drop them explicitly instead.
- Result and Acceptance are immutable history. A change to requirement version, target artifact, required Checks
  or accepted dependency versions invalidates the current Acceptance (past successes are kept). Downstream Tasks
  already started are re-evaluated.
- Projects are `active / paused / archived`. Ongoing-operation Projects do not auto-complete. Archiving asks
  whether related Routines / Subscriptions continue or stop.

## 5. Command / Event / Observation / Hook / Signal (§8)

### 5.1 Separate contracts (§8.1)

| Kind            | Meaning                                              | Examples                                       | Handling                           |
| --------------- | ---------------------------------------------------- | ---------------------------------------------- | ---------------------------------- |
| Command         | Request to act, with permission check                | task.complete, agent.send, subscription.create | Accepted or rejected synchronously |
| Domain Event    | Accepted fact or observed occurrence                 | task.completed, github.pull_request.reviewed   | Persisted in D1, delivered async   |
| Observation     | Record collected from a runtime / external system    | tool.finished, runtime.child.observed          | Accepted per source and capability |
| Lifecycle Hook  | Procedure that allows / stops / transforms execution | before_tool, before_spawn                      | Awaited locally, with a deadline   |
| Realtime Signal | Prompt to display or refetch                         | stream.delta, sync.changed                     | WebSocket, no replay guarantee     |

- Not everything is an async event bus. Approvals, execution-right acquisition and Task status changes need a
  clear Command / Hook success or rejection.
- Emitting an event name cannot forge a fact. Publishers hold per-namespace rights: the CLI may emit `custom.*`,
  normalizing gateways `github.* / slack.*`, domain services `task.* / job.*`. The CLI cannot complete a Task by
  sending `task.completed`.

### 5.2 Event envelope (§8.2) — contract

```ts
type EventEnvelope<T> = {
  id: string;
  workspaceId: string;
  type: string;
  schemaVersion: number;
  source: {
    kind: "github" | "slack" | "cli" | "routine" | "bot" | "system";
    integrationId?: string;
    externalEventId?: string;
    deviceId?: string;
  };
  actor: { kind: "user" | "bot" | "integration" | "system"; id: string };
  subject: { kind: string; id: string } | null;
  data: T;
  correlationId: string;
  causationId: string | null;
  occurredAt: string;
  receivedAt: string;
  expiresAt: string | null;
};
```

- `actor`, authenticated `source` and `receivedAt` are set by the server. A client `occurredAt` may be stored as
  observation time but is never used for execution rights, leases or authoritative ordering.
- `subject` is what the event is about, **not** where it goes. Destinations come from Subscriptions or a Direct
  Message command. `data` never carries secrets or raw environment. Each type has a Valibot schema and a size
  limit; unknown versions are quarantined, not auto-executed.
- Implemented in `packages/contracts` (`eventEnvelope(dataSchema)`).

### 5.3 Direct message vs pub/sub (§8.3)

- `event.emit` publishes a signal. With zero subscribers no Bot starts; the response can say `matched=0` or
  routing pending.
- `agent.send` is a request to a specific Bot. It does not depend on Subscriptions; it is recorded in the
  authorized recipient's Conversation and Inbox. An event is also emitted for audit and other subscribers.
- `job.start` is an explicit execution request, not to be confused with a notification Event.
- All three share the CommandService but their contracts are not merged.

## 6. Durable delivery (§9)

### 6.1 Intake to Job (§9.1)

```text
signature / auth / permission / schema checks
  → commit Event Inbox + Receipt + Outbox to D1
  → intake response
  → outbox pump enqueues to Queue
  → subscription matcher decides targets and revision
  → atomically create Delivery + Bot Inbox
  → create Job per wake/batch policy
  → Scheduler notifies candidate devices
```

- Queues are at-least-once [S11]; consumers must be idempotent. Event router, Job creation, search indexing and
  outbound sends are independent consumers.
- ACK only after durable acceptance. Never return 2xx and leave persistence to `ctx.waitUntil()`. D1 + Queues and
  D1 + R2 are never treated as one distributed transaction.

### 6.2 Dedup keys (§9.2)

| Stage                                 | Unique identity                                                         |
| ------------------------------------- | ----------------------------------------------------------------------- |
| Command                               | workspace + authenticated actor + idempotency key                       |
| GitHub delivery                       | integration + X-GitHub-Delivery                                         |
| Slack delivery                        | installation + event_id                                                 |
| Slack, same post via different events | team + channel + message ts + change version                            |
| Routine occurrence                    | routine ID + schedule revision + UTC occurrence                         |
| Consumer receipt                      | event ID + consumer name + handler version                              |
| Delivery                              | logical input ID + recipient Bot + conversation/lane + delivery purpose |
| Job                                   | deterministic trigger key / sealed inbox batch ID                       |
| Model/Tool observation                | run + provider event ID, or collector stream + local seq                |
| Transcript upload                     | stream ID + stable part ID + entry identity                             |
| External write                        | effect ID + immutable request digest                                    |

- Same idempotency key with a different payload → 409. Even when replaying an existing result, current
  authorization is re-checked; expired tokens or scopes are not revived.
- Several Subscriptions delivering the same Slack post to the same Bot / lane collapse into one wake, recording
  `matched_subscription_ids`. Only a different lane or explicit purpose creates a separate Delivery.

### 6.3 Outbox (§9.3)

- Outbox rows: `pending / sending / sent / dead`, attempt, available_at, lease_owner, lease_until, payload_ref.
  The pump uses conditional acquisition to avoid races.
- If saving `sent` fails after a successful enqueue, the consumer receipt prevents double processing. `sent`
  means handed to the Queue, not processed; reconcile against each consumer's processing receipt.
- Unprocessed Events / Deliveries / Jobs in D1 can re-drive work, so a PC offline beyond Queue retention never
  loses a Job. Dead-letter replay is dry-run by default; real replay is explicit and records a replay ID. Replay
  never unconditionally restores the original actor's rights.

### 6.4 Subscription evaluation (§9.4)

- Subscriptions have immutable revisions; filters are a structured AST. No JavaScript / SQL / eval strings from
  Bots.
- Filter fields: source, event type, repository ID, PR number, Slack channel/thread, sender, label, branch,
  keyword. Depth, item count and cost are bounded.
- The subscription revision and match reason are pinned on the Delivery. Re-evaluating past events after a change
  is an explicit backfill/replay. Stopping halts new Deliveries; existing pending Inbox items / Jobs are kept or
  cancelled by choice.
- Semantic filtering is a separate classification Job. Cloudflare never silently runs a billed model. Phase 1
  prefers deterministic metadata / keyword / ID filters.

## 7. Bot Inbox and lanes (§10)

### 7.1 Durable inbox (§10.1)

The Inbox belongs to the Bot, but processing is split into lanes per Conversation / Task. Confidential content
from different Channels is never mixed into one batch.

```text
pending → reserved → processing → handled
                              ├→ deferred
                              ├→ failed
                              ├→ expired
                              └→ suppressed
```

`seen_at` is UI read state; `handled_at` is processing completion. Feeding input to a provider does not make it
handled. Each Run pins an input snapshot; retries track the same input range.

### 7.2 Delivery modes (§10.2)

| mode   | Behaviour                                                          |
| ------ | ------------------------------------------------------------------ |
| notify | Human notification / history only. No LLM                          |
| wake   | Creates a processing Job for the Bot                               |
| batch  | Debounces events of the same lane into one batch                   |
| append | Accumulates in the Inbox, included in the next explicit activation |

- `append` stays unprocessed if nothing activates the Bot; subscriptions that need it set max_delay or
  escalation.
- Batches go `open → sealed`; membership is fixed at seal. Events arriving during a Run go to the next batch.
  Completion never marks "all pending items of that Bot" handled.

Implemented as (MENTION-01): a user's channel message addresses Bots with mention tokens `<@bot:BOT_ID>` (Slack's
`<@U123>` shape, namespaced for a later `<@user:ID>`) stored in the body; names are resolved only for display.
`message.post {channelId, text, mentions?}` writes one message and, per mentioned Bot, the same `agent.message.sent`
Event + `wake` Inbox item (purpose `agent.send`) + outbox row as a `request` `agent.send`, so routing gives one Job per
Bot; no mention = only posted (superseded for Channels by ROUTE-02 below). A token naming no Bot of the Workspace, or
`mentions` differing from the tokens, is 422.
The run context renders tokens as `@<bot name>` (`@unknown` for a missing Bot). `agent.send` stays for the CLI,
bot-to-bot and integrations.

Implemented as (DM-01): Slack's two conversation kinds. **Channels** have members, and Bots are real members:
`channel.join` / `channel.leave {channelId, botId}` (callers must be members; `channel` change row), and a
`message.post` mentioning a non-member Bot adds it in the same batch (one `INSERT … SELECT FROM json_each`, one
`channel` change row). Membership routes since ROUTE-02 (below): a member Bot reads every post of the Channel's main
conversation. **Direct messages**
are `conversations.kind = 'dm'` with `dm_user_id` + `dm_bot_id` (migration 0021, partial UNIQUE on
`(workspace_id, dm_user_id, dm_bot_id) WHERE kind = 'dm'`). Like a bot pair, a DM is backed by a member-less Channel
row sharing its id `dm-<userId>-<botId>` (`channel_id` is NOT NULL and the table cannot be rebuilt on D1), so it is
in no channel list, and lane, change scope (`channel:<id>`, added to its user's permitted scopes), search and reply
gating work unchanged. `dm.open {botId}` is idempotent (deterministic id, `ON CONFLICT DO NOTHING`; `dm` change row
in `workspace:<ws>`). `message.post {conversationId}` in a DM always delivers to the DM's Bot (one wake; a mention of
another Bot is 422); `GET /v1/dms` and `GET /v1/conversations/:id/messages` are the DM user's only. The run context
has `conversation.kind = 'dm'` and the user as `counterpart`; the executor posts the final text in a DM as in a
Channel. Memory needs no new scope: the `channel` scope with the DM's id is the DM's memory (the Run's own channel,
or a user who is the DM's user). Routines and subscriptions may target a DM conversation.

Implemented as (THREAD-01): a **thread** is a Conversation of kind `thread` rooted at one message of a Channel's or
DM's conversation: `root_message_id` (partial UNIQUE `(workspace_id, root_message_id) WHERE kind = 'thread'`) and
`parent_conversation_id` (migration 0022); its `channel_id` is the parent's, so lane, change scope, search scope,
memory and reply gating are the parent's, and every "a Channel's conversation" lookup filters `kind = 'channel'`. A
reply is an ordinary message of the thread. `message.post {channelId | conversationId, threadOf}` creates the thread on
the first reply in the same batch (deterministic id `thread-<rootMessageId>`, `ON CONFLICT DO NOTHING`); the root must
be a message of the addressed conversation itself (no nested threads; 404 otherwise). Wake rule: mentioned Bots, plus
**every Bot that already took part in the thread** without a mention (Slack behavior): it posted there (the root
included) or was delivered a message there. A DM thread always wakes the DM's Bot. Since a LogicalSession is keyed by
`(bot, conversation, lane)`, each thread is its own LogicalSession; no `logical_sessions` table exists yet, so
continuity is the run context (the thread from its root) and per-Job provider resume. A thread Run's context has
`conversation.kind = 'thread'`, `recent` = the root then the replies, and `parentMessages` = up to 20 parent messages
before the root (read-only context in the prompt); the Bot's reply goes to the thread. Reading a thread follows its
parent's rule (Channel member / DM user). Parent message lists carry a per-message `thread` summary
(`conversationId`, `replyCount`, `lastReplyAt`, ≤ 5 participant actor ids) from one grouped subquery; the Channel's
`lastMessage` preview ignores replies. `GET /v1/threads?participant=me` lists threads the user started or replied in.

Implemented as (ROUTE-02): a Channel's main conversation is a **group chat** with Grok Bot semantics; DMs and threads
keep their wake rules. One function (`groupRecipients`, api-worker `commands.ts`) decides who a post wakes, for a
user's `message.post` and for a Run's reply alike:

1. A post with no mention wakes **every member Bot** (`channel_members` with a Bot actor), one delivery each in the
   `message.post` batch; a Channel without member Bots only posts. `<@bot:ID>` mentions narrow it to those Bots (a
   non-member joins, as before), `<@everyone>` (composer `@everyone` / `@all`) is every member, and a Reply
   (`message.post.replyToMessageId`, a message of the same conversation, stored as `reply_to_message_id`) on a Bot's
   message addresses that Bot. A Reply on a human message is a plain post.
2. The run context of a Channel Run adds `peers` (the other member Bots: id, name, first line of instructions ≤ 120
   chars) and `since`: up to 50 messages posted after this Bot's previous Run in the conversation, each with
   `speakerKind` (`human` | `bot`), `speakerName`, `isSelf` and a `replyTo` quote. The prompt gets a "Group
   conversation" block with the peers, `since` and the rule "Reply only if this message is for you or you own the next
   step; otherwise pass. Prefer a single owner. Do not repeat what a peer already said."
3. **Pass**: a Run in a Channel, thread or DM may call the in-run tool `hive_pass`; a Run that neither passes nor has
   final text passes too. The runner submits `run.result.submit {pass: true}` without `reply`; the Worker posts
   nothing, sets `runs.outcome = 'pass'` (migration 0023) and records a `runtime.run.passed` Event (subject the Run,
   no routing). Activity shows such a Job / Run as `passed`.
4. A Bot's reply posted into the Channel's main conversation is a group post for the **other** members: `@name` in the
   reply becomes a mention token (contracts `tokenizeMentions`), each delivery's Inbox item carries `hop + 1` and the
   chain's correlation id (the triggering Job's), and the author is never woken. Past max 4 hops or 20 correlated Jobs
   (§8.2) the reply is posted and wakes nobody.
5. **Coalescing**: a group delivery to a Bot that already has a `queued` / `waiting_device` / `active` /
   `waiting_input` Job triggered in the same conversation gets its Inbox item but no Job (the conditional
   `INSERT … SELECT … WHERE NOT busy` runs in the routing batch, so it is atomic with the busy check). The Bot's next
   Run reads those messages through `since`. When a Run in that conversation finishes, the same `finishRun` batch
   queues one follow-up Job for the newest delivery that arrived after the Run was created, unless the Bot is busy
   there again; deliveries already covered by `since` are marked handled with the Run's input items. No new table.
   `GET /v1/operations/:id` is `routed` once every delivery routed; a coalesced one keeps `jobId: null`.
6. **Presence**: `GET /v1/channels/:id/presence` gives each member Bot `working` (a Job triggered in the Channel is
   `active`), `reading` (`queued` / `waiting_device`) or `idle`; `typing` is reserved. The chat header shows reading /
   working Bots as pulsing blobs on the member count, and Members shows the state.
7. Bot-to-bot `agent.send` stays private in the `bot_pair` conversation and out of the Channel transcript.

### 7.3 Concurrency (§10.3)

- At most one external model turn per ProviderBinding. Background Runs may use separate Bindings per Task / lane.
  Conversation capacity and background capacity are separate so long Jobs cannot take every slot.
- Input to a running Run normally waits in the Inbox. Steering is used only through a dedicated adapter when the
  provider supports it safely; unsupported features are never faked by prompt injection.

## 8. Bot-to-bot messaging (§11)

Bot A → Bot B always goes through the cloud CommandService, regardless of PC placement.

```text
Bot A / Run A
  → scoped agent.send Command
  → D1 Message + Bot B Inbox
  → Job B → Scheduler → PC2 or PC1
  → Bot B / Run B
  → response Message / reply_to_message_id
  → Bot A Inbox
```

### 8.1 Message shape and permissions (§11.1)

- Message kind is `request / response / notification`, with `request_id`, `reply_to_message_id`,
  `correlation_id`, deadline, reply policy, context references. The sender comes from the Run capability, never
  from a self-declared `--reply-to bot-a`.
- Bot-to-bot Conversations are private by default; related Channels / Tasks get a summary or an accessible
  reference. Private memory or full transcripts are never auto-attached.
- Consultation does not change a Task's assignee. Formal delegation is `task.delegate`, fixing target Task, parent
  Execution, receiving Bot, read/write mode, resource scope, requirement version and deadline.
- The receiver's capability is the **intersection** of Workspace policy, Bot policy, Channel/Project ACL and the
  delegator's own authority. Nobody can delegate rights they do not hold.

Implemented as (DELEGATE-01): `task.delegate` / `task.delegate.revoke` with a `delegations` row and the receiver's own
Job (`delegation:<id>`). The intersection covers Workspace membership, the delegator's authority (a Bot must be the
Task's assignee or an active `write` delegate) and the read / write mode on the delegated Run's Task writes. Bots have
no pause state yet, Channel / Project ACL beyond that is not built, and resource scope / requirement versions are only
the Task's `scope_revision` at delegation. The pump closes a delegation when its Job ends (the delegator Bot gets a
`notify` message in the `bot_pair` conversation) and expires it at its deadline.

### 8.2 Chain and wait control (§11.2)

- Notifications are never auto-answered; reply policy applies only to explicit Requests. Each conversation has a
  hop count, total Run count, deadline and token/time budget. Defaults: max 4 hops, 20 related Runs. Users can
  change them; Bots cannot raise them.
- Bot A must not hold every slot while waiting for B. Standard path: end A's Run at a safe checkpoint, put the Job
  in `waiting_input`, create a successor Run after the reply. If the process is still alive, physical slots and
  resource locks are not released arbitrarily. Transferring a reservation from a stopped Run to its successor is
  an atomic ownership transfer that checks requirement version, environment snapshot and stop confirmation.
- Native subagent traffic is the exception, but claiming shared Tasks, formal Bot messages and external side
  effects still go through cloud authorization. Runtime parent/child relations and results are synced later as
  observations.

Implemented as (ROUTE-02): a Bot's reply in a Channel's group chat is a bot-to-bot step too. Each delivery it causes
carries `hop + 1` and the triggering Job's correlation id; the reply wakes nobody once the hop would pass 4 or the chain
already has 20 Jobs. Unlike `agent.send`, hitting a limit is not an error: the reply is still posted. Coalescing
(§7.2) bounds a round to at most one Job per member Bot.

## 9. Job / Run / Execution (§12)

### 9.1 States (§12.1)

- Job: `queued / waiting_device / waiting_input / active / recovery_required / succeeded / failed / cancelled`.
- Run: `starting / running / waiting_approval / stopping / unknown / succeeded / failed / interrupted / cancelled`. `unknown` is **not** "stopped": resource reservations are kept until later observation settles the
  real state.
- Execution: `active / submitted / finished / failed / interrupted`. `submitted` means a Result was submitted,
  independent of Task completion and process stop.
- Run exit, output sync, Job completion and Task completion are separate conditions. E.g. model succeeded but
  transcript upload pending shows `Run=succeeded, persistence=pending` and blocks resume on another PC.

### 9.2 Execution protocol (§12.2)

1. Scheduler picks candidate devices and records a short-lived offer. **An offer is not an execution right.**
2. The device calls `job.claim` over HTTPS.
3. The cloud re-validates Job state, actor, scope, dependencies, resources, device and provider capacity.
4. One D1 batch commits root Run, Execution, Reservation, lease, generation, receipt and outbox.
5. The executor stores the claim receipt and run launch intent in its Local Journal.
6. It starts the real process and records PID, start identity and the provider session/thread ID.
7. It sends `runtime.run.started` as an observation; if it fails before start is confirmed, it sends the failure
   reason and the process check result.
8. While running: renew the lease, journal and upload important events.
9. After exit: finalize artifacts, Result, usage and terminal events; release resources safely.
10. When the request-level completion policy is met, complete the Job. Task completion is evaluated separately.

Cloud state and OS spawn cannot share a transaction. If the start response is lost, reconcile the Journal with
the real process; never blindly re-spawn.

### 9.3 Cancel and approval (§12.3)

- The cancel API accepts `cancel_requested`; it is not stop completion. The executor runs provider interrupt /
  process-group stop, confirms the stop, then moves to a terminal state.
- Waiting for approval keeps the Run and its resources. If a long wait ends the Run, record how to resume and mark
  the previous provider approval request as expired. A new execution never reuses an old approval.

## 10. Device placement, lease, fencing, recovery (§13)

### 10.1 Device / environment registry (§13.1)

- Device: ID, owner, OS, agent version, last heartbeat, revocation, allowed Workspaces, capacity. Environment (per
  device): repository identity, checkout root, allowed paths, Tools / MCP, provider auth profile, sandbox mode,
  verified revision.
- "PC2 is online" is not enough to substitute. Check that repository, commit, write permission, auth, tools and
  working directory can be reconstructed.
- Local absolute paths are DeviceEnvironment data and never travel to other PCs. Cloud references use repository
  ID, commit SHA and artifact ID.

### 10.2 Placement policy (§13.2) — contract

Display order of preference: `Job override → Task → Bot → Project → Workspace`. This applies to preferences
only; safety constraints are always intersected (allowed device, path, tool, budget, data scope).

`pinned` = only the named PC. `preferred` = PC1 first, PC2 under allowed conditions. `any` = by capability and
capacity. Whether to wait for a busy PC1 or use PC2 is controlled separately by `overflowToFallback`.

```json
{
  "mode": "preferred",
  "allowedDeviceIds": ["pc1", "pc2"],
  "preferredDeviceIds": ["pc1", "pc2"],
  "fallbackOnUnavailable": true,
  "overflowToFallback": false,
  "environmentId": "backend-dev",
  "requiredCapabilities": ["claude", "git", "sandboxed-shell"],
  "recovery": "manual"
}
```

- The policy snapshot at placement time is stored on the Job / Run. Later policy changes never widen a running
  execution's rights; revocations and tightening trigger re-validation or stop.
- When one provider account is used on several PCs, a logical auth profile is registered in the cloud and its
  concurrency budget is shared. Switching PCs is never a way around quota.

### 10.3 Lease and fencing (§13.3)

- Defaults: heartbeat 15 s, lease 90 s, renew every 20 s, offer 30 s. These are configuration examples, not
  failure-detection guarantees. Time is server time.
- Lease renewal, Results, Task changes and broker-mediated side effects verify
  `run_id + device_id + execution_generation`. Control changes from expired / revoked generations are rejected.
- Past logs from an expired Run may be accepted through a limited provenance-upload API, but they cannot update
  current Task / Job state or the latest ProviderBinding. Late logs are stored as history of the past attempt.

### 10.4 Recovery decisions (§13.4)

| Situation                                | Response                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| Not started, PC1 unavailable             | Assign a new root Run to PC2 if eligible                                         |
| Unknown after launch intent              | Reconcile launch journal / process. If unverifiable → recovery_required          |
| Read-only and retryable, old Run unknown | safe_auto only with isolated environment, duplicate tolerance and output fencing |
| Old Run has unconfirmed writes           | Keep the reservation in quarantine even after lease expiry. No auto re-run       |
| PR creation / post response unknown      | Reconcile effect receipt against external state                                  |
| PC1 comes back                           | Generation mismatch → no new tools; stop old process and upload history          |
| All PCs down                             | Job waits in waiting_device. Conversation input accepted; inference waits        |

- **Lease expiry is not proof of physical stop.** Automatic handover requires isolation / broker enforcement so
  the old execution cannot write externally, or a confirmed stop. Environments allowing unrestricted Bash get no
  strong auto-failover.
- When the runtime loses connectivity, the executor stops starting new side-effecting tools before the lease's
  safe deadline, tries to stop long-running commands, and treats failures to stop as unknown.

## 11. D1 atomicity (§14)

### 11.1 Atomic boundaries (§14.1)

Each row below is committed in one D1 batch.

| Operation        | Stored atomically                                                            |
| ---------------- | ---------------------------------------------------------------------------- |
| agent.send       | Message, required Inbox items, Event, Receipt, Change Log, Outbox            |
| task mutation    | Task, dependency/result changes, requirement version, Event, Receipt, Outbox |
| event ingest     | source receipt, Event, router outbox                                         |
| event route      | consumer receipt, Delivery, Inbox, required Job, Outbox                      |
| job.claim        | Job CAS, Run, Execution, Reservations, lease, generation, receipt            |
| run completion   | Run terminal, permitted Result, Inbox outcome, Job state, Outbox             |
| approval resolve | approval one-use CAS, actor audit, resume/deny outbox                        |

D1 `batch()` runs a sequence of statements and rolls everything back on an SQL error [S08]. **But an
`UPDATE ... WHERE revision = ?` that matches 0 rows is not an SQL error**, so it does not by itself stop the
following INSERTs.

### 11.2 Rules (§14.2)

- Drizzle for normal queries and schema. Critical commands are dedicated repository methods using prepared SQL
  batches with CAS, UNIQUE, CHECK and FK.
- Complex Task plans record `workspaces.control_revision` at read time and compare it at commit. Task graph,
  policy, grant and claim changes bump it. Heartbeats, stream deltas and plain log writes do not; they are guarded
  by their own generation / lease conditions.
- Never silently overwrite user intent on conflict. Automatically re-evaluable scheduler commands use bounded
  retry; plan edits return 409 with the latest revision.

### 11.3 Making a 0-row CAS fail (§14.3) — contract

This shows **only the invariant pattern for a conditional update**, not the full Job claim. All statements are
sent as one D1 batch; the real claim adds eligibility, budget, lock and Event statements to the same boundary.

```sql
CREATE TABLE atomic_guards (
  operation_id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
);

-- 1. Optimistic update
UPDATE jobs
   SET state = 'active', revision = revision + 1
 WHERE id = ? AND workspace_id = ?
   AND state = 'queued' AND revision = ?;

-- 2. If the previous UPDATE did not touch exactly one row → constraint error → whole batch rolls back
INSERT INTO atomic_guards(operation_id, ok) VALUES (?, changes());

-- 3. INSERT Run / reservation / receipt / outbox, etc.
--    All statements are parameterized in the real implementation.

-- 4. Delete the guard at the end of the batch
DELETE FROM atomic_guards WHERE operation_id = ?;
```

`changes()`, the CHECK violation and batch rollback must be acceptance-tested on **real D1** (gate G-05). Passing
on local SQLite alone does not complete production D1 verification. In this repo, D1 tests run under
`@cloudflare/vitest-pool-workers` (miniflare D1), never `bun:sqlite`.

Resource reservations enforce one active owner per `(workspace_id, resource_key)` with a DB constraint. An
unknown writer's reservation is never deleted even if its lease expired. Until read/write coexistence exists,
reservations are exclusive only.

### 11.4 No wholesale event sourcing (§14.4)

Current Task / Job / Bot state lives in normal tables. Events are for audit, integration, redelivery and
rebuilding derived views. Replaying past events never re-executes external operations. D1 and DO never both
hold scheduler truth; a future move to DO authority would be a separate ADR with per-scope ownership switch,
migration and rollback.

## 12. Sync and realtime (§15)

### 12.1 Protocol (§15.1)

| Purpose                                        | Path                                                   |
| ---------------------------------------------- | ------------------------------------------------------ |
| Command / Query / Event ingest                 | HTTPS → Workers                                        |
| State delta sync                               | HTTPS `GET /sync/changes`                              |
| New work, cancellation, progress notifications | WebSocket → Realtime DO                                |
| Token / text deltas                            | Provisional over WebSocket; the final Message is in D1 |
| Transcripts / logs / artifacts                 | HTTPS upload → R2 manifest                             |
| Device heartbeat / claim / lease               | HTTPS. A WebSocket connection never substitutes        |

Clients connect outbound from the PC. No public ports, SSH or permanent inbound webhooks on PCs.

### 12.2 Change log (§15.2)

- `change_log` is appended in the same transaction as the change; the sequence is server-issued and never reused
  as an Event ID, provider entry ID, Run local seq or upstream timestamp.
- A change row holds target, operation, entity revision, projection or payload reference, access scope,
  timestamp. Deletes are tombstones. Streaming tokens never produce change rows.

```json
{
  "type": "sync.changed",
  "workspaceId": "ws-example",
  "cursor": "opaque-cursor",
  "scopes": ["conversation:conv-example"]
}
```

Notifications are refetch hints; losing one never affects state correctness. Clients fetch HTTP deltas on
reconnect, app foreground and periodic reconcile. Executors poll for eligible Jobs even if wake notifications
are lost.

Implemented as (UI-04): per-user preferences that every device of the user shares (the sidebar's pinned / hidden
items and groups) are one server-side JSON document per user and Workspace (`sidebar_prefs`, revision CAS through
`sidebar.update`). Its change row is scoped `workspace:<ws>` with entity kind `sidebar`, so clients refetch it with
the workspace lists; the row carries no content, and `GET /v1/sidebar` returns only the caller's own document.

### 12.3 Cursor and bootstrap (§15.3)

- A cursor is an opaque value combining workspace, authorization epoch and scan sequence. Gaps in the global
  sequence are normal. When rows are filtered by permission, the server still returns the scanned position so
  empty pages never loop.
- Bootstrap: obtain cursor H0, page through the current state of permitted scopes, then replay from H0. Compare
  entity revisions so older results never overwrite newer; apply tombstones. This is a converging bootstrap, not
  one giant snapshot read.
- An expired cursor returns `410 CURSOR_EXPIRED` and the scope is re-bootstrapped. Membership/ACL changes bump the
  auth epoch and purge no-longer-permitted cache; newly permitted scopes bootstrap then.

### 12.4 Authorization and connections (§15.4)

- Being in a Workspace does not mean receiving signals for all private Channels. Each connection records its
  principal and permitted scopes, checked on subscribe, permission change and auth refresh. Sensitive IDs or
  excerpts never reach unauthorized connections.
- Long-lived WS connections are not left open after revocation: short auth lifetimes, reconnect/re-auth, and
  immediate close on membership revoke. Access uses a hostname-based application (Worker-level Access has
  WebSocket upgrade limitations [S12]).

### 12.5 Offline and resend (§15.5)

- Unsent commands stored in the CLI / Electron local outbox show `queued_local`, which is not cloud `accepted`.
  On reconnect they are resent with the same operation ID and re-validated for conflicts, expiry and deletion.
- If normal execution cannot reach Cloudflare, it never silently falls back to local agent execution. A
  development-only isolated local mode uses a separate profile and ID space and never updates shared Sessions /
  Jobs.

## 13. Session, transcript, context, memory (§16)

### 13.1 Unit of continuity (§16.1)

LogicalSession lives long; ProviderBinding and ContextEpoch can be rebuilt. Provider-internal compaction does not
necessarily create a new Run or ContextEpoch; the Epoch advances when the app switches provider history. Epoch
reasons: `initial / explicit_reset / reconstructed / provider_change / device_migration / permission_change`
(distinct from execution generation).

### 13.2 Two-layer transcript (§16.2)

| Data                       | Storage / use                                                                  |
| -------------------------- | ------------------------------------------------------------------------------ |
| Normalized history         | Messages, tool summaries, decisions, Results. D1 / R2. For UI, search, context |
| Provider-native transcript | SDK-owned opaque data. Restricted R2. For exact resume                         |

Provider-native data is never modified for search; redaction goes into a separate normalized projection. It may
contain secrets, so it is encrypted, ACL-restricted and retention-limited. Provider auth directories and OAuth
credentials are never uploaded with transcripts.

### 13.3 Claude SessionStore adapter (§16.3)

The official SessionStore exposes `append / load` and must preserve order and equality of stored data. Mirroring
is best-effort, and some restore paths delete the local copy on exit [S09].

```text
SDK append
  → durably store the batch in a dedicated local SQLite journal
  → return from append only after that succeeds
  → uploader sends to api-worker
  → store and verify immutable R2 part
  → commit D1 manifest / dedupe / contiguous watermark
  → cloud ACK
  → mark journal entry sent (delete after retention)
```

- The journal lives outside the SDK's temporary config directory. Disk full / journal failure is a reliability
  failure that stops or degrades the Run. The app never ignores a `mirror_error` even if the SDK continues.
- Stream key: `binding + projectKey + nativeSessionId + opaque subpath`. Appends to a stream are serialized.
  Use entry UUIDs where present; otherwise stable part ID + position. **Content-hash-only dedupe is forbidden**
  (it would drop legitimately repeated content).
- `load` returns contiguous confirmed parts in order. Gaps, unknown schema or hash mismatch mean incomplete: no
  exact resume. `listSubkeys` etc. are implemented against conformance tests for the adopted SDK version.
- Never write on the existing PC and resume on PC2 concurrently: check the ProviderBinding write lease and
  execution generation. Late parts from old attempts are isolated as a historical branch.
- working directory / projectKey, sidecars, plugin settings and file checkpointing combinations are part of the
  Phase 0 compatibility tests. Copying files is not assumed to restore a session.

Implemented as (SESSION-01): the journal is a fsynced JSONL file per stream under `<state-dir>/sessions/`, not SQLite.
The stream key is `sessionId + subpath`; `projectKey` is ignored because the SDK derives it from the cwd, which is a
per-run scratch directory. The uploader mirrors the journal after the Run, not per batch. In the cloud each uploading
Run stores its own complete snapshot (`transcript_streams.kind = 'session'`); `load` takes the newest complete one,
so a late upload from an older attempt is history without a write lease. A Run resumes an earlier Run's session only
when `load` returns it; otherwise it starts fresh.

### 13.4 Codex adapter (§16.4)

Codex app-server speaks a local stdio JSON protocol: initialize on connect, map thread / turn, notifications and
approval requests to the domain [S13]. The MVP prefers same-device provider resume. Cross-PC native restore is
enabled only once verified for the adopted version; otherwise keep the LogicalSession and start a new thread with
the current Task / Memory / conversation summary.

### 13.5 Context builder (§16.5)

- Built by the local executor using the cloud's authenticated Query / Search APIs. Inputs: Bot config, purpose,
  Conversation, Task snapshot, Inbox batch, ContextEpoch.
- Priority: enforced policy → Bot role → current purpose and open requests → current Task state → recent
  conversation → conversation summary → related Memory → history search results → required fresh external info.
- Token budget = provider limit − system/tool definitions − output headroom. Truncation records `truncated` and
  unfetched references. Old summaries never override the current Task state.
- ContextSnapshot stores input message IDs, memory revision IDs, task scopeRevision, bot config revision, source
  ACL epoch, summary IDs used and token estimate. There is no mechanism to capture private model reasoning.

### 13.6 Memory and compaction (§16.6)

- Memory scopes: Workspace / Channel / Project / Bot / Task. Bot-specific Memory inherits the read restrictions of
  its sources; knowing something does not let a Bot carry it to another Channel.
- Memory has content, source, creating actor, valid time, revision, supersedes, confidentiality scope and approval
  state. Conflicting facts show source and confidence instead of "newest wins".
- Explicit `memory.write` is separate from auto-extracted candidates; promotion to Workspace scope goes through
  policy. Extraction / consolidation / summarization LLM work runs as Local Executor Jobs; Workers only trigger
  and store.
- Before summarizing, preserve open requests, decisions, prohibitions, in-flight Tasks and references. Summaries
  record their coverage and link back to originals. Memory updates are picked up on the next turn / ContextEpoch,
  never by rewriting running provider history.
- If revoked or re-scoped confidential data is already in a provider context, rebuild a ContextEpoch from only the
  new permitted scope. Removing it from search does not erase it from an old context.

## 14. Search (§17)

FTS5 lives in D1. Local FTS is only an optional offline cache. PC1 and PC2 query the same Search API [S07].

### 14.1 Search documents (§17.1)

- `search_documents`: source kind / source ID / source revision / chunk key / title / body / language / source
  refs / ACL scope / deleted_at. Indexed: normalized Messages, SessionSummaries, Memory, Tasks, Decisions,
  important ToolResults.
- Never index raw transcript JSON, credentials or unlimited Bash stdout. The index is a deletable, rebuildable
  projection.

```sql
-- Example. Maps to the integer rowid of search_documents.
CREATE VIRTUAL TABLE search_fts USING fts5(
  title,
  body,
  tokenize = 'trigram'
);
```

- SQLite trigram supports substring search including Japanese but has limits for MATCH terms under 3 characters
  [S14]. Verify the tokenizer on real D1; cover short Task keys, PR numbers, names etc. with typed exact/prefix
  indexes or scope-narrowed string search. No unbounded full-table LIKE.
- Search normalization such as NFKC goes into a separate projection. The Search API quotes/tokenizes input; user
  strings are never evaluated as FTS syntax or SQL.

### 14.2 Updates and permissions (§17.2)

- The index consumer reads the source revision and never overwrites a newer index with an older event. Document
  and FTS rows change in the same batch. Deletes check tombstone and source version so late redelivery cannot
  resurrect data.
- Queries check `search_document_scopes` against the current principal. Snippets, counts and source links follow
  the same rules; fetching the original after a hit is re-authorized.
- UI / Bots receive `indexed_through` and source revision to detect index lag. Current Task / Approval / Job state
  is never read from search; use the normal Query API.
- FTS virtual tables have D1 export limitations, so backups center on source tables and the index is regenerable.
  Breaking FTS in production to make export pass is not a standard procedure [S15].

## 15. GitHub integration (§18)

### 15.1 Intake and permissions (§18.1)

- The GitHub App may subscribe to a broad set of event types, but installed repositories and the permission
  ceiling are set by a human. Bot Subscriptions choose within that ceiling. Available events depend on permissions
  [S16].
- Initial read: Metadata, Contents, Pull requests, Issues, Checks, Actions, Commit statuses. Write scopes only when
  PR/Issue comments or changes are allowed. Bots never receive installation tokens or the App private key; the
  Integration Broker performs permitted operations.
- Received events: `pull_request`, `pull_request_review`, `pull_request_review_comment`, `issue_comment`,
  `issues`, `check_run`, `check_suite`, `workflow_run`, `push`. Normalize event + action, keep repository ID,
  PR/Issue number, head SHA, sender, source delivery ID.
- This is not unconditional ingestion of a user's GitHub Notifications inbox; "notification-driven" means GitHub
  App webhook events.

### 15.2 Webhook intake (§18.2)

- Verify `X-Hub-Signature-256` over the raw body; resolve App / installation / repository server-side [S17].
  Uninstall, permission change or repository deletion re-evaluates matching Subscriptions and pending Jobs.
- GitHub expects a 2xx within 10 s, so only durable acceptance happens before model execution [S18]. Internal
  target is under 1 s, to be measured.
- Never rely on infinite upstream redelivery: provide delivery reconciliation, manual redelivery and refetching
  current PR/CI state. Rejected oversized payloads surface as missing coverage.

### 15.3 Example flow (§18.3)

Coding Bot creates a PR → explicitly links Task and PR → creates a permitted Subscription → receives review
notification → batch in the Task lane → refetch current PR HEAD and reviews → handle in a new Execution.

- CI event order is not assumed. An old SHA's failure never rolls back a new HEAD's success. Consecutive events on
  one PR are debounced; handled reviews/comments have receipts.
- The Bot's own PR posts are recorded as causes, but "ignore all bot events" is not the rule: useful CI-bot or
  approved-bot notifications are accepted; only echoes of the same effect are suppressed.

## 16. Slack integration (§19)

### 16.1 Transport and scopes (§19.1)

- Production standard: HTTP Events API → integration-worker, so events arrive even with all PCs off. A Socket Mode
  adapter for local development may be added; the normalized path is the same.
- Initial events: `app_mention / message.channels / message.groups / message.im`; Assistant surface optional;
  `message.mpim` etc. as needed. Listing/joining/posting scopes are granted separately from history scopes.
- `app_mention` is a mention of the app, not of an arbitrary user [S19]. `user_mention` watching is decided from
  user ID references in accessible message events, never by name string matching or stripping all `<@...>`.
- What Slack delivers depends on scopes, installation, channel membership and workspace policy [S20]. Private
  channels need proper membership; creating a Subscription grants no visibility.

### 16.2 Thread / channel watching (§19.2)

Thread identity is `(team_id, channel_id, thread_ts)`, stored as an ExternalRef linked many-to-many to
Conversations / Tasks / Projects.

| Watch          | Target and behaviour                                                        |
| -------------- | --------------------------------------------------------------------------- |
| thread         | Replies in a registered thread; edits/deletes reflected                     |
| channel        | Root posts and replies; optionally root-only / replies-only                 |
| app_mention    | Direct mentions of this app, routed to authorized Bots                      |
| user_mention   | Mentions of specific user IDs in permitted conversations                    |
| dm             | DMs to the app, mapping permitted requesters to Bots                        |
| related-thread | Visible threads containing related PR / Issue / Task URLs become candidates |

- Finding a thread by search does not fetch or share its full history; context fetch checks scope first.
  `conversations.replies` handles token/scopes, pagination and rate limits, and reports fetched vs missing range
  [S21].
- When several Bots watch one thread, a Conversation routing rule decides who replies; never wake every Bot as if
  mentioned.

### 16.3 Intake, edits, duplicates (§19.3)

- Verify `X-Slack-Signature` and the request timestamp over the raw body; handle URL verification [S22]. Slack
  needs a response within 3 s, so intake is limited to verification and durable acceptance [S20].
- Besides source `event_id`, collapse the same post observed as both `app_mention` and `message` by logical
  message identity. Edits/deletes are new change versions that update the read model and search projection.
  Running Runs get cancel/change follow-up events; history is not rewritten.
- The app's own posts are matched via effect receipts. Exclusion rules like `!aside` are explicit channel policy;
  observation and wake exclusion are separate.

### 16.4 Observation is not command (§19.4)

- Reading a channel does not mean its posters may instruct a PC. Unregistered users' posts are observation data,
  never wired to remote Bash.
- Slack users map to app users by explicit identity mapping, never display names. Approval buttons verify the
  app-issued approval ID, actor, Run generation, expiry and request hash.

## 17. Subscription / Routine / Webhook (§20)

### 17.1 Subscription contract (§20.1)

```ts
type Subscription = {
  id: string;
  botId: string;
  integrationId: string | null;
  eventTypes: string[];
  filter: FilterExpression; // allowed AST only; no arbitrary eval
  destination: {
    conversationId: string;
    projectId: string | null;
    taskId: string | null;
  };
  delivery: {
    mode: "notify" | "wake" | "batch" | "append";
    debounceMs: number;
    maxBatchItems: number;
    maxDelayMs: number | null;
    ttlSeconds: number;
  };
  enabled: boolean;
  expiresAt: string | null;
  revision: number;
};
```

- Bots get `subscription.create / update / pause / delete / test / list`. `test` is a dry-run over recent
  permitted events and creates no Jobs or external posts.
- Widening watch scope, forwarding to other Channels, external posting and raising autonomous budgets go through
  policy / approval. Information-sharing conditions between source and destination are checked. A broad GitHub
  App scope is no reason to give every Bot every event.

### 17.2 Routine (§20.2)

- A Routine has target Bot, Conversation, Project / Task, input template, trigger, timezone, misfire, concurrency,
  retry, approval, enabled. Natural language like "weekdays at 9" is shown as a structured rule before saving.
- A Cloudflare cron tick scans D1 `next_fire_at`. UTC occurrences are computed from the user timezone and deduped
  by `routine_id + schedule_revision + scheduled_at`. Second-level precision is not guaranteed.
- Misfire policy: `skip / coalesce / bounded_catch_up`. Status checks default to `coalesce`; must-process-all
  business work uses bounded catch-up. PC offline and tick delay are distinguished. DST: nonexistent local times
  are skipped by default, repeated local times run once; if both are configured to run, each UTC occurrence is
  identified separately.
- Routines never call a model directly; they create Events / Jobs. Manual runs use the same Job contract.

Implemented as (UI-03): the desktop presents Routines per Channel. The Channel panel lists the Routines whose
Conversation is the Channel's (`GET /v1/routines?conversationId=`), each with its assigned Bot, and creates new ones
into that Conversation; the Bot panel lists a Bot's Routines across Channels. `routine.delete` removes the Routine and
its occurrence history in one batch; Jobs it already created stay. The Channel panel also shows the Channel's topic
(`channels.topic`, set by `channel.update`, members only) and its members; Bots join no Channel today, so the members
list adds the actors that posted in it.

### 17.3 Webhook / MCP (§20.3)

- Generic webhooks have integration ID, schema, HMAC secret, replay window, payload size and rate budget. Bots may
  create URLs; viewing/rotating secrets is a separate permission. Secrets are never auto-inserted into logs or
  model context.
- MCP tool use and event intake are separate. Servers with subscribe/notify support are normalized by an adapter;
  others use an explicit polling Routine. A common push event across arbitrary MCP servers is not assumed.

## 18. Authentication, authorization, secrets (§21)

### 18.1 Hosts and credentials (§21.1)

| Host / connection    | Authentication                                             |
| -------------------- | ---------------------------------------------------------- |
| api.example.com      | Hostname-based Access, user allow policy and Managed OAuth |
| executor.example.com | Hostname-based Access, per-device Service Auth             |
| hooks.example.com    | No Access login; provider signature / shared secret        |
| Worker to worker     | Private Service Binding + permitted service methods        |
| Local IPC            | Unix domain socket / named pipe restricted to the OS user  |

- CLI / Electron use the system browser with Authorization Code + PKCE. Access Managed OAuth returns an opaque
  token; the origin verifies Access's signed assertion [S23] with `jose` (signature, issuer, audience, expiry) and
  maps the subject to an internal user.
- Android: system browser + HTTPS App Link redirect first. Access redirect allowlist, app link verification,
  PKCE, state and refresh are verified on device. Arbitrary custom URL schemes are not assumed to work.
- The Local Executor maps a per-device Service Token to this app's device registration. No single shared token
  for all PCs. Service identity ↔ Device ID is verified so a forged `X-Device-Id` is useless. A service token does
  not make anyone a Workspace admin.

### 18.2 Run capability (§21.2)

Bots never receive a human's long-lived token. They use a capability bound to the current Run / Task / Bot /
Device / generation / expiry, held by the executor-side broker, which exposes only the needed scoped operations to
the model and tools. Access is the entrance, capability is per-job authority; both are verified. Revoked devices,
invalid delegations, expired approvals and stale-generation writes are rejected.

### 18.3 Local trust boundary (§21.3)

- With the same OS user and unrestricted Bash, file permissions and env vars cannot fully isolate long-lived
  credentials from the model. Bots needing strong isolation use a separate OS user / sandbox / container and
  restricted network.
- A working-directory allowlist alone cannot restrict arbitrary Bash filesystem access. Layer provider sandbox, OS
  sandbox and broker policy. Show each device's guarantees; `unsafe_host_access` environments are excluded from
  safe_auto recovery.
- External documents, Slack posts, PR comments and search results are not trusted instructions and never justify
  changing system policy, approvals, tool permissions or subscription ceilings.

### 18.4 Which secrets live where (§21.4)

- Cloud: GitHub App private key, Slack tokens, webhook signing secrets and other intake/broker credentials, in
  Workers Secrets or a properly managed encrypted credential store.
- PC: Claude / Codex personal auth, local SSH keys, PC-specific credentials. Never in the UI renderer, event
  payloads, Templates, Memory or normal audit logs.
- Run transcripts can contain secrets via tool output. Normalized logs are redacted; raw stores enforce access
  restriction and retention. If safe redaction is impossible, storage for exact resume can be disabled.

## 19. Approval / Effect broker (§22)

- An Approval has approval ID, workspace, requester Run, execution generation, action kind, normalized arguments
  hash, cwd / environment, resource scope, expires_at and approver policy.
- It is resolved exactly once, from pending, through the same API regardless of UI / CLI / Slack. Casual
  conversation ("ok", "go ahead") is never interpreted as approval of a dangerous operation.
- If command, target or requirement version changes after approval, re-approve. An approval from the old PC is never
  reused by another Run on PC2. Failure or timeout means deny / paused; never fail-open.
- External posts, PR creation etc. store intent in `effects` and separate claim → perform → reconcile. States:
  `prepared / executing / succeeded / failed / unknown`. Unknown external responses are never auto-resent.
- Use the external API's idempotency key where available; otherwise operation markers, existing-object lookup and
  receipts. If unreconcilable, manual recovery. If a GitHub token is handed to a local shell for external writes,
  the UI states that this is outside the broker's duplicate-prevention guarantee.

## 20. Local executor (§23)

### 20.1 Processes (§23.1)

- Electron renderer = UI; main = auth, local communication, window management. The Local Executor is an OS
  resident service that keeps running when Electron windows close. Closing the app and stopping the executor are
  separate actions.
- Executor modules: ConnectionManager, CloudClient, JobRunner, ProcessSupervisor, LocalJournal, Uploader,
  ContextBuilder, ProviderAdapter, ToolBroker, Collector.
- macOS is the first real target. Linux / Windows get adapters, each verified for process-tree stop, credential
  storage and path isolation. Android never runs the agent runtime.
- Implemented as (macOS, DESKTOP-SVC-01): a launchd user agent whose program is the Electron app itself started
  with `--executor` (headless, running the CLI's `executor run` code). Electron main reconciles the agent on every
  start (reinstalls unless the plist is identical and running), so the service never runs another build; closing
  or quitting the app leaves it running, Stop only unloads it. See `apps/desktop/README.md`, Executor service.
- Implemented as (LOGIN-01): main also owns first run. Until the credentials file has an API URL, a usable grant, a
  Workspace and a device token, the renderer shows a Welcome screen whose steps call main (`config.set`, `login`,
  `device.register`); registration runs the CLI's own `device register` and then the same service reconcile, and
  Sign out (account menu, confirmed in a dialog) runs `hive logout`. The renderer still never sees a token. See `apps/desktop/README.md`, Welcome / first
  run.

### 20.2 Startup and crashes (§23.2)

- On startup: authenticate device, check environment, recover unsent journal entries, reconcile existing processes
  and cloud Runs — only then claim new Jobs.
- Per Run record process group, PID + start identity, cwd, engine version, auth profile, capability, Job and
  Execution mapping. PID alone is never used to decide a stop (PIDs get reused).
- Spawn shell commands with proper argv and cwd; never build a shell string from user values. Full invocations may
  contain secrets, so normal audit stores executable / argument shape / digest / redacted summary.

### 20.3 Runtime hooks (§23.3)

- Independent hook pipeline: `before_spawn / before_tool / after_tool / before_external_write / after_turn / before_compaction / run_end`.
- `before_*` hooks return `allow / deny / ask`; timeout means deny or paused. Mandatory safety hooks cannot be
  skipped by plugin order or stop decisions. Observation hooks failing never re-run a tool, but if a mandatory audit
  record cannot be saved, execution stops.
- If a provider's native tool offers no required pre-control, replace it with a wrapped dedicated tool or mark that
  permission mode unsupported. Being able to observe is not being able to control.

### 20.4 Provider adapter contract (§23.4) — contract

```ts
type AdapterCapabilities = {
  resumeSameDevice: boolean;
  resumeOtherDevice: boolean;
  externalSessionStore: boolean;
  steerActiveTurn: boolean;
  nativeChildIdentity: boolean;
  enforceToolApproval: boolean;
};

type RuntimeObservation = {
  localSequence: number;
  kind: string;
  providerEventId: string | null;
  payload: unknown; // validated against a per-kind schema
};

interface RunningAgent {
  observations: AsyncIterable<RuntimeObservation>;
  requestStop(reason: string): Promise<void>;
  respondApproval(requestId: string, decision: "allow" | "deny"): Promise<void>;
  waitForExit(): Promise<{ code: number | null; reason: string }>;
}

interface AgentAdapter {
  describe(): Promise<AdapterCapabilities>;
  preflight(input: PreflightInput): Promise<PreflightResult>;
  start(input: LaunchContext): Promise<RunningAgent>;
  restore(input: RestoreContext): Promise<RestoreResult>;
}
```

These are app-specific interfaces; detailed types live in `packages/contracts`. Extracting provider IDs / native
child IDs from observations is the adapter's job; an LLM claiming an execution identity is never accepted.

### 20.5 External CLI collector (§23.5)

- Providers launched by the app are linked through an explicit Execution Context. External CLIs are collected via
  their SessionStart / Prompt / Tool / End hooks.
- cwd, branch or a shared session env never decide the Task. Without a confirmed context, records stay unassigned
  with suggested candidates. Event coverage is shown as `managed / observed / partial`.
- Task rollups show Run time, tool count, usage, commits, PRs, failures, artifacts. Tokens of a Run touching several
  Tasks are never charged in full to each without basis; unallocatable usage stays unattributed.

Implemented as (GIT-01): commits and PRs only, for executor-launched Runs in an environment checkout. The executor's
`git.collected` observation is stored per Run in `run_git` and rolled up on `GET /v1/tasks/:id`; the external CLI hooks
path, usage / failure / artifact rollups and token attribution are not built.

## 21. UI views (§24)

| View            | Shows / does                                                                           |
| --------------- | -------------------------------------------------------------------------------------- |
| Channel         | Conversation, threads, member Bots, related Projects, quotes/attachments, unsent state |
| Project         | Task list / board, assignees, dependencies, progress, related Channels                 |
| Task            | Requirements, assignee, status, DAG, Runs/Sessions, PRs, results, verification         |
| Bot             | Role, Skills, Memory, memberships, Subscriptions, execution policy                     |
| Inbox           | Input, origin, unprocessed, batches, TTL, handling Job                                 |
| Activity        | Queue, running, approval, unknown, failed, recovery                                    |
| Run Inspector   | Observation history, tools, provider IDs, input snapshot, sync gaps                    |
| Agent Tree      | Native actor parent/child; a separate screen from the Task DAG                         |
| Integration     | GitHub / Slack permissions, watch targets, events, intake errors                       |
| Subscription    | Filter, last match, delivery state, wake count, stop, dry-run                          |
| Memory / Search | Source, revision, scope, conflicts, citations, index freshness                         |
| Device          | PC priority, environment, online/unknown, auth, capacity, reservations                 |
| Routine         | Schedule, timezone, misfire, run history, pause                                        |
| Approval        | Target operation, location, diff, request hash, expiry, approve / deny                 |

- Implemented as (UI-04): the desktop sidebar follows Slack's layout: workspace name, a name filter, the view rows,
  then Starred (pinned), the user's groups, Channels, Bots and Hidden, with an item menu (Pin, Move to group, Copy ID,
  Hide) and drag to reorder. The layout is the server-side document of §12.2, so it follows the user to other devices.
  The Channel view groups messages by day under sticky date pills.
- Desktop shows accepted, delivered, started and completed separately; "sent" never means "the agent has read it".
  PC1 and PC2 show the same source of truth, and output that exists only in the local journal is marked unsynced.
- Electron enables context isolation / sandbox, gives the renderer no Node or shell API, validates IPC sender and
  arguments, applies CSP, restricts external URLs and sanitizes HTML [S24].
- Android syncs over WebSocket / HTTP in the foreground and uses FCM in the background, fetching fresh state over
  HTTPS on open. Notification payloads carry only identifiers and minimal display info, never secrets or approval
  credentials. Push is never the sync source of truth [S25]. Always-on WebSocket is not guaranteed (force-stop,
  battery control). Approval validity is checked when the API receives the answer, not at notification time.

## 22. API contract (§25)

### 22.1 Common rules (§25.1)

- Prefix `/v1`. JSON, UTF-8, UTC ISO 8601. Commands and Observations use strict Valibot validation. Client-supplied
  workspace IDs are checked against membership.
- Commands carry a client operation ID and an idempotency key. Task / Bot / Subscription edits carry
  `expectedRevision`; requirement changes carry `expectedScopeRevision`. If accepted but no Job exists yet, never
  invent a job ID.

### 22.2 Endpoints (§25.2)

| Method / path                                              | Responsibility                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| POST /v1/commands                                          | Common intake for typed domain commands                        |
| POST /v1/events                                            | Event emission by CLI etc. within permitted namespaces         |
| POST /v1/observations                                      | Scoped runtime / tool / Git / collector observations           |
| GET /v1/operations/{id}                                    | Acceptance, delivery, processing state and created entity refs |
| GET /v1/channels / conversations / projects / tasks / bots | Queries over permitted resources                               |
| GET /v1/jobs/{id} / runs/{id}                              | Execution state, inputs, results, recovery info                |
| GET /v1/inbox                                              | Processing state per recipient Bot / lane                      |
| GET /v1/sync/changes                                       | Authorized changes after a cursor                              |
| GET /v1/search                                             | Search by scope, kind, query, cursor                           |
| GET /v1/realtime                                           | Access-protected WebSocket upgrade                             |
| POST /v1/uploads/init                                      | Limited upload authorization and object ID                     |
| POST /v1/uploads/complete                                  | Verify hash / size and commit the manifest                     |
| GET /v1/artifacts/{id}                                     | Re-authorized object fetch                                     |
| GET /v1/transcripts/{bindingId}/manifest                   | Contiguous parts and state for restore                         |
| POST /hooks/github/{integrationId}                         | External intake with GitHub signature verification             |
| POST /hooks/slack/{integrationId}                          | Slack Events / URL verification                                |
| POST /hooks/slack/{integrationId}/actions                  | Slack approvals etc., converted to domain commands             |

Common query params are `limit / cursor`. The UI never GETs a huge transcript in one request. Webhooks are on a
separate host / Worker route.

### 22.3 Main commands (§25.3)

```text
channel.create / channel.member.add / channel.archive
bot.create / bot.configure / bot.pause
project.create / project.update
task.create / task.assign / task.plan / task.replan / task.complete / task.cancel
agent.send / task.delegate
subscription.create / subscription.update / subscription.pause / subscription.test
routine.create / routine.update / routine.run / routine.pause
job.start / job.claim / job.cancel / job.retry / job.resolve
run.lease.renew / run.result.submit
approval.resolve
memory.write / memory.propose / memory.promote / memory.delete
device.register / device.configure / device.revoke
```

Job claim, lease renewal and runtime outcomes require the dedicated Executor principal. Humans and Bots never
emit internal service events directly as a substitute.

### 22.4 Request / response example (§25.4)

```json
{
  "operationId": "op-example",
  "idempotencyKey": "send-example",
  "workspaceId": "ws-example",
  "command": {
    "type": "agent.send",
    "recipientBotId": "bot-coding",
    "conversationId": "conv-development",
    "message": {
      "kind": "request",
      "text": "Check the review comments on PR #123"
    },
    "delivery": "wake"
  }
}
```

```json
{
  "operationId": "op-example",
  "status": "accepted",
  "messageId": "msg-example",
  "inboxItemId": "inbox-example",
  "jobId": null,
  "routingStatus": "pending",
  "receivedAt": "2026-10-11T00:00:00Z"
}
```

Return a Job ID only if one was created synchronously. Never show `assigned: pc1` before a device is decided.

### 22.5 Errors (§25.5) — contract

| Code                 | HTTP / meaning                                      |
| -------------------- | --------------------------------------------------- |
| UNAUTHENTICATED      | 401 / Access or credential refresh needed           |
| FORBIDDEN            | 403 / actor, scope or grant mismatch                |
| NOT_FOUND            | 404 / does not exist, or existence not disclosed    |
| REVISION_CONFLICT    | 409 / refetch and update explicitly                 |
| IDEMPOTENCY_CONFLICT | 409 / same key, different request                   |
| STALE_GENERATION     | 409 / change from an old Run                        |
| RESOURCE_BUSY        | 409 / reserved by another Run / unknown writer      |
| CURSOR_EXPIRED       | 410 / scope bootstrap required                      |
| INVALID_INPUT        | 422 / type, dependency cycle or policy violation    |
| RATE_LIMITED         | 429 / follow Retry-After                            |
| UPSTREAM_UNAVAILABLE | 503 / not durably accepted, or provider unavailable |

If a Job can be accepted as `waiting_device`, a missing PC is never a 503. Error responses include request ID,
operation ID, `retryable` and a safe detail. Implemented in `packages/contracts` (`ApiError`, `apiErrorStatus`).

## 23. CLI contract (§26)

**Normal CLI use, targeting another PC, and CLI calls from Bots all go through Cloudflare.** If the CLI uses the
Local Executor IPC, it is only for credential brokering / durable send, never to skip the shared claim.

```bash
# Ask a Bot directly. No Subscription needed.
hive agent send coding-bot \
  --channel development \
  --message 'Check the review comments on PR #123'

# Emit a custom Event. With no subscribers, no Bot starts.
printf '%s\n' '{"command":"bun test","exitCode":1}' | \
  hive event emit custom.build.failed \
    --project backend --data-file -

# Explicit Task execution. Even with a device, Cloudflare authorizes and claims.
hive job start --task APP-123 --bot coding-bot --device pc1

# Watch execution and inputs
hive job watch job-example
hive event inspect evt-example
hive inbox list --bot coding-bot
hive task list --project backend --format json

# Common surface for Bots to manage watch conditions
hive subscription create --file subscription.json
hive subscription test subscription-example
hive subscription pause subscription-example

# Offline: store only. Never run locally right away.
hive agent send coding-bot \
  --message 'Look at this later' --offline-queue
```

- `--wait` watches the Job created from the operation. Closing the CLI never cancels an accepted Job; a watch
  timeout is not Job cancellation.
- stdout is human output or a stable JSON envelope; stderr is diagnostics. With `--format json`, no progress text
  on stdout. Secrets come from a secure credential store, owner-private file or stdin, never arguments.
- Exit codes: `0` cloud accepted or waited-for success, `2` invalid input, `3` auth/permission, `4` conflict,
  `5` watched Job failed, `6` wait timeout, `7` network / not accepted, `8` `queued_local` (distinguishable from
  normal acceptance).
- Operation IDs are stored locally for resend. After a network timeout, query the existing operation before
  re-requesting with a new ID.

## 24. Plugin / MCP / tool surface (§27)

Cloud integration adapters and local runtime plugins run in different environments and are separate.

```text
Cloud Integration:
  verify → normalize → resolveIdentity → ingest

Local Runtime:
  describeCapabilities → start / restore → observe → approve / stop

Domain Extension:
  typed command / schema / deterministic event handler
```

- Plugins never write D1 tables directly; they use the CommandService. Skills / Routines / Subscriptions created by
  Bots are data, distinct from installing arbitrary admin plugin code.
- Dynamic loading is P2; initially version-pinned first-party modules. Registering/starting an MCP server checks
  executable, network, auth and source trust, and needs approval when crossing the Local Executor admin boundary.

## 25. Monorepo layout and dependency direction (§28)

Target layout. Only `packages/contracts`, `packages/db` and `apps/api-worker` exist today; later tickets add the
rest.

```text
apps/
  api-worker/             # Hono / Access / CommandService entry / Realtime DO
  integration-worker/     # GitHub / Slack signature endpoints
  background-worker/      # Queues / Cron / routing orchestration
  desktop/                # Electron main / preload / React renderer
  mobile/                 # React Native Android
  executor/               # Node.js daemon / OS service
  cli/                    # hive
packages/
  contracts/              # Valibot schemas / inferred TS / API error types
  domain/                 # Task / Event / Inbox / Job / Policy / Memory rules
  db/                     # Drizzle schema / migrations / atomic repository methods
  cloud-client/           # OAuth-aware typed HTTPS / retry / idempotency
  sync-client/            # cursors / revisions / cache invalidation
  local-runtime/          # supervisor / journal / hooks / tool broker
  adapter-claude/
  adapter-codex/
  context/                # retrieval plan / token budget / snapshots
  session-store/          # native transcript journal / manifest adapter
  integration-github/
  integration-slack/
  test-fixtures/
infra/
  terraform/
  environments/
docs/
```

- `domain` imports no Cloudflare / Node / SDK-specific APIs. `contracts` is the lowest layer, shared by client and
  server. Drizzle schema is the DB-side source of truth; Valibot is the source of truth for external API schemas.
  They have distinct responsibilities.
- The cloud client controls command retry with idempotency keys. SDK provider retries, app Job retries and Queue
  retries never share one retry counter.
- CI separates format / lint / typecheck / unit / migration / integration. Wrangler compatibility date and the
  lockfile are pinned; adopted Claude SDK / Codex versions and capability test results are recorded.
