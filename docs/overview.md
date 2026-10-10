# Overview

> Status of this document: implementation baseline distilled from the v1.0 requirements/design
> (2026-10-11). It is **not** a statement that anything is implemented or validated in production.
> Statements fall into three classes:
>
> - **Decided** — product/architecture policy agreed during design.
> - **Initial design** — concrete models, APIs and defaults proposed here; tunable during implementation.
> - **Verification gate** — external auth, SDK or runtime behaviour that must be proven on real
>   accounts/devices before it is relied on (see [roadmap.md](roadmap.md#gates)).

## 1. Product definition

**Bots with a role, memory and permissions join topic-oriented Channels and do background work on the
user's own PCs, triggered by conversation, Tasks and external events.**

Cloudflare is the source of truth for shared state and execution coordination; PCs are where agents run.
Electron, Android, the `hive` CLI, GitHub, Slack and bot-to-bot messages all use the same cloud-side
intake, authorization, delivery and execution management.

"Local first" here means **local execution first**. It does not mean cloud and local each update shared
state independently. Shared features require a connection to Cloudflare; while disconnected, clients use a
local outbox and stop safely.

### 1.1 Adoption decisions

| Topic                | Decision / initial design                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Desktop              | Electron + React. UI and Local Executor are separate processes                            |
| Mobile               | React Native / Android. Conversation, search, notifications, approvals, work status       |
| CLI                  | TypeScript CLI, usable by humans, shells and Bots alike                                   |
| Cloud                | Workers + Hono + D1 + Drizzle + Valibot + Cloudflare Access                               |
| Realtime             | Durable Objects / WebSocket. Authoritative sync is HTTPS + delta cursors                  |
| Async delivery       | Cloudflare Queues. The source of truth for waiting Jobs is D1                             |
| Large storage        | R2: transcripts, artifacts, logs, recovery data                                           |
| Search               | D1 FTS5 over permissioned, derived Documents                                              |
| Execution            | Claude Agent SDK, Codex app-server, Bash / Git / MCP on the PC                            |
| Work management      | Project / Task / Subtask / dependency DAG. No separate "Ticket" entity                    |
| CLI requests         | Go through Cloudflare by default, even when a PC is specified                             |
| Bot-to-bot           | Through Cloudflare even on the same PC. Messages / Inbox are persisted                    |
| Exceptions           | Native subagent traffic inside one Run, local Hooks, safe stop                            |
| Execution device     | Chosen from Bot/Project preferred PCs, capabilities, environment, permissions             |
| Fallback             | Automatic for not-yet-started Jobs. Running work with unknown side effects stops and asks |
| Long-term continuity | LogicalSession, history, summaries, Memory, Task state are retained                       |
| Eventing             | Async integration is event-centric, kept separate from Command / Hook / Signal            |
| Event sourcing       | Not adopted wholesale. Current state + event history + transactional outbox               |

### 1.2 What is borrowed from reference projects

- `tk` [S01]: lightweight Task, assignee, dependencies, concurrency control, machine-readable CLI. Its local
  JSON files are not used as the source of truth for shared Tasks.
- `wr` [S02][S03]: Hono / Drizzle / Valibot / Access and linking execution history; `wr/next`'s separation of
  work, execution, permission and observation. `wr/next`'s SQLite Durable Object is **not** adopted as this
  product's source of truth.
- `cxsl` [S04]: Slack thread ↔ provider session mapping, approval buttons, thread continuation after a mention.
  Socket Mode and all filters are not ported as-is; this product uses the HTTP Events API and generic
  Subscriptions.
- Harnesses such as DeepSeek Harness: separation of durable events, transient notifications, pre-execution
  hooks and inbox. No specific harness's agent loop or plugin system becomes a required dependency; Claude's
  and Codex's own agent loops stay inside the adapters.

## 2. Functional requirements

P0 = first usable version, P1 = required extension for target v1, P2 = later. P1 is part of the final scope.

| ID    | Requirement                                                                            | Priority |
| ----- | -------------------------------------------------------------------------------------- | -------- |
| FR-01 | Create Channels and Threads in a Workspace; keep conversation history and attachments  | P0       |
| FR-02 | Channel Owner / Member / Bot roles; view, post and admin permissions                   | P0       |
| FR-03 | Persist a Bot's role, instructions, Skills, Tools, Memory and execution policy         | P0       |
| FR-04 | Bots create/modify Bots / Channels / Tasks / Subscriptions within granted limits       | P1       |
| FR-05 | Projects group Tasks; manage assignee (User/Bot) and a lightweight status              | P0       |
| FR-06 | Subtasks, start dependencies, readiness, cycle rejection, completion criteria          | P0       |
| FR-07 | Auto-link Session / Run / Task / Git worktree / PR / artifacts                         | P0/P1    |
| FR-08 | Run the Claude Agent SDK on the PC, preferring permitted subscription auth             | P0       |
| FR-09 | Connect Codex app-server through the same domain model                                 | P1       |
| FR-10 | Accept input during long work and start separate conversation handling                 | P0       |
| FR-11 | Show execution logs, pending approvals, failures, cancellation, retry                  | P0       |
| FR-12 | Placement by preferred PC, allowed PCs, capabilities, concurrency                      | P0       |
| FR-13 | New placement and safe handover to PC2 when PC1 stops                                  | P1       |
| FR-14 | Sync the same conversations, Tasks, Memory and execution status across PCs             | P0       |
| FR-15 | Android: conversation, search, notifications, approvals, Task/Run status               | P1       |
| FR-16 | CLI: emit Events, send requests to Bots, start and watch Jobs                          | P0       |
| FR-17 | Bots exchange Request / Response / Notification                                        | P0       |
| FR-18 | Explicit delegation of Task execution rights between Bots, with tracked results        | P1       |
| FR-19 | Receive GitHub App events; per-Bot watch conditions                                    | P1       |
| FR-20 | Watch Slack threads / channels / app mentions / user mentions / DMs                    | P1       |
| FR-21 | Bots manage their subscriptions, wake conditions, batching and stop conditions         | P1       |
| FR-22 | Routines triggered by cron / one-off schedule / webhook / internal event               | P1       |
| FR-23 | Store and search Memory at Workspace / Channel / Project / Bot / Task scope            | P0       |
| FR-24 | Keep long sessions alive via summaries, history search and context rebuild             | P0/P1    |
| FR-25 | Use Bash, files, Git and MCP within per-device permissions                             | P0       |
| FR-26 | Collector ingests history of externally started CLIs                                   | P1       |
| FR-27 | Pluggable adapters that turn Connector / MCP notifications into events                 | P2       |
| FR-28 | Selective export/import of Bot Templates; secrets and history excluded by default      | P2       |
| FR-29 | Audit permission changes, subscription changes, executions, approvals, external writes | P0       |
| FR-30 | Surface search/sync/event-processing lag, gaps and unknown states in the UI            | P0       |

### 2.1 Non-functional requirements

- **Observability** — trace one input through Event, Delivery, Inbox, Job, Run, Execution and external
  operation; always able to explain where it is stuck.
- **Fault tolerance** — assume redelivery. A request accepted into D1 is never lost because a WebSocket dropped.
  Failures are never turned into infinite retries or fake completion.
- **Authorization** — app-level authorization on top of Cloudflare Access. Bot inference is never a basis for
  granting permissions or for verified facts.
- **Responsiveness** — intake is decoupled from model execution. With every PC offline, intake and browsing
  still work; model replies depend on an online executor and provider availability.
- **Cost control** — limits on model calls, bot chains, context size, storage and event batching. Never switch
  Claude billing to the API automatically.
- **Initial design scale** — a personal Workspace, a few executor PCs, tens of Bots. Beyond that, measure.
  This is not a platform limit.

### 2.2 Explicit non-goals

- Live migration of OS processes, file systems or browser logins to another PC.
- Exactly-once execution of arbitrary Bash or external APIs.
- Multiple PCs each claiming the same shared Task while disconnected from the cloud.
- Circumventing subscription quotas or terms, free privilege escalation by Bots, unconditional ingestion of all
  Slack conversations.

## 3. External dependencies and verification gates

### 3.1 Claude authentication and quota

Official help (updated 2026-10-07) says subscription quota continues to be usable from the Agent SDK. The SDK
Quickstart says offering claude.ai login/quota to third-party products requires prior approval. [S05][S06]

Therefore the initial target is **personal use by the owner**. Auth, usage and terms are confirmed on the real
account in Phase 0. Distribution, team use and commercialization are a separate release decision. Auth is
isolated inside the adapter; API-key auth is allowed only when explicitly chosen.

### 3.2 Cloudflare / SDK assumptions

- D1 supports FTS5. Multi-statement atomicity on D1 is built from prepared-statement `batch()` plus SQL
  constraints; an ORM's interactive transaction callback is not assumed to work. [S07][S08]
- Claude SessionStore can persist externally, but execution continues when mirroring fails, and some restore
  paths delete the local transcript on exit. A local journal outside the SDK is therefore mandatory. [S09]
- Access Managed OAuth, WebSocket upgrade, Android HTTPS App Links and cross-PC provider resume are on-device
  verification items. Code fragments in these docs are this product's own contract proposals, not claims about
  SDK APIs that do not exist.
