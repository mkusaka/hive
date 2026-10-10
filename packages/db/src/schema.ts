// Drizzle schema: the DB-side source of truth (docs/architecture.md §3.1, §25).
// Phase 1 subset only. Each table is tagged as one of:
//   current state | immutable history | rebuildable projection
// Workspace-scoped foreign keys reference (workspace_id, id) so rows from another
// Workspace cannot be linked.
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const createdAt = () => text("created_at").notNull().default(now);
const updatedAt = () => text("updated_at").notNull().default(now);
const workspaceId = () =>
  text("workspace_id")
    .notNull()
    .references((): AnySQLiteColumn => workspaces.id);
// SQL CHECK mirroring a TS enum; raw SQL in the repository bypasses Drizzle's types.
const oneOf = (name: string, column: AnySQLiteColumn, values: readonly string[]) =>
  check(name, sql`${column} IN ${sql.raw(`(${values.map((v) => `'${v}'`).join(", ")})`)}`);
// Parent side of composite foreign keys.
const scoped = (t: { workspaceId: AnySQLiteColumn; id: AnySQLiteColumn }) =>
  unique().on(t.workspaceId, t.id);

// ---------------------------------------------------------------- Identity

/** current state */
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** current state. Global identity (not workspace-scoped); membership links it to Workspaces. */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    accessIssuer: text("access_issuer").notNull(),
    accessSubject: text("access_subject").notNull(),
    email: text("email"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique().on(t.accessIssuer, t.accessSubject)],
);

/** current state */
export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    workspaceId: workspaceId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role", { enum: ["owner", "member"] }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

const actorKinds = ["user", "bot", "service"] as const;

/** current state */
export const actors = sqliteTable(
  "actors",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    kind: text("kind", { enum: actorKinds }).notNull(),
    userId: text("user_id").references(() => users.id),
    displayName: text("display_name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    scoped(t),
    oneOf("actors_kind", t.kind, actorKinds),
    // One actor per user per Workspace; created with the membership (workspace.create today).
    uniqueIndex("actors_workspace_user")
      .on(t.workspaceId, t.userId)
      .where(sql`${t.userId} IS NOT NULL`),
  ],
);

// ----------------------------------------------------------------- Devices

/** current state */
export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    os: text("os").notNull(),
    agentVersion: text("agent_version").notNull(),
    capacity: integer("capacity").notNull().default(1),
    lastHeartbeatAt: text("last_heartbeat_at"),
    revokedAt: text("revoked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [scoped(t)],
);

/** current state. Only a hash of the device secret is stored. */
export const deviceCredentials = sqliteTable(
  "device_credentials",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    deviceId: text("device_id").notNull(),
    secretHash: text("secret_hash").notNull().unique(),
    revokedAt: text("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.deviceId],
      foreignColumns: [devices.workspaceId, devices.id],
    }),
  ],
);

// ---------------------------------------------------- Channel / Conversation

/** current state */
export const channels = sqliteTable(
  "channels",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [scoped(t), unique().on(t.workspaceId, t.name)],
);

const channelRoles = ["owner", "member"] as const;

/** current state. Users and Bots join a Channel through their actor row. */
export const channelMembers = sqliteTable(
  "channel_members",
  {
    workspaceId: workspaceId(),
    channelId: text("channel_id").notNull(),
    actorId: text("actor_id").notNull(),
    role: text("role", { enum: channelRoles }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.channelId, t.actorId] }),
    oneOf("channel_members_role", t.role, channelRoles),
    foreignKey({
      columns: [t.workspaceId, t.channelId],
      foreignColumns: [channels.workspaceId, channels.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [actors.workspaceId, actors.id],
    }),
  ],
);

/** current state. Phase 1: one main conversation per channel. */
export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    channelId: text("channel_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    scoped(t),
    foreignKey({
      columns: [t.workspaceId, t.channelId],
      foreignColumns: [channels.workspaceId, channels.id],
    }),
  ],
);

/** immutable history */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    conversationId: text("conversation_id").notNull(),
    seq: integer("seq").notNull(),
    actorId: text("actor_id").notNull(),
    clientMessageId: text("client_message_id").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    scoped(t),
    unique().on(t.conversationId, t.seq),
    unique().on(t.actorId, t.clientMessageId),
    foreignKey({
      columns: [t.workspaceId, t.conversationId],
      foreignColumns: [conversations.workspaceId, conversations.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [actors.workspaceId, actors.id],
    }),
  ],
);

// --------------------------------------------------------------------- Bot

/** current state */
export const bots = sqliteTable(
  "bots",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    actorId: text("actor_id").notNull(),
    name: text("name").notNull(),
    placementPolicy: text("placement_policy", { mode: "json" }).notNull(),
    configRevision: integer("config_revision").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    scoped(t),
    unique().on(t.workspaceId, t.name),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [actors.workspaceId, actors.id],
    }),
  ],
);

// ------------------------------------------------------------------ Inputs

/** immutable history. Envelope columns of @hive/contracts `eventEnvelope`. */
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    type: text("type").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    sourceKind: text("source_kind", {
      enum: ["github", "slack", "cli", "routine", "bot", "system"],
    }).notNull(),
    integrationId: text("integration_id"),
    externalEventId: text("external_event_id"),
    sourceDeviceId: text("source_device_id"),
    actorKind: text("actor_kind", { enum: ["user", "bot", "integration", "system"] }).notNull(),
    actorId: text("actor_id").notNull(),
    subjectKind: text("subject_kind"),
    subjectId: text("subject_id"),
    data: text("data", { mode: "json" }).notNull(),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id"),
    occurredAt: text("occurred_at").notNull(),
    receivedAt: text("received_at").notNull(),
    expiresAt: text("expires_at"),
  },
  (t) => [
    scoped(t),
    uniqueIndex("events_source_dedupe")
      .on(t.workspaceId, t.sourceKind, t.integrationId, t.externalEventId)
      .where(sql`${t.integrationId} IS NOT NULL AND ${t.externalEventId} IS NOT NULL`),
  ],
);

/** immutable history. Consumer receipt (docs/architecture.md §6.2). */
export const eventReceipts = sqliteTable(
  "event_receipts",
  {
    workspaceId: workspaceId(),
    eventId: text("event_id").notNull(),
    consumer: text("consumer").notNull(),
    handlerVersion: text("handler_version").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.consumer, t.handlerVersion] }),
    foreignKey({
      columns: [t.workspaceId, t.eventId],
      foreignColumns: [events.workspaceId, events.id],
    }),
  ],
);

// ---------------------------------------------------------------- Delivery

/** immutable history */
export const eventDeliveries = sqliteTable(
  "event_deliveries",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    eventId: text("event_id").notNull(),
    botId: text("bot_id").notNull(),
    lane: text("lane").notNull(),
    purpose: text("purpose").notNull(),
    matchedSubscriptionIds: text("matched_subscription_ids", { mode: "json" })
      .notNull()
      .default("[]"),
    createdAt: createdAt(),
  },
  (t) => [
    scoped(t),
    unique().on(t.workspaceId, t.eventId, t.botId, t.lane, t.purpose),
    foreignKey({
      columns: [t.workspaceId, t.eventId],
      foreignColumns: [events.workspaceId, events.id],
    }),
    foreignKey({ columns: [t.workspaceId, t.botId], foreignColumns: [bots.workspaceId, bots.id] }),
  ],
);

const inboxStates = ["pending", "claimed", "processed", "failed"] as const;

/** current state. `input_id` is the logical input (message or event id). */
export const inboxItems = sqliteTable(
  "inbox_items",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    inputId: text("input_id").notNull(),
    botId: text("bot_id").notNull(),
    conversationId: text("conversation_id"),
    lane: text("lane").notNull(),
    purpose: text("purpose").notNull(),
    deliveryId: text("delivery_id"),
    // docs/architecture.md §7.2. No SQL CHECK: adding one to an existing table makes drizzle-kit
    // recreate it; the command schema validates the value.
    deliveryMode: text("delivery_mode", { enum: ["wake", "notify"] })
      .notNull()
      .default("wake"),
    state: text("state", { enum: inboxStates }).notNull().default("pending"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    scoped(t),
    unique("inbox_items_dedupe").on(t.workspaceId, t.inputId, t.botId, t.lane, t.purpose),
    oneOf("inbox_items_state", t.state, inboxStates),
    foreignKey({ columns: [t.workspaceId, t.botId], foreignColumns: [bots.workspaceId, bots.id] }),
    foreignKey({
      columns: [t.workspaceId, t.conversationId],
      foreignColumns: [conversations.workspaceId, conversations.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.deliveryId],
      foreignColumns: [eventDeliveries.workspaceId, eventDeliveries.id],
    }),
  ],
);

// --------------------------------------------------------------- Execution

const jobStates = [
  "queued",
  "waiting_device",
  "waiting_input",
  "active",
  "recovery_required",
  "succeeded",
  "failed",
  "cancelled",
] as const;

/** current state */
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    botId: text("bot_id").notNull(),
    state: text("state", { enum: jobStates }).notNull().default("queued"),
    revision: integer("revision").notNull().default(1),
    triggerKey: text("trigger_key").notNull(),
    placement: text("placement", { mode: "json" }).notNull(),
    inboxBatchId: text("inbox_batch_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    scoped(t),
    unique().on(t.workspaceId, t.triggerKey),
    oneOf("jobs_state", t.state, jobStates),
    foreignKey({ columns: [t.workspaceId, t.botId], foreignColumns: [bots.workspaceId, bots.id] }),
  ],
);

const runKinds = ["root", "native_child"] as const;
const runStates = [
  "starting",
  "running",
  "waiting_approval",
  "stopping",
  "unknown",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
] as const;

/** current state. A Job has many root Runs but at most one non-terminal root Run. */
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    jobId: text("job_id").notNull(),
    kind: text("kind", { enum: runKinds }).notNull(),
    parentRunId: text("parent_run_id"),
    deviceId: text("device_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    state: text("state", { enum: runStates }).notNull().default("starting"),
    leaseExpiresAt: text("lease_expires_at"),
    continuedFromRunId: text("continued_from_run_id"),
    // Submitted by the executor with the terminal state (run.result.submit).
    resultSummary: text("result_summary"),
    resultError: text("result_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    scoped(t),
    unique().on(t.jobId, t.executionGeneration),
    // `unknown` is not terminal: the root attempt stays occupied until observation settles it.
    uniqueIndex("runs_one_active_root")
      .on(t.jobId)
      .where(
        sql`${t.kind} = 'root' AND ${t.state} NOT IN ('succeeded', 'failed', 'interrupted', 'cancelled')`,
      ),
    oneOf("runs_kind", t.kind, runKinds),
    oneOf("runs_state", t.state, runStates),
    foreignKey({ columns: [t.workspaceId, t.jobId], foreignColumns: [jobs.workspaceId, jobs.id] }),
    foreignKey({
      columns: [t.workspaceId, t.deviceId],
      foreignColumns: [devices.workspaceId, devices.id],
    }),
    foreignKey({ columns: [t.workspaceId, t.parentRunId], foreignColumns: [t.workspaceId, t.id] }),
    foreignKey({
      columns: [t.workspaceId, t.continuedFromRunId],
      foreignColumns: [t.workspaceId, t.id],
    }),
  ],
);

const executionStates = ["active", "submitted", "finished", "failed", "interrupted"] as const;

/** current state. Minimal for Phase 1; tasks arrive with WORK-01. */
export const executions = sqliteTable(
  "executions",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    runId: text("run_id").notNull(),
    taskId: text("task_id"),
    state: text("state", { enum: executionStates }).notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    scoped(t),
    index("executions_run").on(t.runId),
    oneOf("executions_state", t.state, executionStates),
    foreignKey({ columns: [t.workspaceId, t.runId], foreignColumns: [runs.workspaceId, runs.id] }),
  ],
);

// ------------------------------------------------------------ Coordination

/** current state. One active owner per (workspace_id, resource_key); released rows stay as history. */
export const resourceReservations = sqliteTable(
  "resource_reservations",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    resourceKey: text("resource_key").notNull(),
    runId: text("run_id").notNull(),
    createdAt: createdAt(),
    releasedAt: text("released_at"),
  },
  (t) => [
    uniqueIndex("resource_reservations_active")
      .on(t.workspaceId, t.resourceKey)
      .where(sql`${t.releasedAt} IS NULL`),
    index("resource_reservations_run").on(t.runId),
    foreignKey({ columns: [t.workspaceId, t.runId], foreignColumns: [runs.workspaceId, runs.id] }),
  ],
);

// ---------------------------------------------------------- Infrastructure

/** immutable history. `actor_id` is the authenticated principal (actor or device id). */
export const operationReceipts = sqliteTable(
  "operation_receipts",
  {
    workspaceId: workspaceId(),
    actorId: text("actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    status: integer("status").notNull(),
    response: text("response", { mode: "json" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.actorId, t.idempotencyKey] })],
);

const outboxStates = ["pending", "sending", "sent", "dead"] as const;

/** current state. `sent` means handed to the Queue, not processed (docs/architecture.md §6.3). */
export const outbox = sqliteTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    topic: text("topic").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    state: text("state", { enum: outboxStates }).notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    availableAt: text("available_at").notNull().default(now),
    leaseOwner: text("lease_owner"),
    leaseUntil: text("lease_until"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("outbox_ready").on(t.state, t.availableAt),
    oneOf("outbox_state", t.state, outboxStates),
  ],
);

/** Transient: makes a 0-row CAS fail inside a batch (docs/architecture.md §11.3). Always empty after a batch. */
export const atomicGuards = sqliteTable(
  "atomic_guards",
  {
    operationId: text("operation_id").primaryKey(),
    ok: integer("ok").notNull(),
  },
  (t) => [check("atomic_guards_ok", sql`${t.ok} = 1`)],
);

/** immutable history */
export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  workspaceId: workspaceId(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  targetKind: text("target_kind").notNull(),
  targetId: text("target_id").notNull(),
  data: text("data", { mode: "json" }),
  createdAt: createdAt(),
});
