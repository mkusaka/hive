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
  // Part of every sync cursor (docs/architecture.md §12.3): bumped when membership / ACL changes, which
  // expires old cursors. Nothing bumps it yet (no member add/remove command).
  authEpoch: integer("auth_epoch").notNull().default(1),
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
    // Reported by the executor's heartbeat (§10.1): what it can run and how many background root Runs at once.
    capabilities: text("capabilities", { mode: "json" }).$type<string[]>().notNull().default([]),
    capacityBackground: integer("capacity_background").notNull().default(1),
    lastHeartbeatAt: text("last_heartbeat_at"),
    revokedAt: text("revoked_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [scoped(t)],
);

/**
 * current state (docs/architecture.md §10.1). A device's environment: `name` is the logical environment id a Bot's
 * placement names (`placementPolicy.environmentId`), so the same environment on several devices makes each eligible.
 * The checkout root is a local path and stays on the device (the executor's `environments.json`).
 */
export const deviceEnvironments = sqliteTable(
  "device_environments",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    deviceId: text("device_id").notNull(),
    name: text("name").notNull(),
    /** Repository identity, e.g. the git remote URL. */
    repository: text("repository").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique().on(t.deviceId, t.name),
    foreignKey({
      columns: [t.workspaceId, t.deviceId],
      foreignColumns: [devices.workspaceId, devices.id],
    }),
  ],
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

/**
 * current state. A Channel's one main conversation, or (`kind = 'bot_pair'`) the private conversation of two Bots
 * (docs/architecture.md §8.1). A bot pair is backed by a Channel row without members, so it is in no user's channel
 * list; both rows use the id `botpair:<botId>:<botId>` (sorted) and are created by the first message. Not a nullable
 * `channel_id`: rebuilding this table fails on D1 once messages reference it (FKs cannot be switched off).
 */
export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    channelId: text("channel_id").notNull(),
    // `channel` | `bot_pair`. No CHECK: added by ALTER TABLE.
    kind: text("kind").notNull().default("channel"),
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
    // Bot-to-bot messaging (docs/architecture.md §8). `kind` is request / response / notification (null for plain
    // channel posts); `hop` counts bot-to-bot steps; `job_id` is the sending Run's Job. No CHECK / FK: added by
    // ALTER TABLE (see jobs.task_id).
    kind: text("kind"),
    hop: integer("hop").notNull().default(0),
    replyToMessageId: text("reply_to_message_id"),
    jobId: text("job_id"),
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
    /** System prompt for the Bot's runs (SDK-01). */
    instructions: text("instructions").notNull().default(""),
    /** @hive/contracts `ToolPolicy` (TOOLS-01). The default denies every native tool. */
    toolPolicy: text("tool_policy", { mode: "json" })
      .notNull()
      .default({ tools: {}, cwdMode: "run_scratch" }),
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

// -------------------------------------------------------------------- Work

const projectStatuses = ["active", "paused", "archived"] as const;

/** current state. `task_counter` numbers the Project's Task keys (`<key>-<n>`). */
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: projectStatuses }).notNull().default("active"),
    // Default notification target only; grants nothing (docs/architecture.md §2.1).
    primaryChannelId: text("primary_channel_id"),
    taskCounter: integer("task_counter").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    scoped(t),
    unique().on(t.workspaceId, t.key),
    oneOf("projects_status", t.status, projectStatuses),
    foreignKey({
      columns: [t.workspaceId, t.primaryChannelId],
      foreignColumns: [channels.workspaceId, channels.id],
    }),
  ],
);

export const taskStatuses = ["pending", "in_progress", "completed", "cancelled"] as const;
export const completionPolicies = ["declaration", "human", "checks", "children"] as const;
const assigneeKinds = ["user", "bot"] as const;

/**
 * current state (docs/architecture.md §3.2, §4). `blocked` / `ready` are computed (dag.ts), never stored.
 * `revision` bumps on every edit; `scope_revision` on requirement / dependency changes.
 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    projectId: text("project_id"),
    parentTaskId: text("parent_task_id"),
    key: text("key").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: text("status", { enum: taskStatuses }).notNull().default("pending"),
    assigneeKind: text("assignee_kind", { enum: assigneeKinds }),
    assigneeId: text("assignee_id"),
    priority: integer("priority").notNull().default(0),
    revision: integer("revision").notNull().default(1),
    scopeRevision: integer("scope_revision").notNull().default(1),
    completionPolicy: text("completion_policy", { enum: completionPolicies })
      .notNull()
      .default("declaration"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    scoped(t),
    unique().on(t.workspaceId, t.key),
    oneOf("tasks_status", t.status, taskStatuses),
    oneOf("tasks_assignee_kind", t.assigneeKind, assigneeKinds),
    check("tasks_assignee", sql`(${t.assigneeKind} IS NULL) = (${t.assigneeId} IS NULL)`),
    oneOf("tasks_completion_policy", t.completionPolicy, completionPolicies),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [projects.workspaceId, projects.id],
    }),
    foreignKey({ columns: [t.workspaceId, t.parentTaskId], foreignColumns: [t.workspaceId, t.id] }),
  ],
);

/** current state. Start dependency: `dependent` starts after `prerequisite` completes (§2.2). */
export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    workspaceId: workspaceId(),
    prerequisiteTaskId: text("prerequisite_task_id").notNull(),
    dependentTaskId: text("dependent_task_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.prerequisiteTaskId, t.dependentTaskId] }),
    index("task_dependencies_dependent").on(t.dependentTaskId),
    check("task_dependencies_not_self", sql`${t.prerequisiteTaskId} <> ${t.dependentTaskId}`),
    foreignKey({
      columns: [t.workspaceId, t.prerequisiteTaskId],
      foreignColumns: [tasks.workspaceId, tasks.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.dependentTaskId],
      foreignColumns: [tasks.workspaceId, tasks.id],
    }),
  ],
);

const resultStates = ["succeeded", "failed"] as const;

/** immutable history. One per submitted Run of a Task Job, for the Execution's scope revision. */
export const taskResults = sqliteTable(
  "task_results",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    taskId: text("task_id").notNull(),
    executionId: text("execution_id").notNull(),
    runId: text("run_id").notNull(),
    scopeRevision: integer("scope_revision").notNull(),
    state: text("state", { enum: resultStates }).notNull(),
    summary: text("summary").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("task_results_task").on(t.taskId),
    oneOf("task_results_state", t.state, resultStates),
    foreignKey({
      columns: [t.workspaceId, t.taskId],
      foreignColumns: [tasks.workspaceId, tasks.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.executionId],
      foreignColumns: [executions.workspaceId, executions.id],
    }),
    foreignKey({ columns: [t.workspaceId, t.runId], foreignColumns: [runs.workspaceId, runs.id] }),
  ],
);

// ----------------------------------------------------------------- Inputs

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
    // Second identity of one external fact seen through several events, e.g. a Slack post delivered as both
    // `app_mention` and `message`: `slack:<team>:<channel>:<ts>` (docs/architecture.md §6.2).
    logicalKey: text("logical_key"),
  },
  (t) => [
    scoped(t),
    uniqueIndex("events_source_dedupe")
      .on(t.workspaceId, t.sourceKind, t.integrationId, t.externalEventId)
      .where(sql`${t.integrationId} IS NOT NULL AND ${t.externalEventId} IS NOT NULL`),
    uniqueIndex("events_logical_dedupe")
      .on(t.workspaceId, t.logicalKey)
      .where(sql`${t.logicalKey} IS NOT NULL`),
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
    deliveryMode: text("delivery_mode", { enum: ["wake", "notify", "batch"] })
      .notNull()
      .default("wake"),
    // `batch` items: the Inbox batch they joined. Single-column FK: added by ALTER TABLE (see jobs.task_id).
    batchId: text("batch_id").references((): AnySQLiteColumn => inboxBatches.id),
    // The input message's bot-to-bot hop (docs/architecture.md §8.2); a Run's capability inherits its trigger item's.
    hop: integer("hop").notNull().default(0),
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

const batchStates = ["open", "sealed"] as const;

/**
 * current state (docs/architecture.md §7.2). One `open` batch per (bot, lane); membership is fixed at seal, when
 * the pump creates its one Job (`trigger_key = batch:<id>`). `max_items` comes from the Subscription that opened it.
 */
export const inboxBatches = sqliteTable(
  "inbox_batches",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    botId: text("bot_id").notNull(),
    lane: text("lane").notNull(),
    state: text("state", { enum: batchStates }).notNull().default("open"),
    sealAt: text("seal_at").notNull(),
    maxItems: integer("max_items").notNull(),
    itemCount: integer("item_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    scoped(t),
    uniqueIndex("inbox_batches_open")
      .on(t.workspaceId, t.botId, t.lane)
      .where(sql`${t.state} = 'open'`),
    index("inbox_batches_seal").on(t.state, t.sealAt),
    oneOf("inbox_batches_state", t.state, batchStates),
    foreignKey({ columns: [t.workspaceId, t.botId], foreignColumns: [bots.workspaceId, bots.id] }),
  ],
);

// -------------------------------------------------------------- Integrations

const integrationKinds = ["github", "slack"] as const;

/**
 * current state. The id is the hook URL's `:integrationId`. `external_account_id` is the app's own account on the
 * provider (the Slack bot user id), used to drop echoes of its own posts (AT-27).
 */
export const integrationInstallations = sqliteTable(
  "integration_installations",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    kind: text("kind", { enum: integrationKinds }).notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    externalAccountId: text("external_account_id"),
    createdAt: createdAt(),
  },
  (t) => [scoped(t), oneOf("integration_installations_kind", t.kind, integrationKinds)],
);

// Subscription spec columns, shared by the current row and its immutable revisions (docs/architecture.md §17.1).
const subscriptionSpec = () => ({
  workspaceId: workspaceId(),
  botId: text("bot_id").notNull(),
  integrationId: text("integration_id"),
  eventTypes: text("event_types", { mode: "json" }).notNull(),
  filter: text("filter", { mode: "json" }).notNull(),
  destination: text("destination", { mode: "json" }).notNull(),
  delivery: text("delivery", { mode: "json" }).notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  expiresAt: text("expires_at"),
  revision: integer("revision").notNull(),
});

/** current state. Every change bumps `revision` and copies the row to `subscription_revisions`. */
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    ...subscriptionSpec(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    scoped(t),
    index("subscriptions_workspace_enabled").on(t.workspaceId, t.enabled),
    foreignKey({ columns: [t.workspaceId, t.botId], foreignColumns: [bots.workspaceId, bots.id] }),
    foreignKey({
      columns: [t.workspaceId, t.integrationId],
      foreignColumns: [integrationInstallations.workspaceId, integrationInstallations.id],
    }),
  ],
);

/** immutable history. No FK to `subscriptions`: revisions outlive a deleted Subscription. */
export const subscriptionRevisions = sqliteTable(
  "subscription_revisions",
  {
    subscriptionId: text("subscription_id").notNull(),
    ...subscriptionSpec(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.subscriptionId, t.revision] })],
);

// ---------------------------------------------------------------- Routines

const misfirePolicies = ["skip", "coalesce"] as const;

/**
 * current state (docs/architecture.md §17.2). `schedule` is `{kind: "cron", expr, timezone}` or `{kind: "once", at}`;
 * `schedule_revision` bumps when it changes and is part of the occurrence identity. `next_fire_at` is the next UTC
 * occurrence, null when none is left (a fired `once`). `revision` bumps on every edit.
 */
export const routines = sqliteTable(
  "routines",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    botId: text("bot_id").notNull(),
    name: text("name").notNull(),
    conversationId: text("conversation_id"),
    taskId: text("task_id"),
    inputText: text("input_text").notNull(),
    schedule: text("schedule", { mode: "json" }).notNull(),
    scheduleRevision: integer("schedule_revision").notNull().default(1),
    misfire: text("misfire", { enum: misfirePolicies }).notNull().default("coalesce"),
    nextFireAt: text("next_fire_at"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    revision: integer("revision").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    scoped(t),
    index("routines_due").on(t.enabled, t.nextFireAt),
    oneOf("routines_misfire", t.misfire, misfirePolicies),
    foreignKey({ columns: [t.workspaceId, t.botId], foreignColumns: [bots.workspaceId, bots.id] }),
    foreignKey({
      columns: [t.workspaceId, t.conversationId],
      foreignColumns: [conversations.workspaceId, conversations.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.taskId],
      foreignColumns: [tasks.workspaceId, tasks.id],
    }),
  ],
);

const occurrenceStates = ["created", "skipped"] as const;

/** immutable history. One row per UTC occurrence (AT-31); `created` ones carry their Job. */
export const routineOccurrences = sqliteTable(
  "routine_occurrences",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    routineId: text("routine_id").notNull(),
    scheduleRevision: integer("schedule_revision").notNull(),
    scheduledAt: text("scheduled_at").notNull(),
    state: text("state", { enum: occurrenceStates }).notNull(),
    jobId: text("job_id"),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.routineId, t.scheduleRevision, t.scheduledAt),
    oneOf("routine_occurrences_state", t.state, occurrenceStates),
    check("routine_occurrences_job", sql`(${t.state} = 'created') = (${t.jobId} IS NOT NULL)`),
    foreignKey({
      columns: [t.workspaceId, t.routineId],
      foreignColumns: [routines.workspaceId, routines.id],
    }),
    foreignKey({ columns: [t.workspaceId, t.jobId], foreignColumns: [jobs.workspaceId, jobs.id] }),
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
    // Explicit Task Jobs (job.start). Added by ALTER TABLE, which can only add a single-column FK: a composite
    // (workspace_id, task_id) FK would rebuild `jobs`, and dropping it fails on the `runs` rows that reference it.
    taskId: text("task_id").references((): AnySQLiteColumn => tasks.id),
    // job.cancel (§9.3): a request, not a stop. An active Job stays active until its Run stops.
    cancelRequestedAt: text("cancel_requested_at"),
    // Bot-to-bot chain (§8.2): Jobs caused by one originating request share it; capped at 20 per correlation.
    correlationId: text("correlation_id"),
    // `waiting_input`: the request message whose reply re-queues the Job.
    waitingForMessageId: text("waiting_for_message_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    scoped(t),
    unique().on(t.workspaceId, t.triggerKey),
    index("jobs_correlation").on(t.workspaceId, t.correlationId),
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
    // From the executor's `runtime.run.started` observation (§9.2 step 7); e.g. the Claude session id.
    providerSessionId: text("provider_session_id"),
    // Set by the same observation; null means the launch was never confirmed (§10.4 "unknown after launch intent").
    startedAt: text("started_at"),
    // Set with the terminal state (finishRun, confirmRunStopped).
    finishedAt: text("finished_at"),
    // Transcript persistence (§9.1 "Run=succeeded, persistence=pending"): `complete` once every part up to the
    // executor's final part is confirmed in `transcript_parts`. No CHECK: adding one to an existing SQLite table
    // makes drizzle-kit recreate `runs`.
    persistence: text("persistence", { enum: ["pending", "complete"] })
      .notNull()
      .default("pending"),
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

/**
 * current state. A Run working on a Task: `task_id` and the Task's `scope_revision` are copied from the Job at
 * claim time, so a Result is for the requirements the Run started on.
 */
export const executions = sqliteTable(
  "executions",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    runId: text("run_id").notNull(),
    taskId: text("task_id"),
    taskScopeRevision: integer("task_scope_revision"),
    state: text("state", { enum: executionStates }).notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    scoped(t),
    index("executions_run").on(t.runId),
    oneOf("executions_state", t.state, executionStates),
    foreignKey({ columns: [t.workspaceId, t.runId], foreignColumns: [runs.workspaceId, runs.id] }),
    foreignKey({
      columns: [t.workspaceId, t.taskId],
      foreignColumns: [tasks.workspaceId, tasks.id],
    }),
  ],
);

/**
 * current state (docs/architecture.md §18.2). A Run's capability: what its Bot may do through `/v1/run/*`, valid while
 * the Run is active at this generation and until `expires_at` (lease expiry + 5 min, extended on renew). Only
 * SHA-256 of the secret is stored. Revoked when the Run submits its result.
 */
export const runCapabilities = sqliteTable(
  "run_capabilities",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    runId: text("run_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: text("scopes", { mode: "json" }).notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("run_capabilities_run").on(t.runId),
    foreignKey({ columns: [t.workspaceId, t.runId], foreignColumns: [runs.workspaceId, runs.id] }),
  ],
);

/**
 * current state (docs/architecture.md §3.3, §13.2). One raw provider transcript per Run, stored as immutable R2 parts
 * `workspace/<workspace_id>/transcript/<id>/<part_seq>`. `confirmed_through_seq` is the highest part_seq with every
 * part from 0 committed (null: none). Raw only: the normalized view is derived at read time and never indexed.
 */
export const transcriptStreams = sqliteTable(
  "transcript_streams",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    runId: text("run_id").notNull().unique(),
    provider: text("provider").notNull(),
    confirmedThroughSeq: integer("confirmed_through_seq"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    scoped(t),
    foreignKey({ columns: [t.workspaceId, t.runId], foreignColumns: [runs.workspaceId, runs.id] }),
  ],
);

/**
 * immutable history: the manifest. A row is committed only after its object is stored and verified in R2 (store
 * first, then manifest). `entry_count` is the number of JSONL lines in the part.
 */
export const transcriptParts = sqliteTable(
  "transcript_parts",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    streamId: text("stream_id").notNull(),
    partSeq: integer("part_seq").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    entryCount: integer("entry_count").notNull(),
    r2Key: text("r2_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique().on(t.streamId, t.partSeq),
    check("transcript_parts_seq", sql`${t.partSeq} >= 0`),
    foreignKey({
      columns: [t.workspaceId, t.streamId],
      foreignColumns: [transcriptStreams.workspaceId, transcriptStreams.id],
    }),
  ],
);

const approvalStates = ["pending", "approved", "denied", "expired"] as const;

/**
 * current state (docs/architecture.md §19). A Run's request to use an `ask` tool, bound to its generation and the
 * SHA-256 of the canonical tool input (`args_hash`); the input itself never leaves the device, only a redacted
 * `args_summary`. Resolved once from `pending`; `expired` (timeout or a Run that is no longer current) means deny.
 */
export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    runId: text("run_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    jobId: text("job_id").notNull(),
    botId: text("bot_id").notNull(),
    actionKind: text("action_kind").notNull(),
    argsHash: text("args_hash").notNull(),
    argsSummary: text("args_summary").notNull(),
    cwdLabel: text("cwd_label").notNull(),
    state: text("state", { enum: approvalStates }).notNull().default("pending"),
    requestedAt: text("requested_at").notNull().default(now),
    expiresAt: text("expires_at").notNull(),
    resolvedAt: text("resolved_at"),
    resolvedBy: text("resolved_by").references(() => users.id),
    decisionReason: text("decision_reason"),
  },
  (t) => [
    index("approvals_state_expires").on(t.state, t.expiresAt),
    index("approvals_run").on(t.runId),
    oneOf("approvals_state", t.state, approvalStates),
    foreignKey({ columns: [t.workspaceId, t.runId], foreignColumns: [runs.workspaceId, runs.id] }),
    foreignKey({ columns: [t.workspaceId, t.jobId], foreignColumns: [jobs.workspaceId, jobs.id] }),
    foreignKey({ columns: [t.workspaceId, t.botId], foreignColumns: [bots.workspaceId, bots.id] }),
  ],
);

export const effectKinds = ["slack.post", "github.comment"] as const;
const effectStates = [
  "prepared",
  "approved",
  "executing",
  "succeeded",
  "failed",
  "unknown",
] as const;

/**
 * current state (docs/architecture.md §19): a Run's intent to write to an external system, performed by the cloud
 * with the integration's credentials (claim → perform → reconcile). `request` is the normalized request without the
 * operation marker; `request_digest` is its SHA-256, so the same request twice from one Run is one effect.
 * `operation_marker` is embedded in the outbound object to find it again when the response was lost (`unknown`).
 * `attempts` counts performs; an `unknown` effect is never re-sent unless reconcile proves the object absent.
 */
export const effects = sqliteTable(
  "effects",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    runId: text("run_id").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    botId: text("bot_id").notNull(),
    integrationId: text("integration_id").notNull(),
    kind: text("kind", { enum: effectKinds }).notNull(),
    request: text("request", { mode: "json" }).notNull(),
    requestDigest: text("request_digest").notNull(),
    operationMarker: text("operation_marker").notNull(),
    state: text("state", { enum: effectStates }).notNull(),
    approvalId: text("approval_id").references((): AnySQLiteColumn => approvals.id),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    scoped(t),
    unique().on(t.runId, t.requestDigest),
    index("effects_workspace_state").on(t.workspaceId, t.state),
    index("effects_approval").on(t.approvalId),
    oneOf("effects_kind", t.kind, effectKinds),
    oneOf("effects_state", t.state, effectStates),
    foreignKey({ columns: [t.workspaceId, t.runId], foreignColumns: [runs.workspaceId, runs.id] }),
    foreignKey({ columns: [t.workspaceId, t.botId], foreignColumns: [bots.workspaceId, bots.id] }),
    foreignKey({
      columns: [t.workspaceId, t.integrationId],
      foreignColumns: [integrationInstallations.workspaceId, integrationInstallations.id],
    }),
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

// ------------------------------------------------------- Memory and search

export const memoryScopeKinds = ["workspace", "channel", "project", "bot", "task"] as const;
const memorySourceKinds = ["user", "bot", "system"] as const;

// Memory columns shared by the current row and its immutable revisions (docs/architecture.md §13.6).
const memorySpec = () => ({
  workspaceId: workspaceId(),
  scopeKind: text("scope_kind", { enum: memoryScopeKinds }).notNull(),
  scopeId: text("scope_id").notNull(),
  content: text("content").notNull(),
  sourceKind: text("source_kind", { enum: memorySourceKinds }).notNull(),
  sourceId: text("source_id").notNull(),
  createdByActorId: text("created_by_actor_id").notNull(),
  revision: integer("revision").notNull(),
  supersedesId: text("supersedes_id"),
  deletedAt: text("deleted_at"),
});

/**
 * current state. Explicit `memory.write` knowledge in one scope (`scope_id` is the Workspace, Channel, Project, Bot or
 * Task id). Content never changes: a correction is a new memory that supersedes (tombstones) the old one. Deletes are
 * tombstones (`deleted_at`, `revision` bump), copied to `memory_revisions` like every revision.
 */
export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    ...memorySpec(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    scoped(t),
    index("memories_scope").on(t.workspaceId, t.scopeKind, t.scopeId),
    oneOf("memories_scope_kind", t.scopeKind, memoryScopeKinds),
    oneOf("memories_source_kind", t.sourceKind, memorySourceKinds),
    check("memories_content_size", sql`length(CAST(${t.content} AS BLOB)) <= 16384`),
    foreignKey({
      columns: [t.workspaceId, t.createdByActorId],
      foreignColumns: [actors.workspaceId, actors.id],
    }),
  ],
);

/** immutable history. One copy per memory revision; no FK so it outlives the current row. */
export const memoryRevisions = sqliteTable(
  "memory_revisions",
  {
    memoryId: text("memory_id").notNull(),
    ...memorySpec(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.memoryId, t.revision] })],
);

const searchSourceKinds = ["message", "task", "memory"] as const;

/**
 * rebuildable projection (docs/architecture.md §14). One row per indexed source chunk; the FTS5 table `search_fts`
 * (hand-written migration `0012_search_fts`: external content, trigram tokenizer, sync triggers) indexes `title` and
 * `body` by `rowid`. `scope` is the ACL scope: `workspace:<id>`, `channel:<id>`, `bot:<id>` or `task:<id>`.
 * `source_revision` never goes backwards; a tombstone (`deleted_at`) has an empty title and body.
 */
export const searchDocuments = sqliteTable(
  "search_documents",
  {
    rowid: integer("rowid").primaryKey(),
    workspaceId: workspaceId(),
    sourceKind: text("source_kind", { enum: searchSourceKinds }).notNull(),
    sourceId: text("source_id").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    chunkKey: text("chunk_key").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    scope: text("scope").notNull(),
    deletedAt: text("deleted_at"),
    indexedAt: text("indexed_at").notNull(),
  },
  (t) => [
    unique().on(t.sourceKind, t.sourceId, t.chunkKey),
    index("search_documents_workspace").on(t.workspaceId, t.indexedAt),
    oneOf("search_documents_source_kind", t.sourceKind, searchSourceKinds),
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

const changeOps = ["upsert", "delete"] as const;

/**
 * immutable history. Appended in the batch of the change it describes (docs/architecture.md §12.2). `scope` is
 * the access scope: `workspace:<id>` or `channel:<id>`. `revision` is the entity's revision column, null when it
 * has none or it is not known when the batch is built.
 */
export const changeLog = sqliteTable(
  "change_log",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    workspaceId: workspaceId(),
    entityKind: text("entity_kind").notNull(),
    entityId: text("entity_id").notNull(),
    op: text("op", { enum: changeOps }).notNull(),
    revision: integer("revision"),
    scope: text("scope").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("change_log_workspace_seq").on(t.workspaceId, t.seq),
    oneOf("change_log_op", t.op, changeOps),
  ],
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
