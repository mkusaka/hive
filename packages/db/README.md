# @hive/db

D1 schema, migrations and the atomic repository for the Phase 1 slice
(`CLI → cloud → bot inbox → job claim → fake executor → result`). See
[docs/architecture.md §3 and §11](../../docs/architecture.md#3-storage-6).

- `src/schema.ts`: Drizzle schema, the DB-side source of truth. Each table is tagged as current state, immutable
  history or rebuildable projection.
- `src/repository.ts`: plain functions over a `D1Database`. Critical commands (`claimJob`, `finishRun`,
  `withOperationReceipt`) are prepared-statement batches; a 0-row CAS is made to fail through `atomic_guards`.
  `finishRun` stores the Run's `summary` / `error` and runs the caller's extra `statements` (the Inbox outcome) in
  the same batch.
- Batchable statements for one-batch commands (§11.1): `insertMessage`, `insertEvent`, `insertInboxItem`,
  `createJob` (queued, placement snapshot from the Bot, UNIQUE trigger key) and `enqueueOutbox`.
- `appendChange` returns the `change_log` INSERT for the same batch (§12.2): one row per client-visible entity
  changed, with `scope` `workspace:<id>` or `channel:<id>`. `claimJob` (job, run), `finishRun` (run, job) and
  `createDeliveryAndInbox` (inbox item, job) append their own rows. `revision` is the entity's revision column
  (`jobs.revision`, `bots.config_revision`) and null when there is none or it is unknown when the batch is built
  (`finishRun`'s job). `seq` is AUTOINCREMENT, so it is never reused; gaps are normal.
- `workspaces.auth_epoch` (default 1) is part of every sync cursor. Membership / ACL changes must bump it; no
  command changes membership yet, so nothing bumps it.
- Event route: `createDeliveryAndInbox` (consumer receipt, Delivery, linked inbox item, Job for `wake`) and
  `recordEventRouted` (receipt only). Both are idempotent through the consumer receipt PK.
- Work tables (§4): `projects` (key UNIQUE per Workspace, `task_counter` numbers Task keys `<key>-<n>`), `tasks`
  (status `pending / in_progress / completed / cancelled`, `revision` for edits, `scope_revision` for requirement /
  dependency changes, `completion_policy`), `task_dependencies` (UNIQUE pair, no self edge) and immutable
  `task_results` (one per submitted Run of a Task Job, with the Execution's scope revision). `jobs.task_id` marks an
  explicit Task Job; `claimJob` copies it and the Task's `scope_revision` into the Execution
  (`executions.task_id`, `task_scope_revision`). `createJob` takes an optional `taskId` and explicit `placement`.
- Subscriptions (§17.1): `subscriptions` (current spec as JSON columns, `enabled`, `expires_at`, `revision`) and
  immutable `subscription_revisions` (one copy per revision, no FK so it outlives a delete).
  `integration_installations` holds GitHub / Slack hook ids and the app's own provider account
  (`external_account_id`). `events.logical_key` with the partial UNIQUE `events_logical_dedupe` collapses one
  external fact seen through several events (Slack `app_mention` + `message`).
- Routing to several recipients: `routeToRecipients` writes the consumer receipt and, per recipient, the Delivery
  (`matched_subscription_ids`), the inbox item and a Job for `wake`, all in one batch; `createDeliveryAndInbox` is
  its single-recipient form. A `batch` recipient joins its (bot, lane)'s open `inbox_batches` row (partial UNIQUE
  `inbox_batches_open`, opened on demand) through `inbox_items.batch_id`. `sealDueBatches` seals batches past
  `seal_at` or at `max_items` with one Job each (`trigger_key = batch:<id>`, `jobs.inbox_batch_id`), under a
  guarded `state = 'open'` CAS. `insertConsumerReceipt` is exported so intake can mark an event that must never
  route (AT-27).
- `src/dag.ts`: pure Task DAG rules. `wouldCreateCycle(edges, parentLinks, edge)` checks one "finishes before"
  graph of start dependencies plus the hidden child → parent completion relation (AT-18); `readiness` is `ready`
  only when every prerequisite is `completed` (a cancelled one blocks, AT-17); `displayState` adds it to the status.
- Recovery (§10.4): `expireLeases` moves active Runs whose lease expired to `unknown` (reservations kept,
  `result_error` `lease_expired` or `lease_expired_before_start` when `runs.started_at` is null) and their Jobs to
  `recovery_required`; `confirmRunStopped` turns a fenced `unknown` Run and its Execution `interrupted` and releases
  its reservations; `setJobsWaitingDevice` moves the Jobs the caller names (apps/api-worker placement) between
  `queued` and `waiting_device`, with change rows in the same batch. `claimJob` accepts `waiting_device` Jobs and
  fails with `at_capacity` (an `atomic_guards` row inside the batch) when the device's active root Runs would exceed
  `devices.capacity_background`; `devices.capabilities` (JSON array) holds what the heartbeat reported.
  Migration 0014 is hand-written (`drizzle-kit generate --custom`) because it renames the unused `capacity` column.
  `finishRun` accepts `cancelled` (Execution `interrupted`). `jobs.cancel_requested_at` records `job.cancel`.
- Routines (§17.2): `routines` (cron / once / webhook / event schedule JSON, `schedule_revision`, `misfire`
  `skip / coalesce`, timed `next_fire_at`, `enabled`, `revision`, hashed-only `webhook_secret_hash`) and immutable
  `routine_occurrences` (UNIQUE (routine_id, schedule_revision, occurrence_key), `scheduled_at`, optional JSON
  `payload`, state `created` with its `job_id` or `skipped`). Migration 0024 preserves timestamp keys for timed
  occurrences; event keys use `event:<eventId>`, manual keys the command's operation id, and webhook keys fresh ids.
  `routine_webhook_deliveries` dedupes (routine_id, delivery_id) for seven days; `routine_webhook_rate_limits`
  atomically caps each routine's fixed UTC-minute window at 60 accepted requests.
- `guard` is exported for command batches outside this package (`apps/api-worker` Task commands).
- Memory and search (§13.6, §14): `memories` (scope `workspace / channel / project / bot / task` + `scope_id`,
  content ≤ 16 KiB by CHECK on its UTF-8 bytes, source, creating actor, `revision`, `supersedes_id`, tombstone
  `deleted_at`) and immutable `memory_revisions` (one copy per revision, no FK). `search_documents` is the
  rebuildable projection (`rowid` INTEGER PRIMARY KEY, UNIQUE (source_kind, source_id, chunk_key), `source_revision`,
  ACL `scope` `workspace: / channel: / bot: / task:<id>`, tombstone `deleted_at`, `indexed_at`); Project memories
  use `workspace:<id>`. `search_fts` is an external-content FTS5 table over its `title` / `body` with
  `tokenize='trigram'`, kept in sync by AFTER INSERT / UPDATE / DELETE triggers, so a document and its FTS rows
  change in one statement. The indexer and queries live in `apps/api-worker/src/search.ts`.
- Transcripts (§3.3, §13.2; UPLOAD-01): `transcript_streams` (one per Run, UNIQUE `run_id`, `provider`,
  `confirmed_through_seq` = highest part seq with all parts from 0 committed, null for none) and immutable
  `transcript_parts` (the manifest: UNIQUE (stream_id, part_seq), `part_seq >= 0`, `byte_size`, `sha256`,
  `entry_count`, `r2_key`), written by `apps/api-worker/src/transcripts.ts` only after the R2 object is stored.
  `runs.persistence` (`pending` default, `complete`) and `runs.finished_at` (set by `finishRun` and
  `confirmRunStopped`) were added by `ALTER TABLE`, so `persistence` has no SQL CHECK.
- External effects (§19; EFFECT-01): `effects` (Run + generation, Bot, integration, kind `slack.post /
github.comment`, normalized `request` JSON, `request_digest`, `operation_marker`, state `prepared / approved /
executing / succeeded / failed / unknown`, `approval_id`, `external_id` / `external_url`, `attempts`,
  `last_error`; UNIQUE (run_id, request_digest)). `settleEffectApproval` gives the approval batches (resolve, expiry
  sweep) the effect's `approved` + `effect.perform` outbox row or `failed`. `enqueueOutbox` takes an optional
  `availableAt` (reconcile is scheduled 30 s out). The broker lives in `apps/api-worker/src/effects.ts`.
- `migrations/`: SQL generated by drizzle-kit. Never edit by hand, except `0012_search_fts`: drizzle has no FTS5
  support, so it was created empty by `drizzle-kit generate --custom` (which also records it in `_journal.json` and
  copies the snapshot) and holds the hand-written virtual table and triggers. `db:check` stays green because the
  snapshot does not know about them.

## Tests

```sh
bun run test       # from the repo root; D1 tests run in miniflare via @cloudflare/vitest-pool-workers
bun run db:check   # migrations are consistent and `db:generate` has nothing left to generate
```

## Adding a migration

1. Change `src/schema.ts`.
2. `bun run db:generate` (from the repo root) and commit the new file under `migrations/`.
3. `bun run db:check` must pass; CI runs it. On drift it reports the proposed schema change without writing a
   migration into the repository.

`db:check` validates the complete snapshot chain, then checks schema drift against the journal's final snapshot
in a temporary directory. drizzle-kit otherwise picks the lexically last filename: after this merge, migration
order is `0022_threads` → `0024_routine_triggers` → `0030_run_outcome` → `0031_external_runs` (the collector migration was renumbered at merge time so that filename order, which wrangler and the test pool apply, matches the chain).
The collector snapshot includes the routine-trigger schema and `runs.outcome`, and its `prevId` is the 0030 id.

## Foreign keys added to existing tables

SQLite `ALTER TABLE` cannot attach a foreign key to an existing column, and drizzle-kit answers with a table
rebuild (`__new_<table>`, copy, drop, rename). `0005_execution_task_fk` is the first such rebuild: `executions`
gets the composite `(workspace_id, task_id)` FK. It is safe only because no table references `executions` with
rows: D1 enforces foreign keys and documents `PRAGMA defer_foreign_keys` for migrations, so the rebuild's
`PRAGMA foreign_keys=OFF` is not relied on, and dropping a referenced parent could fail. Verified in miniflare
only; real D1 is gate G-05. For the
same reason `jobs.task_id` is a new column added by `ALTER TABLE ... REFERENCES tasks(id)`, a single-column FK
without the workspace pair: rebuilding `jobs` would drop a table that `runs` references. The command layer only
links a Task of the same Workspace.

drizzle-kit 0.31 also copies a column added in the same run into the rebuild's `INSERT ... SELECT`, which fails
because the old table lacks it. Add new columns in one `db:generate` run and the FK in a later one (as
`0004_work` and `0005_execution_task_fk` do), and never rename or drop a column in the same run (that prompts for
a TTY).

## Known gaps

- FTS5 (gate G-06) is verified on miniflare only (`test/search.test.ts`, 2026-10-11): the trigram tokenizer with
  Japanese substrings and the external-content triggers. Real D1, including export of a database with a virtual table
  (§14.2 [S15]), is pending.

- `0005_execution_task_fk` wraps its table rebuild in `PRAGMA foreign_keys=OFF`, which real D1 may not honor (D1
  documents `PRAGMA defer_foreign_keys` instead). It is verified on miniflare only and must be re-checked on real D1
  (G-05); `PRAGMA defer_foreign_keys = true` is the likely replacement.
- No projectless Tasks: `tasks.project_id` is nullable, but `task.create` requires a Project (directly or through the
  parent) because there is no key scheme for Tasks without one.

- `inbox_items.batch_id` is a single-column FK added by `ALTER TABLE` (like `jobs.task_id`).
- `inbox_items.delivery_mode` (now also `batch`) has no SQL CHECK: adding one to an existing table makes drizzle-kit recreate the
  table. The command schema validates it.

- `finishRun` updates the Job only while it is `active`; a `cancelled` or `recovery_required` Job is left as is while
  the Run goes terminal and its reservations are released. Since lease expiry moves the Run to `unknown`, which
  `finishRun` does not accept, this only happens for a Job resolved while its Run was still active.
- `renewLease` checks the fence and a non-terminal Run state, but does not reject an already expired lease.
