// POST /v1/commands handlers (docs/architecture.md §22.3). Each runs inside `withOperationReceipt`.
import {
  AgentReply,
  type AgentReplyAccepted,
  AgentSend,
  type AgentSendAccepted,
  ApprovalRequest,
  ApprovalResolve,
  BotCreate,
  BotUpdate,
  ChannelCreate,
  ChannelJoin,
  ChannelLeave,
  ChannelUpdate,
  commandEnvelope,
  DeviceEnvironmentRegister,
  DeviceRegister,
  DeviceRevoke,
  DmOpen,
  EffectPrepare,
  EffectResolve,
  EventEmit,
  type EventEmitAccepted,
  firstFireAt,
  IntegrationCreate,
  JobCancel,
  JobResolve,
  JobStart,
  MemoryDelete,
  MemoryWrite,
  mentionedBotIds,
  MessagePost,
  type MessagePostAccepted,
  type PlacementPolicy,
  ProjectCreate,
  RoutineCreate,
  RoutineDelete,
  RoutinePause,
  RoutineResume,
  RoutineRotateSecret,
  RoutineRun,
  type RoutineSchedule,
  type ToolPolicy,
  RoutineUpdate,
  RunAgentSend,
  type RunAgentSendAccepted,
  RunCommand,
  SidebarUpdate,
  SubscriptionCreate,
  SubscriptionDelete,
  SubscriptionPause,
  SubscriptionTest,
  SubscriptionUpdate,
  TaskAssign,
  TaskCancel,
  TaskComplete,
  TaskCreate,
  TaskDelegate,
  TaskDelegateRevoke,
  TaskPlan,
  userEventType,
  WorkspaceCreate,
} from "@hive/contracts";
import {
  appendChange,
  createJob,
  digest,
  enqueueOutbox,
  guard,
  IdempotencyConflict,
  insertEvent,
  insertInboxItem,
  insertMessage,
  readiness,
  resumeRunAfterApproval,
  settleEffectApproval,
  withOperationReceipt,
  wouldCreateCycle,
} from "@hive/db";
import * as v from "valibot";
import { hashSecret, newDeviceSecret } from "./auth/device.ts";
import type { Principal } from "./auth/principal.ts";
import { queuePerform, summarize } from "./effects.ts";
import { HttpError } from "./errors.ts";
import { eventColumns, type EventRow, type SubscriptionRow, subscriptionMatches } from "./pump.ts";
import { occurrenceStatements, routineColumns, routineFrom, type RoutineRow } from "./routines.ts";
import { indexLater } from "./search.ts";

export const CommandEnvelope = commandEnvelope(
  v.variant("type", [
    WorkspaceCreate,
    DeviceRegister,
    DeviceRevoke,
    DeviceEnvironmentRegister,
    ChannelCreate,
    ChannelUpdate,
    ChannelJoin,
    ChannelLeave,
    DmOpen,
    BotCreate,
    BotUpdate,
    AgentSend,
    MessagePost,
    EventEmit,
    ProjectCreate,
    TaskCreate,
    TaskAssign,
    TaskPlan,
    TaskComplete,
    TaskCancel,
    TaskDelegate,
    TaskDelegateRevoke,
    JobStart,
    JobCancel,
    JobResolve,
    SubscriptionCreate,
    SubscriptionUpdate,
    SubscriptionPause,
    SubscriptionDelete,
    SubscriptionTest,
    IntegrationCreate,
    RoutineCreate,
    RoutineUpdate,
    RoutinePause,
    RoutineResume,
    RoutineRun,
    RoutineRotateSecret,
    RoutineDelete,
    ApprovalResolve,
    MemoryWrite,
    MemoryDelete,
    EffectResolve,
    SidebarUpdate,
  ]),
);
type Envelope = v.InferOutput<typeof CommandEnvelope>;
type Command = Envelope["command"];
type User = Extract<Principal, { kind: "user" }>;
type Handler<T extends Command> = (
  db: D1Database,
  user: User,
  envelope: Envelope & { command: T },
) => Promise<{ status: number; response: unknown; scopes?: string[] }>;

/** Task writes are shared with Run commands: the receipt is keyed by the user or the Run. */
type TaskHandler<T extends Command> = (
  db: D1Database,
  actorId: string,
  envelope: Envelope & { command: T },
) => ReturnType<Handler<T>>;

type Change = Omit<Parameters<typeof appendChange>[1], "workspaceId">;

/**
 * Runs the batch with one change row per `changes` entry; returns the touched scopes unless replayed. `actorId` keys
 * the receipt: the user, or the Run for a Run command.
 */
const receipt = async <T>(
  db: D1Database,
  actorId: string,
  envelope: Envelope,
  statements: D1PreparedStatement[],
  response: T,
  changes: Change[],
) => {
  const { workspaceId } = envelope;
  const result = await withOperationReceipt(
    db,
    {
      workspaceId,
      actorId,
      idempotencyKey: envelope.idempotencyKey,
      requestDigest: await digest(envelope.command),
    },
    () => ({
      statements: [...statements, ...changes.map((c) => appendChange(db, { workspaceId, ...c }))],
      status: 200,
      response,
    }),
  );
  return { ...result, scopes: result.replayed ? [] : [...new Set(changes.map((c) => c.scope))] };
};

const workspaceCreate: Handler<v.InferOutput<typeof WorkspaceCreate>> = async (db, user, env) => {
  const { workspaceId } = env;
  const member = user.workspaceIds.includes(workspaceId);
  // Dev bootstrap only: a user with no Workspace creates the first one. A member may only replay.
  if (!member && user.workspaceIds.length > 0) {
    throw new HttpError(
      "FORBIDDEN",
      "workspace.create is only allowed before the first membership",
    );
  }
  const exists = await db
    .prepare("SELECT 1 FROM workspaces WHERE id = ?")
    .bind(workspaceId)
    .first();
  if (exists && !member) throw new HttpError("FORBIDDEN", "workspace already exists");
  // A member with a new idempotency key: the INSERT hits the primary key; replays return the receipt before that.
  const run = receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare("INSERT INTO workspaces (id, name) VALUES (?, ?)")
        .bind(workspaceId, env.command.name),
      db
        .prepare(
          "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')",
        )
        .bind(workspaceId, user.userId),
      // The member's actor row (messages, channel membership) is created with the membership.
      db
        .prepare(
          `INSERT INTO actors (id, workspace_id, kind, user_id, display_name)
           SELECT ?, ?, 'user', id, COALESCE(email, id) FROM users WHERE id = ?`,
        )
        .bind(crypto.randomUUID(), workspaceId, user.userId),
    ],
    { operationId: env.operationId, status: "accepted", workspaceId },
    [{ entityKind: "workspace", entityId: workspaceId, scope: `workspace:${workspaceId}` }],
  );
  return explainFailure(run, async () =>
    (await db.prepare("SELECT 1 FROM workspaces WHERE id = ?").bind(workspaceId).first())
      ? new HttpError("INVALID_INPUT", `workspace already exists: ${workspaceId}`)
      : null,
  );
};

const deviceRegister: Handler<v.InferOutput<typeof DeviceRegister>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const deviceId = crypto.randomUUID();
  const secret = newDeviceSecret();
  const result = await receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          `INSERT INTO devices (id, workspace_id, owner_user_id, name, os, agent_version)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(deviceId, workspaceId, user.userId, command.name, command.os, command.agentVersion),
      db
        .prepare(
          "INSERT INTO device_credentials (id, workspace_id, device_id, secret_hash) VALUES (?, ?, ?, ?)",
        )
        .bind(crypto.randomUUID(), workspaceId, deviceId, await hashSecret(secret)),
    ],
    // The receipt keeps a redacted response: a replay never returns the plaintext token again.
    {
      operationId: env.operationId,
      status: "accepted",
      deviceId,
      deviceToken: null as string | null,
    },
    [{ entityKind: "device", entityId: deviceId, scope: `workspace:${workspaceId}` }],
  );
  if (result.replayed) return result;
  return { ...result, response: { ...result.response, deviceToken: `${deviceId}.${secret}` } };
};

const deviceRevoke: Handler<v.InferOutput<typeof DeviceRevoke>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const owned = await db
    .prepare("SELECT 1 FROM devices WHERE workspace_id = ? AND id = ? AND owner_user_id = ?")
    .bind(workspaceId, command.deviceId, user.userId)
    .first();
  if (!owned) throw new HttpError("NOT_FOUND", "device not found");
  const now = new Date().toISOString();
  return receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          `UPDATE devices SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .bind(now, now, workspaceId, command.deviceId),
      db
        .prepare(
          `UPDATE device_credentials SET revoked_at = ?
            WHERE workspace_id = ? AND device_id = ? AND revoked_at IS NULL`,
        )
        .bind(now, workspaceId, command.deviceId),
    ],
    { operationId: env.operationId, status: "accepted", deviceId: command.deviceId },
    [{ entityKind: "device", entityId: command.deviceId, scope: `workspace:${workspaceId}` }],
  );
};

const userActorId = async (db: D1Database, workspaceId: string, userId: string) => {
  const row = await db
    .prepare("SELECT id FROM actors WHERE workspace_id = ? AND user_id = ?")
    .bind(workspaceId, userId)
    .first<{ id: string }>();
  if (!row) throw new HttpError("FORBIDDEN", "no actor for this user in the workspace");
  return row.id;
};

/**
 * On a failed batch (not an idempotency conflict), throws `explain()`'s error when it names the cause, else the
 * original error. The batch already rolled back, so `explain` re-reads state instead of parsing SQL errors.
 * A replay never reaches the batch.
 */
const explainFailure = <T>(run: Promise<T>, explain: () => Promise<HttpError | null>) =>
  run.catch(async (error: unknown) => {
    if (error instanceof IdempotencyConflict) throw error;
    throw (await explain()) ?? error;
  });

/** Maps a batch failure caused by UNIQUE (workspace_id, <column>) to 422. */
const uniqueName = <T>(
  db: D1Database,
  table: "channels" | "bots" | "projects",
  workspaceId: string,
  name: string,
  run: Promise<T>,
  column: "name" | "key" = "name",
) =>
  explainFailure(run, async () => {
    const taken = await db
      .prepare(`SELECT 1 FROM ${table} WHERE workspace_id = ? AND ${column} = ?`)
      .bind(workspaceId, name)
      .first();
    return taken ? new HttpError("INVALID_INPUT", `${column} already exists: ${name}`) : null;
  });

const channelCreate: Handler<v.InferOutput<typeof ChannelCreate>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const actorId = await userActorId(db, workspaceId, user.userId);
  const channelId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const run = receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare("INSERT INTO channels (id, workspace_id, name) VALUES (?, ?, ?)")
        .bind(channelId, workspaceId, command.name),
      db
        .prepare("INSERT INTO conversations (id, workspace_id, channel_id) VALUES (?, ?, ?)")
        .bind(conversationId, workspaceId, channelId),
      db
        .prepare(
          "INSERT INTO channel_members (workspace_id, channel_id, actor_id, role) VALUES (?, ?, ?, 'owner')",
        )
        .bind(workspaceId, channelId, actorId),
    ],
    { operationId: env.operationId, status: "accepted", channelId, conversationId },
    [
      { entityKind: "channel", entityId: channelId, scope: `channel:${channelId}` },
      { entityKind: "conversation", entityId: conversationId, scope: `channel:${channelId}` },
    ],
  );
  return uniqueName(db, "channels", workspaceId, command.name, run);
};

/** Sets or clears (empty string) the topic. Only a member of the Channel may; a missing Channel is a 404. */
const channelUpdate: Handler<v.InferOutput<typeof ChannelUpdate>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const row = await db
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM channel_members m JOIN actors a
                ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
             WHERE m.workspace_id = ch.workspace_id AND m.channel_id = ch.id AND a.user_id = ?) AS member
         FROM channels ch WHERE ch.workspace_id = ? AND ch.id = ?`,
    )
    .bind(user.userId, workspaceId, command.channelId)
    .first<{ member: number }>();
  if (!row) throw new HttpError("NOT_FOUND", "channel not found");
  if (!row.member) throw new HttpError("FORBIDDEN", "not a member of this channel");
  const topic = command.topic.trim() || null;
  return receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare("UPDATE channels SET topic = ?, updated_at = ? WHERE workspace_id = ? AND id = ?")
        .bind(topic, new Date().toISOString(), workspaceId, command.channelId),
    ],
    { operationId: env.operationId, status: "accepted", channelId: command.channelId, topic },
    [
      {
        entityKind: "channel",
        entityId: command.channelId,
        scope: `channel:${command.channelId}`,
      },
    ],
  );
};

/** The Bot's actor; 404 when the Workspace has no such Bot. */
const botActorId = async (db: D1Database, workspaceId: string, botId: string) => {
  const bot = await db
    .prepare("SELECT actor_id FROM bots WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, botId)
    .first<{ actor_id: string }>();
  if (!bot) throw new HttpError("NOT_FOUND", "bot not found");
  return bot.actor_id;
};

/** channel.join / channel.leave: a member adds or removes a Bot. Joining twice or leaving as a non-member is a no-op. */
const channelMembership =
  (join: boolean): Handler<v.InferOutput<typeof ChannelJoin | typeof ChannelLeave>> =>
  async (db, user, env) => {
    const { workspaceId, command } = env;
    await channelMember(db, workspaceId, command.channelId, user.userId);
    const actorId = await botActorId(db, workspaceId, command.botId);
    return receipt(
      db,
      user.userId,
      env,
      [
        join
          ? db
              .prepare(
                `INSERT INTO channel_members (workspace_id, channel_id, actor_id, role) VALUES (?, ?, ?, 'member')
                 ON CONFLICT DO NOTHING`,
              )
              .bind(workspaceId, command.channelId, actorId)
          : db
              .prepare(
                "DELETE FROM channel_members WHERE workspace_id = ? AND channel_id = ? AND actor_id = ?",
              )
              .bind(workspaceId, command.channelId, actorId),
      ],
      {
        operationId: env.operationId,
        status: "accepted",
        channelId: command.channelId,
        botId: command.botId,
      },
      [
        {
          entityKind: "channel",
          entityId: command.channelId,
          scope: `channel:${command.channelId}`,
        },
      ],
    );
  };

/** A DM and its member-less backing Channel share this id (schema.ts); deterministic, so concurrent opens agree. */
const dmId = (userId: string, botId: string) => `dm-${userId}-${botId}`;

/** Idempotent: the caller's DM with the Bot, created on first open. */
const dmOpen: Handler<v.InferOutput<typeof DmOpen>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  await botActorId(db, workspaceId, command.botId);
  const conversationId = dmId(user.userId, command.botId);
  return receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          "INSERT INTO channels (id, workspace_id, name) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .bind(conversationId, workspaceId, conversationId),
      db
        .prepare(
          `INSERT INTO conversations (id, workspace_id, channel_id, kind, dm_user_id, dm_bot_id)
           VALUES (?, ?, ?, 'dm', ?, ?) ON CONFLICT DO NOTHING`,
        )
        .bind(conversationId, workspaceId, conversationId, user.userId, command.botId),
    ],
    { operationId: env.operationId, status: "accepted", conversationId },
    [{ entityKind: "dm", entityId: conversationId, scope: `workspace:${workspaceId}` }],
  );
};

const botCreate: Handler<v.InferOutput<typeof BotCreate>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const actorId = crypto.randomUUID();
  const botId = crypto.randomUUID();
  const run = receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          "INSERT INTO actors (id, workspace_id, kind, display_name) VALUES (?, ?, 'bot', ?)",
        )
        .bind(actorId, workspaceId, command.name),
      db
        .prepare(
          `INSERT INTO bots (id, workspace_id, actor_id, name, placement_policy, instructions, tool_policy)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          botId,
          workspaceId,
          actorId,
          command.name,
          JSON.stringify(command.placementPolicy),
          command.instructions,
          JSON.stringify(command.toolPolicy),
        ),
    ],
    { operationId: env.operationId, status: "accepted", botId },
    [{ entityKind: "bot", entityId: botId, revision: 1, scope: `workspace:${workspaceId}` }],
  );
  return uniqueName(db, "bots", workspaceId, command.name, run);
};

/**
 * Revision CAS on `config_revision`. A Run reads the policy once at start, so an update never widens a running one; a
 * placement change applies to Jobs created afterwards (queued Jobs keep their snapshot, §10.2).
 */
const botUpdate: Handler<v.InferOutput<typeof BotUpdate>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const revision = async () => {
    const row = await db
      .prepare("SELECT config_revision AS revision FROM bots WHERE workspace_id = ? AND id = ?")
      .bind(workspaceId, command.botId)
      .first<{ revision: number }>();
    if (!row) throw new HttpError("NOT_FOUND", "bot not found");
    return row.revision;
  };
  await revision();
  const [setGuard, clearGuard] = guard(db);
  const next = command.expectedRevision + 1;
  const run = receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          `UPDATE bots SET instructions = COALESCE(?, instructions), tool_policy = COALESCE(?, tool_policy),
             placement_policy = COALESCE(?, placement_policy), config_revision = config_revision + 1, updated_at = ?
            WHERE workspace_id = ? AND id = ? AND config_revision = ?`,
        )
        .bind(
          command.instructions ?? null,
          command.toolPolicy ? JSON.stringify(command.toolPolicy) : null,
          command.placementPolicy ? JSON.stringify(command.placementPolicy) : null,
          new Date().toISOString(),
          workspaceId,
          command.botId,
          command.expectedRevision,
        ),
      setGuard,
      clearGuard,
    ],
    { operationId: env.operationId, status: "accepted", botId: command.botId, revision: next },
    [
      {
        entityKind: "bot",
        entityId: command.botId,
        revision: next,
        scope: `workspace:${workspaceId}`,
      },
    ],
  );
  return explainFailure(run, async () => {
    const current = await revision();
    return current === command.expectedRevision
      ? null
      : new HttpError(
          "REVISION_CONFLICT",
          `bot revision is ${current}; refetch and retry`,
          false,
          "stale_revision",
        );
  });
};

/** On the caller's own, unrevoked device. Re-registering a name replaces its repository identity. */
const deviceEnvironmentRegister: Handler<v.InferOutput<typeof DeviceEnvironmentRegister>> = async (
  db,
  user,
  env,
) => {
  const { workspaceId, command } = env;
  const owned = await db
    .prepare(
      `SELECT e.id FROM devices d
         LEFT JOIN device_environments e ON e.device_id = d.id AND e.name = ?
        WHERE d.workspace_id = ? AND d.id = ? AND d.owner_user_id = ? AND d.revoked_at IS NULL`,
    )
    .bind(command.name, workspaceId, command.deviceId, user.userId)
    .first<{ id: string | null }>();
  if (!owned) throw new HttpError("NOT_FOUND", "device not found");
  const environmentId = owned.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  return receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          `INSERT INTO device_environments (id, workspace_id, device_id, name, repository) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (device_id, name) DO UPDATE SET repository = excluded.repository, updated_at = ?`,
        )
        .bind(environmentId, workspaceId, command.deviceId, command.name, command.repository, now),
    ],
    {
      operationId: env.operationId,
      status: "accepted",
      environmentId,
      deviceId: command.deviceId,
      name: command.name,
    },
    [
      {
        entityKind: "device_environment",
        entityId: environmentId,
        scope: `workspace:${workspaceId}`,
      },
    ],
  );
};

/** The caller's actor in the Channel and its Conversation; 403 when not a member. */
const channelMember = async (
  db: D1Database,
  workspaceId: string,
  channelId: string,
  userId: string,
) => {
  const member = await db
    .prepare(
      `SELECT c.id AS conversation_id, a.id AS actor_id
         FROM conversations c
         JOIN channel_members m ON m.workspace_id = c.workspace_id AND m.channel_id = c.channel_id
         JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
        WHERE c.workspace_id = ? AND c.channel_id = ? AND c.kind = 'channel' AND a.user_id = ?`,
    )
    .bind(workspaceId, channelId, userId)
    .first<{ conversation_id: string; actor_id: string }>();
  if (!member) throw new HttpError("FORBIDDEN", "not a member of this channel");
  return member;
};

/** Event, Inbox item and outbox row delivering a user's channel message to one Bot; routing creates the Job later. */
const deliveryStatements = (
  db: D1Database,
  env: Envelope,
  input: {
    userId: string;
    messageId: string;
    botId: string;
    channelId: string;
    conversationId: string;
    kind: "request" | "notification";
    delivery: "wake" | "notify";
    inboxItemId: string;
    receivedAt: string;
  },
) => {
  const { workspaceId } = env;
  const eventId = crypto.randomUUID();
  return [
    insertEvent(db, {
      id: eventId,
      workspaceId,
      type: "agent.message.sent",
      schemaVersion: 1,
      sourceKind: "cli",
      actorKind: "user",
      actorId: input.userId,
      subjectKind: "message",
      subjectId: input.messageId,
      // Read by the event router (pump.ts); the message text stays in `messages`.
      data: {
        messageId: input.messageId,
        kind: input.kind,
        recipientBotId: input.botId,
        channelId: input.channelId,
        conversationId: input.conversationId,
        inboxItemId: input.inboxItemId,
        delivery: input.delivery,
      },
      correlationId: env.operationId,
      occurredAt: input.receivedAt,
      receivedAt: input.receivedAt,
    }),
    insertInboxItem(db, {
      id: input.inboxItemId,
      workspaceId,
      inputId: eventId,
      botId: input.botId,
      conversationId: input.conversationId,
      lane: input.channelId,
      purpose: "agent.send",
      deliveryMode: input.delivery,
    }),
    enqueueOutbox(db, { workspaceId, topic: "event.route", payload: { eventId } }),
  ];
};

/** §11.1: Message, Inbox item, Event, Change Log, Outbox and Receipt in one batch. Routing creates the Job later. */
const agentSend: Handler<v.InferOutput<typeof AgentSend>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const member = await channelMember(db, workspaceId, command.channelId, user.userId);
  const bot = await db
    .prepare("SELECT 1 FROM bots WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, command.recipientBotId)
    .first();
  if (!bot) throw new HttpError("NOT_FOUND", "bot not found");

  const receivedAt = new Date().toISOString();
  const messageId = crypto.randomUUID();
  const inboxItemId = crypto.randomUUID();
  const response: AgentSendAccepted = {
    operationId: env.operationId,
    status: "accepted",
    messageId,
    inboxItemId,
    jobId: null,
    routingStatus: "pending",
    receivedAt,
  };
  return receipt(
    db,
    user.userId,
    env,
    [
      insertMessage(db, {
        id: messageId,
        workspaceId,
        conversationId: member.conversation_id,
        actorId: member.actor_id,
        clientMessageId: env.idempotencyKey,
        body: command.message.text,
      }),
      ...deliveryStatements(db, env, {
        userId: user.userId,
        messageId,
        botId: command.recipientBotId,
        channelId: command.channelId,
        conversationId: member.conversation_id,
        kind: command.message.kind,
        delivery: command.delivery,
        inboxItemId,
        receivedAt,
      }),
      indexLater(db, workspaceId, "message", messageId),
    ],
    response,
    [
      { entityKind: "message", entityId: messageId, scope: `channel:${command.channelId}` },
      { entityKind: "inbox_item", entityId: inboxItemId, scope: `channel:${command.channelId}` },
    ],
  );
};

/** The caller's DM (participant-only, 404 otherwise): its backing Channel, Bot and the caller's actor. */
const dmParticipant = async (
  db: D1Database,
  workspaceId: string,
  conversationId: string,
  userId: string,
) => {
  const dm = await db
    .prepare(
      `SELECT c.id AS conversation_id, c.channel_id, c.dm_bot_id, a.id AS actor_id FROM conversations c
         JOIN actors a ON a.workspace_id = c.workspace_id AND a.user_id = c.dm_user_id
        WHERE c.workspace_id = ? AND c.id = ? AND c.kind = 'dm' AND c.dm_user_id = ?`,
    )
    .bind(workspaceId, conversationId, userId)
    .first<{ conversation_id: string; channel_id: string; dm_bot_id: string; actor_id: string }>();
  if (!dm) throw new HttpError("NOT_FOUND", "conversation not found");
  return dm;
};

/** A thread and its conversation share this id; deterministic, so concurrent first replies agree. */
const threadId = (rootMessageId: string) => `thread-${rootMessageId}`;

/**
 * One message. In a Channel, each Bot mentioned by a `<@bot:ID>` token gets the delivery of a waking `agent.send`
 * request and joins the Channel when it is not a member. In a DM the DM's Bot is the one recipient; a mention of
 * another Bot is 422. A token naming no Bot of the Workspace, or `mentions` differing from the tokens, is 422.
 * With `threadOf` the message goes to the root message's thread (created here on the first reply, same batch); in a
 * Channel thread the Bots that took part in it (posted there, the root included, or were delivered a message there)
 * are woken as well.
 */
const messagePost: Handler<v.InferOutput<typeof MessagePost>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const parent = command.conversationId
    ? await dmParticipant(db, workspaceId, command.conversationId, user.userId)
    : {
        ...(await channelMember(db, workspaceId, command.channelId!, user.userId)),
        channel_id: command.channelId!,
        dm_bot_id: null,
      };
  const botIds = mentionedBotIds(command.text);
  if (
    command.mentions &&
    (new Set(command.mentions).size !== botIds.length ||
      !command.mentions.every((id) => botIds.includes(id)))
  ) {
    throw new HttpError("INVALID_INPUT", "mentions must equal the <@bot:ID> tokens in text");
  }
  // The root must be a message of the addressed conversation itself (a reply lives in its thread, so no nesting).
  const root = command.threadOf
    ? await db
        .prepare(
          "SELECT id FROM messages WHERE workspace_id = ? AND id = ? AND conversation_id = ?",
        )
        .bind(workspaceId, command.threadOf, parent.conversation_id)
        .first<{ id: string }>()
    : null;
  if (command.threadOf && !root) throw new HttpError("NOT_FOUND", "thread root message not found");
  const conversationId = root ? threadId(root.id) : parent.conversation_id;
  let joining: string[] = [];
  let recipients = botIds;
  if (parent.dm_bot_id) {
    if (botIds.some((id) => id !== parent.dm_bot_id)) {
      throw new HttpError("INVALID_INPUT", "a DM can only mention its own bot");
    }
    recipients = [parent.dm_bot_id];
  } else {
    if (botIds.length > 0) {
      const { results } = await db
        .prepare(
          `SELECT b.id, b.actor_id, EXISTS (SELECT 1 FROM channel_members m WHERE m.workspace_id = b.workspace_id
                    AND m.channel_id = ? AND m.actor_id = b.actor_id) AS member
             FROM bots b WHERE b.workspace_id = ? AND b.id IN (${botIds.map(() => "?").join(", ")})`,
        )
        .bind(parent.channel_id, workspaceId, ...botIds)
        .all<{ id: string; actor_id: string; member: number }>();
      const unknown = botIds.filter((id) => !results.some((r) => r.id === id));
      if (unknown.length > 0) {
        throw new HttpError("INVALID_INPUT", `unknown bot in mention: ${unknown.join(", ")}`);
      }
      joining = results.filter((r) => !r.member).map((r) => r.actor_id);
    }
    if (root) {
      const { results } = await db
        .prepare(
          `SELECT b.id FROM bots b
            WHERE b.workspace_id = ?1
              AND (b.actor_id IN (SELECT actor_id FROM messages
                                   WHERE workspace_id = ?1 AND (conversation_id = ?2 OR id = ?3))
                   OR b.id IN (SELECT bot_id FROM inbox_items WHERE workspace_id = ?1 AND conversation_id = ?2))
            ORDER BY b.name`,
        )
        .bind(workspaceId, conversationId, root.id)
        .all<{ id: string }>();
      recipients = [...new Set([...botIds, ...results.map((r) => r.id)])];
    }
  }

  const receivedAt = new Date().toISOString();
  const messageId = crypto.randomUUID();
  const deliveries = recipients.map((botId) => ({ botId, inboxItemId: crypto.randomUUID() }));
  const response: MessagePostAccepted = {
    operationId: env.operationId,
    status: "accepted",
    messageId,
    conversationId,
    inboxItemIds: deliveries.map((d) => d.inboxItemId),
    receivedAt,
  };
  const scope = `channel:${parent.channel_id}`;
  return receipt(
    db,
    user.userId,
    env,
    [
      ...(root
        ? [
            db
              .prepare(
                `INSERT INTO conversations (id, workspace_id, channel_id, kind, root_message_id, parent_conversation_id)
                 VALUES (?, ?, ?, 'thread', ?, ?) ON CONFLICT DO NOTHING`,
              )
              .bind(
                conversationId,
                workspaceId,
                parent.channel_id,
                root.id,
                parent.conversation_id,
              ),
          ]
        : []),
      insertMessage(db, {
        id: messageId,
        workspaceId,
        conversationId,
        actorId: parent.actor_id,
        clientMessageId: env.idempotencyKey,
        body: command.text,
      }),
      ...deliveries.flatMap((d) =>
        deliveryStatements(db, env, {
          userId: user.userId,
          messageId,
          botId: d.botId,
          channelId: parent.channel_id,
          conversationId,
          kind: "request",
          delivery: "wake",
          inboxItemId: d.inboxItemId,
          receivedAt,
        }),
      ),
      ...(joining.length > 0
        ? [
            db
              .prepare(
                `INSERT INTO channel_members (workspace_id, channel_id, actor_id, role)
                 SELECT ?, ?, value, 'member' FROM json_each(?) WHERE true ON CONFLICT DO NOTHING`,
              )
              .bind(workspaceId, parent.channel_id, JSON.stringify(joining)),
          ]
        : []),
      indexLater(db, workspaceId, "message", messageId),
    ],
    response,
    [
      { entityKind: "message", entityId: messageId, scope },
      ...deliveries.map((d) => ({ entityKind: "inbox_item", entityId: d.inboxItemId, scope })),
      ...(joining.length > 0
        ? [{ entityKind: "channel", entityId: parent.channel_id, scope }]
        : []),
    ],
  );
};

const eventEmit: Handler<v.InferOutput<typeof EventEmit>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const { event } = command;
  if (!userEventType.test(event.type)) {
    throw new HttpError("FORBIDDEN", "users may only emit custom.* events");
  }
  const receivedAt = new Date().toISOString();
  const eventId = crypto.randomUUID();
  const response: EventEmitAccepted = {
    operationId: env.operationId,
    status: "accepted",
    eventId,
    receivedAt,
  };
  return receipt(
    db,
    user.userId,
    env,
    [
      insertEvent(db, {
        id: eventId,
        workspaceId,
        type: event.type,
        schemaVersion: 1,
        sourceKind: "cli",
        actorKind: "user",
        actorId: user.userId,
        subjectKind: event.subject?.kind,
        subjectId: event.subject?.id,
        data: event.data,
        correlationId: env.operationId,
        occurredAt: event.occurredAt ?? receivedAt,
        receivedAt,
      }),
      enqueueOutbox(db, { workspaceId, topic: "event.route", payload: { eventId } }),
    ],
    response,
    // Events are not a synced entity; routing logs the inbox items / Jobs it creates.
    [],
  );
};

// --------------------------------------------------- Work (docs/architecture.md §4)
// State conditions (revision, status, readiness, results) live in the guarded UPDATE, not in a pre-check, so a
// replay reaches the stored receipt and a concurrent change rolls the batch back. `explainTask` names the cause.

type TaskRow = {
  id: string;
  project_id: string | null;
  status: string;
  revision: number;
  scope_revision: number;
  completion_policy: string;
};
const openStatuses = "('pending', 'in_progress')";

const loadTask = async (db: D1Database, workspaceId: string, taskId: string) => {
  const task = await db
    .prepare(
      `SELECT id, project_id, status, revision, scope_revision, completion_policy FROM tasks
        WHERE workspace_id = ? AND id = ?`,
    )
    .bind(workspaceId, taskId)
    .first<TaskRow>();
  if (!task) throw new HttpError("NOT_FOUND", `task not found: ${taskId}`);
  return task;
};

const prerequisiteStatuses = async (db: D1Database, workspaceId: string, taskId: string) =>
  (
    await db
      .prepare(
        `SELECT p.status FROM task_dependencies d
           JOIN tasks p ON p.workspace_id = d.workspace_id AND p.id = d.prerequisite_task_id
          WHERE d.workspace_id = ? AND d.dependent_task_id = ?`,
      )
      .bind(workspaceId, taskId)
      .all<{ status: string }>()
  ).results;

const notReady = `EXISTS (SELECT 1 FROM task_dependencies d
  JOIN tasks p ON p.workspace_id = d.workspace_id AND p.id = d.prerequisite_task_id
 WHERE d.workspace_id = tasks.workspace_id AND d.dependent_task_id = tasks.id AND p.status <> 'completed')`;

/** The common causes of a failed Task CAS: revision moved on, or the Task is no longer open. */
const explainTask = async (
  db: D1Database,
  workspaceId: string,
  taskId: string,
  expectedRevision?: number,
) => {
  const task = await loadTask(db, workspaceId, taskId);
  if (expectedRevision !== undefined && task.revision !== expectedRevision) {
    return new HttpError(
      "REVISION_CONFLICT",
      `task revision is ${task.revision}; refetch and retry`,
      false,
      "stale_revision",
    );
  }
  if (task.status !== "pending" && task.status !== "in_progress") {
    return new HttpError("INVALID_INPUT", `task is ${task.status}`, false, "invalid_status");
  }
  return null;
};

/** `UPDATE tasks ... WHERE <id> AND revision = ? AND <extra>` that must change one row, plus its guard. */
const taskCas = (
  db: D1Database,
  input: {
    workspaceId: string;
    taskId: string;
    expectedRevision: number;
    set: string;
    where?: string;
  },
  ...params: unknown[]
) => {
  const [setGuard, clearGuard] = guard(db);
  return [
    db
      .prepare(
        `UPDATE tasks SET ${input.set}, revision = revision + 1, updated_at = ?
          WHERE workspace_id = ? AND id = ? AND revision = ? ${input.where ? `AND ${input.where}` : ""}`,
      )
      .bind(
        ...params,
        new Date().toISOString(),
        input.workspaceId,
        input.taskId,
        input.expectedRevision,
      ),
    setGuard,
    clearGuard,
    indexLater(db, input.workspaceId, "task", input.taskId),
  ];
};

const taskChange = (workspaceId: string, taskId: string, revision?: number): Change => ({
  entityKind: "task",
  entityId: taskId,
  ...(revision === undefined ? {} : { revision }),
  scope: `workspace:${workspaceId}`,
});

const projectCreate: Handler<v.InferOutput<typeof ProjectCreate>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const projectId = crypto.randomUUID();
  const run = receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare("INSERT INTO projects (id, workspace_id, key, name) VALUES (?, ?, ?, ?)")
        .bind(projectId, workspaceId, command.key, command.name),
    ],
    { operationId: env.operationId, status: "accepted", projectId, key: command.key },
    [{ entityKind: "project", entityId: projectId, scope: `workspace:${workspaceId}` }],
  );
  return uniqueName(db, "projects", workspaceId, command.key, run, "key");
};

/** The key `<projectKey>-<n>` comes from the Project's counter, advanced by CAS in the same batch. */
const taskCreate: TaskHandler<v.InferOutput<typeof TaskCreate>> = async (db, actorId, env) => {
  const { workspaceId, command } = env;
  const parent = command.parentTaskId
    ? await loadTask(db, workspaceId, command.parentTaskId)
    : null;
  if (!command.projectKey && !parent) {
    throw new HttpError("INVALID_INPUT", "projectKey or parentTaskId is required");
  }
  const project = await db
    .prepare(
      `SELECT id, key, task_counter FROM projects WHERE workspace_id = ? AND ${
        command.projectKey ? "key = ?" : "id = ?"
      }`,
    )
    .bind(workspaceId, command.projectKey ?? parent?.project_id ?? null)
    .first<{ id: string; key: string; task_counter: number }>();
  if (!project) throw new HttpError("NOT_FOUND", "project not found");
  if (parent && parent.project_id !== project.id) {
    throw new HttpError("INVALID_INPUT", "a subtask stays in its parent's project");
  }
  const taskId = crypto.randomUUID();
  const n = project.task_counter + 1;
  const key = `${project.key}-${n}`;
  const [setGuard, clearGuard] = guard(db);
  const run = receipt(
    db,
    actorId,
    env,
    [
      db
        .prepare(
          `UPDATE projects SET task_counter = ?, updated_at = ?
            WHERE workspace_id = ? AND id = ? AND task_counter = ?`,
        )
        .bind(n, new Date().toISOString(), workspaceId, project.id, project.task_counter),
      setGuard,
      clearGuard,
      db
        .prepare(
          `INSERT INTO tasks (id, workspace_id, project_id, parent_task_id, key, title, description, priority,
             completion_policy)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          taskId,
          workspaceId,
          project.id,
          parent?.id ?? null,
          key,
          command.title,
          command.description,
          command.priority,
          command.completionPolicy,
        ),
      indexLater(db, workspaceId, "task", taskId),
    ],
    { operationId: env.operationId, status: "accepted", taskId, key },
    [taskChange(workspaceId, taskId, 1)],
  );
  // ponytail: a concurrent task.create in the same Project loses the counter CAS and gets a retryable 409.
  return explainFailure(
    run,
    async () =>
      new HttpError(
        "REVISION_CONFLICT",
        "project task counter moved on; retry",
        true,
        "concurrent_create",
      ),
  );
};

const taskAssign: TaskHandler<v.InferOutput<typeof TaskAssign>> = async (db, actorId, env) => {
  const { workspaceId, command } = env;
  await loadTask(db, workspaceId, command.taskId);
  const { assignee } = command;
  if (assignee) {
    const exists = await db
      .prepare(
        assignee.kind === "bot"
          ? "SELECT 1 FROM bots WHERE workspace_id = ? AND id = ?"
          : "SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
      )
      .bind(workspaceId, assignee.id)
      .first();
    if (!exists) throw new HttpError("NOT_FOUND", `assignee ${assignee.kind} not found`);
  }
  const cas = { workspaceId, taskId: command.taskId, expectedRevision: command.expectedRevision };
  const run = receipt(
    db,
    actorId,
    env,
    taskCas(
      db,
      { ...cas, set: "assignee_kind = ?, assignee_id = ?" },
      assignee?.kind ?? null,
      assignee?.id ?? null,
    ),
    { operationId: env.operationId, status: "accepted", taskId: command.taskId },
    [taskChange(workspaceId, command.taskId, command.expectedRevision + 1)],
  );
  return explainFailure(run, () =>
    explainTask(db, workspaceId, command.taskId, command.expectedRevision),
  );
};

/**
 * Removes, then adds start dependencies; any cycle through dependencies or parent/child is 422 (AT-18). Bumps
 * `scope_revision`, so earlier Results no longer satisfy completion.
 */
const taskPlan: TaskHandler<v.InferOutput<typeof TaskPlan>> = async (db, actorId, env) => {
  const { workspaceId, command } = env;
  const { taskId } = command;
  await loadTask(db, workspaceId, taskId);
  await Promise.all(command.addPrerequisites.map((id) => loadTask(db, workspaceId, id)));
  // ponytail: reads the Workspace's whole graph, and the CAS covers only this Task's revision, so two
  // concurrent plans on different Tasks can still close a cycle; add `workspaces.control_revision` (§11.2).
  const [deps, parents] = await Promise.all([
    db
      .prepare(
        `SELECT prerequisite_task_id AS prerequisite, dependent_task_id AS dependent
           FROM task_dependencies WHERE workspace_id = ?`,
      )
      .bind(workspaceId)
      .all<{ prerequisite: string; dependent: string }>(),
    db
      .prepare(
        `SELECT id AS child, parent_task_id AS parent FROM tasks
          WHERE workspace_id = ? AND parent_task_id IS NOT NULL`,
      )
      .bind(workspaceId)
      .all<{ child: string; parent: string }>(),
  ]);
  const removed = new Set<string>(command.removePrerequisites);
  const edges = deps.results.filter(
    (e) => !(e.dependent === taskId && removed.has(e.prerequisite)),
  );
  for (const prerequisite of command.addPrerequisites) {
    const edge = { prerequisite, dependent: taskId };
    if (wouldCreateCycle(edges, parents.results, edge)) {
      throw new HttpError(
        "INVALID_INPUT",
        `dependency cycle: ${prerequisite} → ${taskId}`,
        false,
        "cycle",
      );
    }
    edges.push(edge);
  }
  const dependency = (prerequisite: string, op: "upsert" | "delete"): Change => ({
    entityKind: "task_dependency",
    entityId: `${prerequisite}:${taskId}`,
    op,
    scope: `workspace:${workspaceId}`,
  });
  const run = receipt(
    db,
    actorId,
    env,
    [
      ...taskCas(db, {
        workspaceId,
        taskId,
        expectedRevision: command.expectedRevision,
        set: "scope_revision = scope_revision + 1",
      }),
      ...command.removePrerequisites.map((id) =>
        db
          .prepare(
            `DELETE FROM task_dependencies
              WHERE workspace_id = ? AND prerequisite_task_id = ? AND dependent_task_id = ?`,
          )
          .bind(workspaceId, id, taskId),
      ),
      ...command.addPrerequisites.map((id) =>
        db
          .prepare(
            `INSERT INTO task_dependencies (workspace_id, prerequisite_task_id, dependent_task_id)
             VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
          )
          .bind(workspaceId, id, taskId),
      ),
    ],
    { operationId: env.operationId, status: "accepted", taskId },
    [
      taskChange(workspaceId, taskId, command.expectedRevision + 1),
      ...command.removePrerequisites.map((id) => dependency(id, "delete")),
      ...command.addPrerequisites.map((id) => dependency(id, "upsert")),
    ],
  );
  return explainFailure(run, () => explainTask(db, workspaceId, taskId, command.expectedRevision));
};

/** `declaration` policy only: a succeeded Result for the current `scope_revision` must exist (§4.3). */
const taskComplete: TaskHandler<v.InferOutput<typeof TaskComplete>> = async (db, actorId, env) => {
  const { workspaceId, command } = env;
  await loadTask(db, workspaceId, command.taskId);
  const run = receipt(
    db,
    actorId,
    env,
    taskCas(db, {
      workspaceId,
      taskId: command.taskId,
      expectedRevision: command.expectedRevision,
      set: "status = 'completed'",
      where: `status IN ${openStatuses} AND completion_policy = 'declaration'
        AND EXISTS (SELECT 1 FROM task_results r
          WHERE r.workspace_id = tasks.workspace_id AND r.task_id = tasks.id
            AND r.state = 'succeeded' AND r.scope_revision = tasks.scope_revision)`,
    }),
    { operationId: env.operationId, status: "accepted", taskId: command.taskId },
    [taskChange(workspaceId, command.taskId, command.expectedRevision + 1)],
  );
  return explainFailure(run, async () => {
    const common = await explainTask(db, workspaceId, command.taskId, command.expectedRevision);
    if (common) return common;
    const task = await loadTask(db, workspaceId, command.taskId);
    if (task.completion_policy !== "declaration") {
      return new HttpError(
        "INVALID_INPUT",
        `completion policy ${task.completion_policy} is not supported yet`,
        false,
        "unsupported_policy",
      );
    }
    return new HttpError(
      "INVALID_INPUT",
      `no succeeded result for scope revision ${task.scope_revision}`,
      false,
      "no_result",
    );
  });
};

/** Does not stop running Jobs of the Task (no job.cancel yet). */
const taskCancel: Handler<v.InferOutput<typeof TaskCancel>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  await loadTask(db, workspaceId, command.taskId);
  const run = receipt(
    db,
    user.userId,
    env,
    taskCas(db, {
      workspaceId,
      taskId: command.taskId,
      expectedRevision: command.expectedRevision,
      set: "status = 'cancelled'",
      where: `status IN ${openStatuses}`,
    }),
    { operationId: env.operationId, status: "accepted", taskId: command.taskId },
    [taskChange(workspaceId, command.taskId, command.expectedRevision + 1)],
  );
  return explainFailure(run, () =>
    explainTask(db, workspaceId, command.taskId, command.expectedRevision),
  );
};

/**
 * A queued Job for the Task (§23 `hive job start`). The guarded UPDATE requires an open, ready Task (prerequisites
 * all completed) and moves `pending` to `in_progress`. Trigger key `task:<id>:<scope_revision>:<n>`, n = prior Jobs
 * of the Task + 1: a retry gets a new Job, an identical double submit replays the receipt.
 */
const jobStart: Handler<v.InferOutput<typeof JobStart>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const task = await loadTask(db, workspaceId, command.taskId);
  const bot = await db
    .prepare("SELECT placement_policy FROM bots WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, command.botId)
    .first<{ placement_policy: string }>();
  if (!bot) throw new HttpError("NOT_FOUND", "bot not found");
  let placement: PlacementPolicy | undefined;
  if (command.deviceId) {
    const device = await db
      .prepare("SELECT 1 FROM devices WHERE workspace_id = ? AND id = ? AND revoked_at IS NULL")
      .bind(workspaceId, command.deviceId)
      .first();
    if (!device) throw new HttpError("NOT_FOUND", "device not found");
    const policy = JSON.parse(bot.placement_policy) as PlacementPolicy;
    // Safety constraints are intersected (§10.2): the pin must be inside the Bot's allowed devices.
    if (policy.allowedDeviceIds.length > 0 && !policy.allowedDeviceIds.includes(command.deviceId)) {
      throw new HttpError(
        "INVALID_INPUT",
        "the bot's placement does not allow this device",
        false,
        "not_eligible",
      );
    }
    placement = {
      ...policy,
      mode: "pinned",
      allowedDeviceIds: [command.deviceId],
      preferredDeviceIds: [command.deviceId],
    };
  }
  const prior = await db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE workspace_id = ? AND task_id = ?")
    .bind(workspaceId, command.taskId)
    .first<{ n: number }>();
  const jobId = crypto.randomUUID();
  const triggerKey = `task:${command.taskId}:${task.scope_revision}:${(prior?.n ?? 0) + 1}`;
  const [setGuard, clearGuard] = guard(db);
  const now = new Date().toISOString();
  const run = receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          `UPDATE tasks
              SET revision = revision + (status = 'pending'), status = 'in_progress', updated_at = ?
            WHERE workspace_id = ? AND id = ? AND status IN ${openStatuses} AND NOT ${notReady}`,
        )
        .bind(now, workspaceId, command.taskId),
      setGuard,
      clearGuard,
      createJob(db, {
        id: jobId,
        workspaceId,
        botId: command.botId,
        triggerKey,
        taskId: command.taskId,
        placement,
      }),
      indexLater(db, workspaceId, "task", command.taskId),
    ],
    { operationId: env.operationId, status: "accepted", jobId, taskId: command.taskId, triggerKey },
    [
      { entityKind: "job", entityId: jobId, revision: 1, scope: `workspace:${workspaceId}` },
      // The revision is unknown when the batch is built: it bumps only for `pending`.
      taskChange(workspaceId, command.taskId),
    ],
  );
  return explainFailure(run, async () => {
    const common = await explainTask(db, workspaceId, command.taskId);
    if (common) return common;
    if (readiness(await prerequisiteStatuses(db, workspaceId, command.taskId)) === "blocked") {
      return new HttpError(
        "INVALID_INPUT",
        "task is blocked by its prerequisites",
        false,
        "blocked",
      );
    }
    // The trigger key's n was taken by a concurrent job.start.
    return new HttpError(
      "REVISION_CONFLICT",
      "concurrent job.start; retry",
      true,
      "concurrent_start",
    );
  });
};

// ------------------------------------------ Delegation (docs/architecture.md §8.1)

type Delegator = { kind: "user"; userId: string } | { kind: "run"; run: Run };

/**
 * Delegation, the receiving Bot's Job (`delegation:<id>`, the Bot's placement) and a Task CAS in one batch. The CAS
 * bumps the Task's revision, so the assignee read for a Bot's authority is current; the assignee itself is unchanged.
 * From a Run the instructions also become a message in the two Bots' `bot_pair` conversation, and the §8.2 hop and
 * chain limits apply. Bot pause state and Channel/Project ACL are not built, so they are not checked.
 */
const taskDelegate = async (
  db: D1Database,
  from: Delegator,
  env: Envelope & { command: v.InferOutput<typeof TaskDelegate> },
) => {
  const { workspaceId, command } = env;
  const task = await loadTask(db, workspaceId, command.taskId);
  const bot = await db
    .prepare("SELECT 1 FROM bots WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, command.toBotId)
    .first();
  if (!bot) throw new HttpError("NOT_FOUND", "bot not found");
  const run = from.kind === "run" ? from.run : null;
  let parentExecutionId: string | null = null;
  if (run) {
    if (command.toBotId === run.botId) {
      throw chainLimit("a bot cannot delegate to itself", "self_delegation");
    }
    const authority = await db
      .prepare(
        `SELECT EXISTS (SELECT 1 FROM tasks WHERE workspace_id = ?1 AND id = ?2
                          AND assignee_kind = 'bot' AND assignee_id = ?3) AS assignee,
                EXISTS (SELECT 1 FROM delegations WHERE workspace_id = ?1 AND task_id = ?2
                          AND to_bot_id = ?3 AND state = 'active' AND mode = 'write') AS writer`,
      )
      .bind(workspaceId, command.taskId, run.botId)
      .first<{ assignee: number; writer: number }>();
    if (!authority?.assignee && !authority?.writer) {
      throw new HttpError(
        "FORBIDDEN",
        "only the task's assignee bot or an active write delegate may delegate it",
        false,
        "not_delegator",
      );
    }
    if (run.hop + 1 > maxHops) {
      throw chainLimit(`bot-to-bot chain exceeds ${maxHops} hops`, "hop_limit");
    }
    await checkChainBudget(db, run);
    parentExecutionId =
      (
        await db
          .prepare("SELECT id FROM executions WHERE workspace_id = ? AND run_id = ?")
          .bind(workspaceId, run.runId)
          .first<{ id: string }>()
      )?.id ?? null;
  }
  const delegationId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const hop = run ? run.hop + 1 : 0;
  const conversationId = run ? botPairId(run.botId, command.toBotId) : null;
  const scope = `workspace:${workspaceId}`;
  const instructions =
    run && conversationId
      ? [
          ...botPair(db, workspaceId, conversationId),
          insertMessage(db, {
            id: messageId,
            workspaceId,
            conversationId,
            actorId: run.botActorId,
            clientMessageId: env.idempotencyKey,
            body: command.instructions,
            kind: "delegation",
            hop,
            jobId: run.jobId,
          }),
          indexLater(db, workspaceId, "message", messageId),
        ]
      : [];
  const result = receipt(
    db,
    run ? run.runId : (from as { userId: string }).userId,
    env,
    [
      // No field changes: the CAS checks the revision and that the Task is open.
      ...taskCas(db, {
        workspaceId,
        taskId: command.taskId,
        expectedRevision: command.expectedRevision,
        set: "status = status",
        where: `status IN ${openStatuses}`,
      }),
      ...instructions,
      createJob(db, {
        id: jobId,
        workspaceId,
        botId: command.toBotId,
        triggerKey: `delegation:${delegationId}`,
        taskId: command.taskId,
        correlationId: run?.correlationId,
        delegationId,
      }),
      db
        .prepare(
          `INSERT INTO delegations (id, workspace_id, task_id, from_kind, from_id, parent_run_id, parent_execution_id,
             to_bot_id, mode, instructions, scope_revision, deadline, conversation_id, hop, job_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          delegationId,
          workspaceId,
          command.taskId,
          run ? "bot" : "user",
          run ? run.botId : (from as { userId: string }).userId,
          run?.runId ?? null,
          parentExecutionId,
          command.toBotId,
          command.mode,
          command.instructions,
          task.scope_revision,
          command.deadline ?? null,
          conversationId,
          hop,
          jobId,
        ),
    ],
    { operationId: env.operationId, status: "accepted", delegationId, jobId },
    [
      taskChange(workspaceId, command.taskId, command.expectedRevision + 1),
      { entityKind: "job", entityId: jobId, revision: 1, scope },
      { entityKind: "delegation", entityId: delegationId, scope },
      ...(conversationId
        ? [
            { entityKind: "conversation", entityId: conversationId, scope },
            { entityKind: "message", entityId: messageId, scope },
          ]
        : []),
    ],
  );
  return explainFailure(result, async () => {
    const common = await explainTask(db, workspaceId, command.taskId, command.expectedRevision);
    if (common) return common;
    const active = await db
      .prepare(
        "SELECT 1 FROM delegations WHERE workspace_id = ? AND task_id = ? AND to_bot_id = ? AND state = 'active'",
      )
      .bind(workspaceId, command.taskId, command.toBotId)
      .first();
    return active
      ? new HttpError(
          "RESOURCE_BUSY",
          "the bot already holds an active delegation on this task",
          false,
          "already_delegated",
        )
      : null;
  });
};

const delegationClosed = (state: string) =>
  new HttpError("REVISION_CONFLICT", `delegation is ${state}`, false, `delegation_${state}`);

/** `revoked`, and the Job cancelled like job.cancel: at once unless active (then a cancel request). */
const taskDelegateRevoke: Handler<v.InferOutput<typeof TaskDelegateRevoke>> = async (
  db,
  user,
  env,
) => {
  const { workspaceId, command } = env;
  const state = async () => {
    const row = await db
      .prepare("SELECT job_id, state FROM delegations WHERE workspace_id = ? AND id = ?")
      .bind(workspaceId, command.delegationId)
      .first<{ job_id: string; state: string }>();
    if (!row) throw new HttpError("NOT_FOUND", "delegation not found");
    return row;
  };
  const delegation = await state();
  if (delegation.state !== "active") throw delegationClosed(delegation.state);
  const now = new Date().toISOString();
  const [setGuard, clearGuard] = guard(db);
  const scope = `workspace:${workspaceId}`;
  const run = receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          `UPDATE delegations SET state = 'revoked', closed_at = ?
            WHERE workspace_id = ? AND id = ? AND state = 'active'`,
        )
        .bind(now, workspaceId, command.delegationId),
      setGuard,
      clearGuard,
      db
        .prepare(
          `UPDATE jobs SET state = CASE WHEN state = 'active' THEN state ELSE 'cancelled' END,
             cancel_requested_at = COALESCE(cancel_requested_at, ?), revision = revision + 1, updated_at = ?
            WHERE workspace_id = ? AND id = ? AND state IN ('queued', 'waiting_device', 'waiting_input', 'active')`,
        )
        .bind(now, now, workspaceId, delegation.job_id),
    ],
    {
      operationId: env.operationId,
      status: "accepted",
      delegationId: command.delegationId,
      state: "revoked",
    },
    [
      { entityKind: "delegation", entityId: command.delegationId, scope },
      { entityKind: "job", entityId: delegation.job_id, scope },
    ],
  );
  return explainFailure(run, async () => delegationClosed((await state()).state));
};

// ------------------------------------------ Subscriptions (docs/architecture.md §17.1)
// User principal only: there is no Bot principal yet. Every change bumps `revision` and copies the row to
// `subscription_revisions` in the same batch.

type SubscriptionCommand = v.InferOutput<typeof SubscriptionCreate>;

const loadSubscription = async (db: D1Database, workspaceId: string, id: string) => {
  const row = await db
    .prepare(
      `SELECT id, bot_id, integration_id, event_types, filter, destination, delivery, enabled, expires_at, revision
         FROM subscriptions WHERE workspace_id = ? AND id = ?`,
    )
    .bind(workspaceId, id)
    .first<SubscriptionRow & { enabled: number; expires_at: string | null; revision: number }>();
  if (!row) throw new HttpError("NOT_FOUND", "subscription not found");
  return row;
};

/** Immutable copy of the current row; a no-op when that revision is already recorded. */
const snapshotSubscription = (db: D1Database, id: string) =>
  db
    .prepare(
      `INSERT INTO subscription_revisions (subscription_id, workspace_id, bot_id, integration_id, event_types,
         filter, destination, delivery, enabled, expires_at, revision)
       SELECT id, workspace_id, bot_id, integration_id, event_types, filter, destination, delivery, enabled,
              expires_at, revision
         FROM subscriptions WHERE id = ?
       ON CONFLICT DO NOTHING`,
    )
    .bind(id);

/**
 * The destination Conversation must be in the Workspace and the caller a member of its Channel or the DM's user (forwarding into a
 * Channel needs access to it, §17.1); a Project / Task must exist.
 */
const checkDestination = async (
  db: D1Database,
  workspaceId: string,
  userId: string,
  destination: SubscriptionCommand["destination"],
) => {
  const conversation = await db
    .prepare(
      `SELECT (c.kind = 'dm' AND c.dm_user_id = ?1) OR EXISTS (SELECT 1 FROM channel_members m JOIN actors a
                ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
             WHERE m.workspace_id = c.workspace_id AND m.channel_id = c.channel_id AND a.user_id = ?1) AS member
         FROM conversations c WHERE c.workspace_id = ?2 AND c.id = ?3`,
    )
    .bind(userId, workspaceId, destination.conversationId)
    .first<{ member: number }>();
  if (!conversation) throw new HttpError("NOT_FOUND", "destination conversation not found");
  if (!conversation.member)
    throw new HttpError("FORBIDDEN", "not a member of the destination channel");
  for (const [table, id] of [
    ["projects", destination.projectId],
    ["tasks", destination.taskId],
  ] as const) {
    if (id === undefined) continue;
    // oxlint-disable-next-line no-await-in-loop -- at most two lookups
    const found = await db
      .prepare(`SELECT 1 FROM ${table} WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first();
    if (!found) throw new HttpError("NOT_FOUND", `destination ${table.slice(0, -1)} not found`);
  }
};

const subscriptionChange = (workspaceId: string, id: string, revision?: number): Change => ({
  entityKind: "subscription",
  entityId: id,
  ...(revision === undefined ? {} : { revision }),
  scope: `workspace:${workspaceId}`,
});

const subscriptionCreate: Handler<SubscriptionCommand> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const bot = await db
    .prepare("SELECT 1 FROM bots WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, command.botId)
    .first();
  if (!bot) throw new HttpError("NOT_FOUND", "bot not found");
  if (command.integrationId) {
    const integration = await db
      .prepare("SELECT 1 FROM integration_installations WHERE workspace_id = ? AND id = ?")
      .bind(workspaceId, command.integrationId)
      .first();
    if (!integration) throw new HttpError("NOT_FOUND", "integration not found");
  }
  await checkDestination(db, workspaceId, user.userId, command.destination);
  const subscriptionId = crypto.randomUUID();
  return receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          `INSERT INTO subscriptions (id, workspace_id, bot_id, integration_id, event_types, filter, destination,
             delivery, enabled, expires_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1)`,
        )
        .bind(
          subscriptionId,
          workspaceId,
          command.botId,
          command.integrationId ?? null,
          JSON.stringify(command.eventTypes),
          JSON.stringify(command.filter),
          JSON.stringify(command.destination),
          JSON.stringify(command.delivery),
          command.expiresAt ?? null,
        ),
      snapshotSubscription(db, subscriptionId),
    ],
    { operationId: env.operationId, status: "accepted", subscriptionId, revision: 1 },
    [subscriptionChange(workspaceId, subscriptionId, 1)],
  );
};

/** A replaced JSON column, or the stored one. */
const json = (value: unknown, stored: string) =>
  value === undefined ? stored : JSON.stringify(value);

/** Revision CAS: a stale `expectedRevision` is 409 REVISION_CONFLICT. */
const subscriptionUpdate: Handler<v.InferOutput<typeof SubscriptionUpdate>> = async (
  db,
  user,
  env,
) => {
  const { workspaceId, command } = env;
  const current = await loadSubscription(db, workspaceId, command.subscriptionId);
  if (command.destination) {
    await checkDestination(db, workspaceId, user.userId, command.destination);
  }
  const [setGuard, clearGuard] = guard(db);
  const run = receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          `UPDATE subscriptions SET event_types = ?, filter = ?, destination = ?, delivery = ?, expires_at = ?,
             enabled = ?, revision = revision + 1, updated_at = ?
            WHERE workspace_id = ? AND id = ? AND revision = ?`,
        )
        .bind(
          json(command.eventTypes, current.event_types),
          json(command.filter, current.filter),
          json(command.destination, current.destination),
          json(command.delivery, current.delivery),
          command.expiresAt === undefined ? current.expires_at : command.expiresAt,
          command.enabled === undefined ? current.enabled : Number(command.enabled),
          new Date().toISOString(),
          workspaceId,
          command.subscriptionId,
          command.expectedRevision,
        ),
      setGuard,
      clearGuard,
      snapshotSubscription(db, command.subscriptionId),
    ],
    {
      operationId: env.operationId,
      status: "accepted",
      subscriptionId: command.subscriptionId,
      revision: command.expectedRevision + 1,
    },
    [subscriptionChange(workspaceId, command.subscriptionId, command.expectedRevision + 1)],
  );
  return explainFailure(run, async () => {
    const row = await loadSubscription(db, workspaceId, command.subscriptionId);
    return row.revision === command.expectedRevision
      ? null
      : new HttpError(
          "REVISION_CONFLICT",
          `subscription revision is ${row.revision}; refetch and retry`,
          false,
          "stale_revision",
        );
  });
};

/** Stops new Deliveries. Pausing a paused Subscription changes nothing. */
const subscriptionPause: Handler<v.InferOutput<typeof SubscriptionPause>> = async (
  db,
  user,
  env,
) => {
  const { workspaceId, command } = env;
  await loadSubscription(db, workspaceId, command.subscriptionId);
  return receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          `UPDATE subscriptions SET enabled = 0, revision = revision + 1, updated_at = ?
            WHERE workspace_id = ? AND id = ? AND enabled = 1`,
        )
        .bind(new Date().toISOString(), workspaceId, command.subscriptionId),
      snapshotSubscription(db, command.subscriptionId),
    ],
    { operationId: env.operationId, status: "accepted", subscriptionId: command.subscriptionId },
    [subscriptionChange(workspaceId, command.subscriptionId)],
  );
};

/** Revisions stay as history; pending Inbox items and Jobs are kept (§6.4). */
const subscriptionDelete: Handler<v.InferOutput<typeof SubscriptionDelete>> = async (
  db,
  user,
  env,
) => {
  const { workspaceId, command } = env;
  await loadSubscription(db, workspaceId, command.subscriptionId);
  return receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare("DELETE FROM subscriptions WHERE workspace_id = ? AND id = ?")
        .bind(workspaceId, command.subscriptionId),
    ],
    { operationId: env.operationId, status: "accepted", subscriptionId: command.subscriptionId },
    [{ ...subscriptionChange(workspaceId, command.subscriptionId), op: "delete" }],
  );
};

/**
 * Dry-run (AT-06 style): evaluates the Subscription, whatever its enabled state, over the Workspace's last `limit`
 * events and creates nothing, not even a receipt. Every Workspace member may read every event today.
 */
const subscriptionTest: Handler<v.InferOutput<typeof SubscriptionTest>> = async (
  db,
  _user,
  env,
) => {
  const { workspaceId, command } = env;
  const sub = await loadSubscription(db, workspaceId, command.subscriptionId);
  const { results } = await db
    .prepare(
      `SELECT ${eventColumns} FROM events WHERE workspace_id = ?
        ORDER BY received_at DESC, id DESC LIMIT ?`,
    )
    .bind(workspaceId, command.limit)
    .all<EventRow>();
  const matched = results
    .filter((event) => subscriptionMatches(sub, event))
    .map((e) => ({ eventId: e.id, type: e.type, receivedAt: e.received_at }));
  return {
    status: 200,
    response: {
      operationId: env.operationId,
      subscriptionId: sub.id,
      revision: sub.revision,
      evaluated: results.length,
      matched,
    },
  };
};

/** The hook URL path for the integration-worker. Secrets are environment-level (no per-installation secret yet). */
const integrationCreate: Handler<v.InferOutput<typeof IntegrationCreate>> = async (
  db,
  user,
  env,
) => {
  const { workspaceId, command } = env;
  const integrationId = crypto.randomUUID();
  return receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          "INSERT INTO integration_installations (id, workspace_id, kind, external_account_id) VALUES (?, ?, ?, ?)",
        )
        .bind(integrationId, workspaceId, command.kind, command.externalAccountId ?? null),
    ],
    {
      operationId: env.operationId,
      status: "accepted",
      integrationId,
      kind: command.kind,
      hookPath: `/hooks/${command.kind}/${integrationId}`,
    },
    [{ entityKind: "integration", entityId: integrationId, scope: `workspace:${workspaceId}` }],
  );
};

// ------------------------------------------------- Job control (§9.3, §10.4)

const terminalRunStates = "('succeeded', 'failed', 'interrupted', 'cancelled')";

const loadJob = async (db: D1Database, workspaceId: string, jobId: string) => {
  const job = await db
    .prepare("SELECT state, revision FROM jobs WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, jobId)
    .first<{ state: string; revision: number }>();
  if (!job) throw new HttpError("NOT_FOUND", "job not found");
  return job;
};

const jobChanged = (state: string) =>
  new HttpError("REVISION_CONFLICT", `job is ${state}`, false, `job_${state}`);

/**
 * A request, not a stop (§9.3): a `queued` / `waiting_device` Job is `cancelled` at once; an `active` one keeps running
 * until its executor sees `cancelRequested` on lease renewal and submits. A `recovery_required` Job uses job.resolve.
 */
const jobCancel: Handler<v.InferOutput<typeof JobCancel>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const job = await loadJob(db, workspaceId, command.jobId);
  const waiting = ["queued", "waiting_device", "waiting_input"].includes(job.state);
  if (!waiting && job.state !== "active") throw jobChanged(job.state);
  const now = new Date().toISOString();
  const [setGuard, clearGuard] = guard(db);
  const run = receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          `UPDATE jobs SET state = ?, cancel_requested_at = COALESCE(cancel_requested_at, ?),
             revision = revision + 1, updated_at = ?
            WHERE workspace_id = ? AND id = ? AND state = ? AND revision = ?`,
        )
        .bind(
          waiting ? "cancelled" : "active",
          now,
          now,
          workspaceId,
          command.jobId,
          job.state,
          job.revision,
        ),
      setGuard,
      clearGuard,
    ],
    {
      operationId: env.operationId,
      status: "accepted",
      jobId: command.jobId,
      state: waiting ? "cancelled" : "active",
      cancelRequested: true,
    },
    [
      {
        entityKind: "job",
        entityId: command.jobId,
        revision: job.revision + 1,
        scope: `workspace:${workspaceId}`,
      },
    ],
  );
  return explainFailure(run, async () => {
    const current = await loadJob(db, workspaceId, command.jobId);
    return new HttpError(
      "REVISION_CONFLICT",
      `job is ${current.state}; retry`,
      true,
      "job_changed",
    );
  });
};

/**
 * Human resolution of a `recovery_required` Job (§10.4, AT-13). `retry` queues it again only once the old Run's stop
 * is confirmed (it is terminal, so the one-active-root index lets a new claim in, with generation + 1).
 */
const jobResolve: Handler<v.InferOutput<typeof JobResolve>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const job = await loadJob(db, workspaceId, command.jobId);
  if (job.state !== "recovery_required") throw jobChanged(job.state);
  const unconfirmed = `EXISTS (SELECT 1 FROM runs WHERE workspace_id = jobs.workspace_id AND job_id = jobs.id
    AND kind = 'root' AND state NOT IN ${terminalRunStates})`;
  if (command.action === "retry") {
    const busy = await db
      .prepare(`SELECT ${unconfirmed} AS busy FROM jobs WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, command.jobId)
      .first<{ busy: number }>();
    if (busy?.busy) {
      throw new HttpError(
        "RESOURCE_BUSY",
        "the previous run's stop is not confirmed",
        true,
        "unconfirmed_stop",
      );
    }
  }
  const state = { retry: "queued", cancel: "cancelled", mark_failed: "failed" }[command.action];
  const now = new Date().toISOString();
  const [setGuard, clearGuard] = guard(db);
  const run = receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          `UPDATE jobs SET state = ?, revision = revision + 1, updated_at = ?,
             cancel_requested_at = CASE ? WHEN 'cancelled' THEN COALESCE(cancel_requested_at, ?)
               WHEN 'queued' THEN NULL ELSE cancel_requested_at END
            WHERE workspace_id = ? AND id = ? AND state = 'recovery_required' AND revision = ?
              ${command.action === "retry" ? `AND NOT ${unconfirmed}` : ""}`,
        )
        .bind(state, now, state, now, workspaceId, command.jobId, job.revision),
      setGuard,
      clearGuard,
    ],
    { operationId: env.operationId, status: "accepted", jobId: command.jobId, state },
    [
      {
        entityKind: "job",
        entityId: command.jobId,
        revision: job.revision + 1,
        scope: `workspace:${workspaceId}`,
      },
    ],
  );
  return explainFailure(run, async () => {
    const current = await loadJob(db, workspaceId, command.jobId);
    return current.state === "recovery_required" && current.revision === job.revision
      ? new HttpError(
          "RESOURCE_BUSY",
          "the previous run's stop is not confirmed",
          true,
          "unconfirmed_stop",
        )
      : jobChanged(current.state);
  });
};

// ------------------------------------------------ Routines (docs/architecture.md §17.2)

const loadRoutine = async (db: D1Database, workspaceId: string, id: string) => {
  const row = await db
    .prepare(`SELECT ${routineColumns} FROM ${routineFrom} WHERE r.workspace_id = ? AND r.id = ?`)
    .bind(workspaceId, id)
    .first<RoutineRow>();
  if (!row) throw new HttpError("NOT_FOUND", "routine not found");
  return row;
};

const routineChange = (workspaceId: string, id: string, revision?: number): Change => ({
  entityKind: "routine",
  entityId: id,
  ...(revision === undefined ? {} : { revision }),
  scope: `workspace:${workspaceId}`,
});

const routineHookPath = (routineId: string) => `/v1/hooks/routines/${routineId}`;
const newRoutineWebhookSecret = () => `hive_routine_${newDeviceSecret()}`;

/** The Conversation (if any) must be one whose Channel the caller is a member of; a Task must exist. */
const routineCreate: Handler<v.InferOutput<typeof RoutineCreate>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const bot = await db
    .prepare("SELECT 1 FROM bots WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, command.botId)
    .first();
  if (!bot) throw new HttpError("NOT_FOUND", "bot not found");
  if (command.conversationId) {
    await checkDestination(db, workspaceId, user.userId, {
      conversationId: command.conversationId,
      ...(command.taskId ? { taskId: command.taskId } : {}),
    });
  } else if (command.taskId) {
    await loadTask(db, workspaceId, command.taskId);
  }
  const routineId = crypto.randomUUID();
  const secret = command.schedule.kind === "webhook" ? newRoutineWebhookSecret() : null;
  const nextFireAt = firstFireAt(command.schedule, Date.now());
  const result = await receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          `INSERT INTO routines
             (id, workspace_id, bot_id, name, conversation_id, task_id, input_text, schedule, webhook_secret_hash,
              misfire, next_fire_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          routineId,
          workspaceId,
          command.botId,
          command.name,
          command.conversationId ?? null,
          command.taskId ?? null,
          command.inputText,
          JSON.stringify(command.schedule),
          secret === null ? null : await hashSecret(secret),
          command.misfire,
          nextFireAt,
        ),
    ],
    // The receipt keeps a redacted response: an idempotent retry cannot recover the secret.
    {
      operationId: env.operationId,
      status: "accepted",
      routineId,
      revision: 1,
      nextFireAt,
      hookPath: secret === null ? null : routineHookPath(routineId),
      secret: null as string | null,
    },
    [routineChange(workspaceId, routineId, 1)],
  );
  if (secret === null || result.replayed) return result;
  return { ...result, response: { ...result.response, secret } };
};

const staleRoutine = (revision: number) =>
  new HttpError(
    "REVISION_CONFLICT",
    `routine revision is ${revision}; refetch and retry`,
    false,
    "stale_revision",
  );

/** Revision CAS. A new schedule bumps `schedule_revision` and restarts `next_fire_at` from now. */
const routineUpdate: Handler<v.InferOutput<typeof RoutineUpdate>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const current = await loadRoutine(db, workspaceId, command.routineId);
  const currentSchedule = JSON.parse(current.schedule) as RoutineSchedule;
  const schedule = command.schedule;
  const secret =
    schedule?.kind === "webhook" && currentSchedule.kind !== "webhook"
      ? newRoutineWebhookSecret()
      : null;
  const nextFireAt = schedule ? firstFireAt(schedule, Date.now()) : current.next_fire_at;
  const [setGuard, clearGuard] = guard(db);
  const run = receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          `UPDATE routines SET name = COALESCE(?, name), input_text = COALESCE(?, input_text),
             misfire = COALESCE(?, misfire), schedule = COALESCE(?, schedule),
             webhook_secret_hash = CASE WHEN ? THEN ? WHEN ? THEN NULL ELSE webhook_secret_hash END,
             schedule_revision = schedule_revision + ?, next_fire_at = ?, revision = revision + 1, updated_at = ?
            WHERE workspace_id = ? AND id = ? AND revision = ?`,
        )
        .bind(
          command.name ?? null,
          command.inputText ?? null,
          command.misfire ?? null,
          schedule ? JSON.stringify(schedule) : null,
          secret !== null ? 1 : 0,
          secret === null ? null : await hashSecret(secret),
          schedule !== undefined && schedule.kind !== "webhook" ? 1 : 0,
          schedule ? 1 : 0,
          nextFireAt,
          new Date().toISOString(),
          workspaceId,
          command.routineId,
          command.expectedRevision,
        ),
      setGuard,
      clearGuard,
    ],
    {
      operationId: env.operationId,
      status: "accepted",
      routineId: command.routineId,
      revision: command.expectedRevision + 1,
      nextFireAt,
      hookPath:
        (schedule === undefined ? currentSchedule.kind : schedule.kind) === "webhook"
          ? routineHookPath(command.routineId)
          : null,
      secret: null as string | null,
    },
    [routineChange(workspaceId, command.routineId, command.expectedRevision + 1)],
  );
  const result = await explainFailure(run, async () => {
    const row = await loadRoutine(db, workspaceId, command.routineId);
    return row.revision === command.expectedRevision ? null : staleRoutine(row.revision);
  });
  if (secret === null || result.replayed) return result;
  return { ...result, response: { ...result.response, secret } };
};

/** Stops new occurrences. Pausing a paused Routine changes nothing. */
const routinePause: Handler<v.InferOutput<typeof RoutinePause>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  await loadRoutine(db, workspaceId, command.routineId);
  return receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          `UPDATE routines SET enabled = 0, revision = revision + 1, updated_at = ?
            WHERE workspace_id = ? AND id = ? AND enabled = 1`,
        )
        .bind(new Date().toISOString(), workspaceId, command.routineId),
    ],
    { operationId: env.operationId, status: "accepted", routineId: command.routineId },
    [routineChange(workspaceId, command.routineId)],
  );
};

/** Restarts from now, so occurrences missed while paused are never created. */
const routineResume: Handler<v.InferOutput<typeof RoutineResume>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const current = await loadRoutine(db, workspaceId, command.routineId);
  const nextFireAt = firstFireAt(JSON.parse(current.schedule) as RoutineSchedule, Date.now());
  return receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          `UPDATE routines SET enabled = 1, next_fire_at = ?, revision = revision + 1, updated_at = ?
            WHERE workspace_id = ? AND id = ? AND enabled = 0`,
        )
        .bind(nextFireAt, new Date().toISOString(), workspaceId, command.routineId),
    ],
    { operationId: env.operationId, status: "accepted", routineId: command.routineId, nextFireAt },
    [routineChange(workspaceId, command.routineId)],
  );
};

/** Manual run: an occurrence at now through the same Inbox item + Job path as a tick (§17.2). */
const routineRun: Handler<v.InferOutput<typeof RoutineRun>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const routine = await loadRoutine(db, workspaceId, command.routineId);
  const scheduledAt = new Date().toISOString();
  const occurrence = occurrenceStatements(db, routine, scheduledAt, {
    occurrenceKey: `manual:${env.operationId}`,
  });
  return receipt(
    db,
    user.userId,
    env,
    occurrence.statements,
    {
      operationId: env.operationId,
      status: "accepted",
      routineId: routine.id,
      occurrenceId: occurrence.occurrenceId,
      jobId: occurrence.jobId,
      scheduledAt,
    },
    occurrence.changes,
  );
};

/** Replaces the hash only; the displayed secret never reaches the operation receipt. */
const routineRotateSecret: Handler<v.InferOutput<typeof RoutineRotateSecret>> = async (
  db,
  user,
  env,
) => {
  const { workspaceId, command } = env;
  const current = await loadRoutine(db, workspaceId, command.routineId);
  if ((JSON.parse(current.schedule) as RoutineSchedule).kind !== "webhook") {
    throw new HttpError("INVALID_INPUT", "routine is not a webhook");
  }
  const secret = newRoutineWebhookSecret();
  const [setGuard, clearGuard] = guard(db);
  const run = receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          `UPDATE routines SET webhook_secret_hash = ?, revision = revision + 1, updated_at = ?
            WHERE workspace_id = ? AND id = ? AND revision = ?
              AND json_extract(schedule, '$.kind') = 'webhook'`,
        )
        .bind(
          await hashSecret(secret),
          new Date().toISOString(),
          workspaceId,
          command.routineId,
          current.revision,
        ),
      setGuard,
      clearGuard,
    ],
    {
      operationId: env.operationId,
      status: "accepted",
      routineId: command.routineId,
      revision: current.revision + 1,
      hookPath: routineHookPath(command.routineId),
      secret: null as string | null,
    },
    [routineChange(workspaceId, command.routineId, current.revision + 1)],
  );
  const result = await explainFailure(run, async () => {
    const row = await loadRoutine(db, workspaceId, command.routineId);
    return row.revision === current.revision ? null : staleRoutine(row.revision);
  });
  if (result.replayed) return result;
  return { ...result, response: { ...result.response, secret } };
};

/** Deletes the Routine and its occurrences in one batch; Jobs it created stay (they do not reference the Routine). */
const routineDelete: Handler<v.InferOutput<typeof RoutineDelete>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  await loadRoutine(db, workspaceId, command.routineId);
  return receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare("DELETE FROM routine_webhook_deliveries WHERE routine_id = ?")
        .bind(command.routineId),
      db
        .prepare("DELETE FROM routine_webhook_rate_limits WHERE routine_id = ?")
        .bind(command.routineId),
      db
        .prepare("DELETE FROM routine_occurrences WHERE workspace_id = ? AND routine_id = ?")
        .bind(workspaceId, command.routineId),
      db
        .prepare("DELETE FROM routines WHERE workspace_id = ? AND id = ?")
        .bind(workspaceId, command.routineId),
    ],
    { operationId: env.operationId, status: "accepted", routineId: command.routineId },
    [routineChange(workspaceId, command.routineId)],
  );
};

// ------------------------------------------------ Approvals (docs/architecture.md §19)

const activeRunStates = "('starting', 'running', 'waiting_approval', 'stopping')";

/** Why an approval cannot be resolved now, or null when it can (AT-35). */
const explainApproval = async (db: D1Database, workspaceId: string, approvalId: string) => {
  const row = await db
    .prepare(
      `SELECT a.state, a.expires_at,
              (r.state IN ${activeRunStates} AND r.execution_generation = a.execution_generation) AS current
         FROM approvals a JOIN runs r ON r.workspace_id = a.workspace_id AND r.id = a.run_id
        WHERE a.workspace_id = ? AND a.id = ?`,
    )
    .bind(workspaceId, approvalId)
    .first<{ state: string; expires_at: string; current: number }>();
  if (!row) return new HttpError("NOT_FOUND", "approval not found");
  if (row.state !== "pending") {
    return new HttpError(
      "REVISION_CONFLICT",
      `approval is ${row.state}`,
      false,
      `approval_${row.state}`,
    );
  }
  if (!row.current) {
    return new HttpError(
      "STALE_GENERATION",
      "the requesting run is no longer current",
      false,
      "stale_generation",
    );
  }
  if (row.expires_at <= new Date().toISOString()) {
    return new HttpError("REVISION_CONFLICT", "approval is expired", false, "approval_expired");
  }
  return null;
};

/**
 * One-use CAS pending → approved / denied, only while the requesting Run is still active at the approval's generation
 * and before `expires_at`. The Run goes back to `running` once it has no pending approval left.
 */
const approvalResolve: Handler<v.InferOutput<typeof ApprovalResolve>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const problem = await explainApproval(db, workspaceId, command.approvalId);
  if (problem) throw problem;
  const { run_id: runId, effect_id: effectId } = (await db
    .prepare(
      "SELECT run_id, (SELECT id FROM effects WHERE approval_id = approvals.id) AS effect_id FROM approvals WHERE id = ?",
    )
    .bind(command.approvalId)
    .first<{ run_id: string; effect_id: string | null }>())!;
  const now = new Date().toISOString();
  const state = command.decision === "allow" ? "approved" : "denied";
  const [setGuard, clearGuard] = guard(db);
  const scope = `workspace:${workspaceId}`;
  const run = receipt(
    db,
    user.userId,
    env,
    [
      db
        .prepare(
          `UPDATE approvals SET state = ?, resolved_at = ?, resolved_by = ?, decision_reason = ?
            WHERE workspace_id = ? AND id = ? AND state = 'pending' AND expires_at > ?
              AND EXISTS (SELECT 1 FROM runs r WHERE r.workspace_id = approvals.workspace_id AND r.id = approvals.run_id
                            AND r.execution_generation = approvals.execution_generation
                            AND r.state IN ${activeRunStates})`,
        )
        .bind(
          state,
          now,
          user.userId,
          command.reason ?? null,
          workspaceId,
          command.approvalId,
          now,
        ),
      setGuard,
      clearGuard,
      resumeRunAfterApproval(db, runId),
      // An effect approval (§19): the effect goes `approved` + `effect.perform`, or `failed`.
      ...settleEffectApproval(db, command.approvalId, state === "approved", "approval_denied"),
    ],
    { operationId: env.operationId, status: "accepted", approvalId: command.approvalId, state },
    [
      { entityKind: "approval", entityId: command.approvalId, scope },
      { entityKind: "run", entityId: runId, scope },
      ...(effectId ? [{ entityKind: "effect", entityId: effectId, scope }] : []),
    ],
  );
  return explainFailure(run, () => explainApproval(db, workspaceId, command.approvalId));
};

// ------------------------------------------------- Memory (docs/architecture.md §13.6)
// Content never changes after write: a correction supersedes (tombstones) the old memory. Every revision is copied
// to `memory_revisions`, and the batch enqueues `search.index` for each memory it touches.

type MemoryWriteCommand = v.InferOutput<typeof MemoryWrite>;

/** Immutable copy of the memory's current row. */
const snapshotMemory = (db: D1Database, memoryId: string) =>
  db
    .prepare(
      `INSERT INTO memory_revisions (memory_id, workspace_id, scope_kind, scope_id, content, source_kind, source_id,
         created_by_actor_id, revision, supersedes_id, deleted_at)
       SELECT id, workspace_id, scope_kind, scope_id, content, source_kind, source_id, created_by_actor_id, revision,
              supersedes_id, deleted_at
         FROM memories WHERE id = ?`,
    )
    .bind(memoryId);

/** Change rows: a Channel memory syncs to that Channel, every other scope to the Workspace. */
const memoryChange = (
  workspaceId: string,
  memory: { id: string; scopeKind: string; scopeId: string },
  op: "upsert" | "delete",
  revision?: number,
): Change => ({
  entityKind: "memory",
  entityId: memory.id,
  op,
  ...(revision === undefined ? {} : { revision }),
  scope: memory.scopeKind === "channel" ? `channel:${memory.scopeId}` : `workspace:${workspaceId}`,
});

/** Tombstone `memoryId` (revision CAS) with its snapshot and index row; `where` adds conditions. */
const tombstoneMemory = (
  db: D1Database,
  input: { workspaceId: string; memoryId: string; where: string },
  ...params: unknown[]
) => {
  const now = new Date().toISOString();
  const [setGuard, clearGuard] = guard(db);
  return [
    db
      .prepare(
        `UPDATE memories SET deleted_at = ?, revision = revision + 1, updated_at = ?
          WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL AND ${input.where}`,
      )
      .bind(now, now, input.workspaceId, input.memoryId, ...params),
    setGuard,
    clearGuard,
    snapshotMemory(db, input.memoryId),
    indexLater(db, input.workspaceId, "memory", input.memoryId),
  ];
};

const loadMemory = async (db: D1Database, workspaceId: string, memoryId: string) => {
  const row = await db
    .prepare(
      "SELECT scope_kind, scope_id, revision, deleted_at FROM memories WHERE workspace_id = ? AND id = ?",
    )
    .bind(workspaceId, memoryId)
    .first<{ scope_kind: string; scope_id: string; revision: number; deleted_at: string | null }>();
  if (!row) throw new HttpError("NOT_FOUND", "memory not found");
  return row;
};

/** Why a memory CAS failed: deleted, or another revision. */
const explainMemory = async (
  db: D1Database,
  workspaceId: string,
  memoryId: string,
  expectedRevision?: number,
) => {
  const row = await loadMemory(db, workspaceId, memoryId);
  if (row.deleted_at !== null) {
    return new HttpError("INVALID_INPUT", "memory is deleted", false, "deleted");
  }
  if (expectedRevision !== undefined && row.revision !== expectedRevision) {
    return new HttpError(
      "REVISION_CONFLICT",
      `memory revision is ${row.revision}; refetch and retry`,
      false,
      "stale_revision",
    );
  }
  return null;
};

/** The write itself; the caller has checked that the writer may use the scope. */
const memoryWrite = async (
  db: D1Database,
  writer: { receiptActorId: string; actorId: string; sourceKind: "user" | "bot"; sourceId: string },
  env: Envelope & { command: MemoryWriteCommand },
) => {
  const { workspaceId, command } = env;
  if (command.supersedesId) {
    const old = await loadMemory(db, workspaceId, command.supersedesId);
    if (old.scope_kind !== command.scopeKind || old.scope_id !== command.scopeId) {
      throw new HttpError("INVALID_INPUT", "supersedesId must be a memory of the same scope");
    }
  }
  const memoryId = crypto.randomUUID();
  const memory = { id: memoryId, scopeKind: command.scopeKind, scopeId: command.scopeId };
  const run = receipt(
    db,
    writer.receiptActorId,
    env,
    [
      db
        .prepare(
          `INSERT INTO memories (id, workspace_id, scope_kind, scope_id, content, source_kind, source_id,
             created_by_actor_id, revision, supersedes_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        )
        .bind(
          memoryId,
          workspaceId,
          command.scopeKind,
          command.scopeId,
          command.content,
          writer.sourceKind,
          writer.sourceId,
          writer.actorId,
          command.supersedesId ?? null,
        ),
      snapshotMemory(db, memoryId),
      indexLater(db, workspaceId, "memory", memoryId),
      ...(command.supersedesId
        ? tombstoneMemory(db, { workspaceId, memoryId: command.supersedesId, where: "1" })
        : []),
    ],
    { operationId: env.operationId, status: "accepted", memoryId, revision: 1 },
    [
      memoryChange(workspaceId, memory, "upsert", 1),
      // The superseded revision is unknown when the batch is built.
      ...(command.supersedesId
        ? [memoryChange(workspaceId, { ...memory, id: command.supersedesId }, "delete")]
        : []),
    ],
  );
  return command.supersedesId
    ? explainFailure(run, () => explainMemory(db, workspaceId, command.supersedesId!))
    : run;
};

/**
 * A user may write to the Workspace, a Channel they are a member of (or their DM: `channel` scope with the DM's id), or
 * an existing Project / Bot / Task.
 */
const userMayUseMemoryScope = async (
  db: D1Database,
  user: User,
  workspaceId: string,
  scope: { kind: string; id: string },
) => {
  if (scope.kind === "workspace") {
    if (scope.id !== workspaceId)
      throw new HttpError("INVALID_INPUT", "scopeId must be the workspace id");
    return;
  }
  const exists =
    scope.kind === "channel"
      ? await db
          .prepare(
            `SELECT 1 FROM channel_members m JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
              WHERE m.workspace_id = ?1 AND m.channel_id = ?2 AND a.user_id = ?3
             UNION ALL
             SELECT 1 FROM conversations WHERE workspace_id = ?1 AND channel_id = ?2 AND kind = 'dm' AND dm_user_id = ?3`,
          )
          .bind(workspaceId, scope.id, user.userId)
          .first()
      : await db
          .prepare(`SELECT 1 FROM ${scope.kind}s WHERE workspace_id = ? AND id = ?`)
          .bind(workspaceId, scope.id)
          .first();
  if (!exists) {
    throw scope.kind === "channel"
      ? new HttpError("FORBIDDEN", "not a member of this channel")
      : new HttpError("NOT_FOUND", `${scope.kind} not found`);
  }
};

const userMemoryWrite: Handler<MemoryWriteCommand> = async (db, user, env) => {
  const { workspaceId, command } = env;
  await userMayUseMemoryScope(db, user, workspaceId, {
    kind: command.scopeKind,
    id: command.scopeId,
  });
  const actorId = await userActorId(db, workspaceId, user.userId);
  return memoryWrite(
    db,
    { receiptActorId: user.userId, actorId, sourceKind: "user", sourceId: user.userId },
    env,
  );
};

const memoryDelete: Handler<v.InferOutput<typeof MemoryDelete>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const memory = await loadMemory(db, workspaceId, command.memoryId);
  await userMayUseMemoryScope(db, user, workspaceId, {
    kind: memory.scope_kind,
    id: memory.scope_id,
  });
  const run = receipt(
    db,
    user.userId,
    env,
    tombstoneMemory(
      db,
      { workspaceId, memoryId: command.memoryId, where: "revision = ?" },
      command.expectedRevision,
    ),
    {
      operationId: env.operationId,
      status: "accepted",
      memoryId: command.memoryId,
      revision: command.expectedRevision + 1,
    },
    [
      memoryChange(
        workspaceId,
        { id: command.memoryId, scopeKind: memory.scope_kind, scopeId: memory.scope_id },
        "delete",
        command.expectedRevision + 1,
      ),
    ],
  );
  return explainFailure(run, () =>
    explainMemory(db, workspaceId, command.memoryId, command.expectedRevision),
  );
};

const loadEffectState = async (db: D1Database, workspaceId: string, effectId: string) => {
  const row = await db
    .prepare("SELECT state, attempts FROM effects WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, effectId)
    .first<{ state: string; attempts: number }>();
  if (!row) throw new HttpError("NOT_FOUND", "effect not found");
  return row;
};

/**
 * Manual recovery (§19 "if unreconcilable, manual recovery"): `mark_succeeded` / `mark_failed` an `unknown` effect;
 * `retry` an `unknown` or `failed` one that was performed before, which re-sends it: the human owns the duplicate risk.
 */
const effectResolve: Handler<v.InferOutput<typeof EffectResolve>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const effect = await loadEffectState(db, workspaceId, command.effectId);
  const allowed =
    command.action === "retry"
      ? (effect.state === "unknown" || effect.state === "failed") && effect.attempts > 0
      : effect.state === "unknown";
  const conflict = () =>
    new HttpError(
      "REVISION_CONFLICT",
      `cannot ${command.action} an effect that is ${effect.state}${effect.attempts === 0 ? " and was never performed" : ""}`,
      false,
      `effect_${effect.state}`,
    );
  if (!allowed) throw conflict();
  const now = new Date().toISOString();
  const update =
    command.action === "retry"
      ? db
          .prepare(
            `UPDATE effects SET state = 'approved', last_error = NULL, updated_at = ?
              WHERE workspace_id = ? AND id = ? AND state = ? AND attempts = ?`,
          )
          .bind(now, workspaceId, command.effectId, effect.state, effect.attempts)
      : db
          .prepare(
            `UPDATE effects SET state = ?, external_id = ?, external_url = ?, last_error = ?, updated_at = ?
              WHERE workspace_id = ? AND id = ? AND state = 'unknown' AND attempts = ?`,
          )
          .bind(
            command.action === "mark_succeeded" ? "succeeded" : "failed",
            command.externalId ?? null,
            command.externalUrl ?? null,
            command.action === "mark_failed" ? "marked failed by a user" : null,
            now,
            workspaceId,
            command.effectId,
            effect.attempts,
          );
  const [setGuard, clearGuard] = guard(db);
  const resolved = receipt(
    db,
    user.userId,
    env,
    [
      update,
      setGuard,
      clearGuard,
      ...(command.action === "retry" ? [queuePerform(db, command.effectId)] : []),
    ],
    {
      operationId: env.operationId,
      status: "accepted",
      effectId: command.effectId,
      action: command.action,
    },
    [{ entityKind: "effect", entityId: command.effectId, scope: `workspace:${workspaceId}` }],
  );
  return explainFailure(resolved, async () => conflict());
};

/**
 * Replaces the caller's sidebar document (UI-04). Revision CAS: 0 inserts (a row already there fails on the primary
 * key), otherwise a 0-row conditional UPDATE trips the guard; either way a stale revision is 409.
 */
const sidebarUpdate: Handler<v.InferOutput<typeof SidebarUpdate>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const prefs = JSON.stringify(command.prefs);
  const now = new Date().toISOString();
  const [setGuard, clearGuard] = guard(db);
  const statements =
    command.expectedRevision === 0
      ? [
          db
            .prepare(
              "INSERT INTO sidebar_prefs (workspace_id, user_id, prefs, revision, updated_at) VALUES (?, ?, ?, 1, ?)",
            )
            .bind(workspaceId, user.userId, prefs, now),
        ]
      : [
          db
            .prepare(
              `UPDATE sidebar_prefs SET prefs = ?, revision = revision + 1, updated_at = ?
                WHERE workspace_id = ? AND user_id = ? AND revision = ?`,
            )
            .bind(prefs, now, workspaceId, user.userId, command.expectedRevision),
          setGuard,
          clearGuard,
        ];
  const revision = command.expectedRevision + 1;
  const run = receipt(
    db,
    user.userId,
    env,
    statements,
    { operationId: env.operationId, status: "accepted", revision },
    [{ entityKind: "sidebar", entityId: user.userId, scope: `workspace:${workspaceId}` }],
  );
  return explainFailure(run, async () => {
    const row = await db
      .prepare("SELECT revision FROM sidebar_prefs WHERE workspace_id = ? AND user_id = ?")
      .bind(workspaceId, user.userId)
      .first<{ revision: number }>();
    const current = row?.revision ?? 0;
    return current === command.expectedRevision
      ? null
      : new HttpError(
          "REVISION_CONFLICT",
          `sidebar revision is ${current}; refetch and retry`,
          false,
          "stale_revision",
        );
  });
};

const handlers: { [T in Command["type"]]: Handler<Extract<Command, { type: T }>> } = {
  "workspace.create": workspaceCreate,
  "device.register": deviceRegister,
  "device.revoke": deviceRevoke,
  "channel.create": channelCreate,
  "channel.update": channelUpdate,
  "channel.join": channelMembership(true),
  "channel.leave": channelMembership(false),
  "dm.open": dmOpen,
  "bot.create": botCreate,
  "bot.update": botUpdate,
  "device.environment.register": deviceEnvironmentRegister,
  "agent.send": agentSend,
  "message.post": messagePost,
  "event.emit": eventEmit,
  "project.create": projectCreate,
  "task.create": (db, user, env) => taskCreate(db, user.userId, env),
  "task.assign": (db, user, env) => taskAssign(db, user.userId, env),
  "task.plan": (db, user, env) => taskPlan(db, user.userId, env),
  "task.complete": (db, user, env) => taskComplete(db, user.userId, env),
  "task.cancel": taskCancel,
  "task.delegate": (db, user, env) => taskDelegate(db, { kind: "user", userId: user.userId }, env),
  "task.delegate.revoke": taskDelegateRevoke,
  "job.start": jobStart,
  "subscription.create": subscriptionCreate,
  "subscription.update": subscriptionUpdate,
  "subscription.pause": subscriptionPause,
  "subscription.delete": subscriptionDelete,
  "subscription.test": subscriptionTest,
  "integration.create": integrationCreate,
  "job.cancel": jobCancel,
  "job.resolve": jobResolve,
  "routine.create": routineCreate,
  "routine.update": routineUpdate,
  "routine.pause": routinePause,
  "routine.resume": routineResume,
  "routine.run": routineRun,
  "routine.rotate_secret": routineRotateSecret,
  "routine.delete": routineDelete,
  "approval.resolve": approvalResolve,
  "memory.write": userMemoryWrite,
  "memory.delete": memoryDelete,
  "effect.resolve": effectResolve,
  "sidebar.update": sidebarUpdate,
};

export const runCommand = (db: D1Database, principal: Principal, envelope: Envelope) => {
  if (principal.kind !== "user") throw new HttpError("FORBIDDEN", "user principal required");
  const { type } = envelope.command;
  if (type !== "workspace.create" && !principal.workspaceIds.includes(envelope.workspaceId)) {
    throw new HttpError("FORBIDDEN", "not a member of this workspace");
  }
  return (handlers[type] as Handler<Command>)(db, principal, envelope);
};

// ---------------------------------------- Run commands (docs/architecture.md §8, §18.2)
// `POST /v1/run/commands` with a Run capability. The sender is the Run's Bot; the receipt is keyed by the Run.

export const RunEnvelope = commandEnvelope(RunCommand);
type RunEnvelopeValue = v.InferOutput<typeof RunEnvelope>;
type Run = Extract<Principal, { kind: "run" }>;
type RunHandler<T extends RunEnvelopeValue["command"]> = (
  db: D1Database,
  run: Run,
  envelope: RunEnvelopeValue & { command: T },
) => Promise<{ status: number; response: unknown; scopes?: string[] }>;

/** docs/roadmap.md §1: max 4 hops / 20 correlated Jobs per bot-to-bot chain. Bots cannot raise them. */
export const maxHops = 4;
export const maxCorrelatedJobs = 20;

const requireScope = (run: Run, scope: string) => {
  if (!run.scopes.includes(scope)) throw new HttpError("FORBIDDEN", `capability lacks ${scope}`);
};

/** The private conversation of two Bots and its member-less backing Channel share this id (schema.ts). */
const botPairId = (a: string, b: string) => `botpair:${[a, b].toSorted().join(":")}`;

const chainLimit = (message: string, reason: string) =>
  new HttpError("INVALID_INPUT", message, false, reason);

/** At most `maxCorrelatedJobs` Jobs per chain (§8.2), for a Run that is about to add one. */
const checkChainBudget = async (db: D1Database, run: Run) => {
  // ponytail: checked before the batch, so concurrent requests of one chain can overshoot by a few Jobs.
  const related = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE workspace_id = ? AND (correlation_id = ? OR id = ?)",
    )
    .bind(run.workspaceId, run.correlationId, run.correlationId)
    .first<{ n: number }>();
  if ((related?.n ?? 0) >= maxCorrelatedJobs) {
    throw chainLimit(`bot-to-bot chain exceeds ${maxCorrelatedJobs} jobs`, "budget_exceeded");
  }
};

/** The bot pair's member-less Channel and its conversation, created by the first message. */
const botPair = (db: D1Database, workspaceId: string, conversationId: string) => [
  db
    .prepare(
      "INSERT INTO channels (id, workspace_id, name) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    )
    .bind(conversationId, workspaceId, conversationId),
  db
    .prepare(
      `INSERT INTO conversations (id, workspace_id, channel_id, kind) VALUES (?, ?, ?, 'bot_pair')
       ON CONFLICT DO NOTHING`,
    )
    .bind(conversationId, workspaceId, conversationId),
];

/**
 * Bot → Bot (§8): Message in the pair's conversation, Event, recipient Inbox item and Outbox in one batch; the pump
 * routes it like a user's agent.send (a `request` wakes the recipient with a Job carrying the chain's correlation).
 */
const runAgentSend: RunHandler<v.InferOutput<typeof RunAgentSend>> = async (db, run, env) => {
  requireScope(run, "agent.send");
  const { workspaceId, command } = env;
  const recipient = await db
    .prepare(
      `SELECT id FROM bots WHERE workspace_id = ? AND ${command.recipientBotId ? "id" : "name"} = ?`,
    )
    .bind(workspaceId, command.recipientBotId ?? command.recipientBotName)
    .first<{ id: string }>();
  if (!recipient) throw new HttpError("NOT_FOUND", "bot not found");
  if (recipient.id === run.botId) throw chainLimit("a bot cannot message itself", "self_send");
  const hop = run.hop + 1;
  if (hop > maxHops) throw chainLimit(`bot-to-bot chain exceeds ${maxHops} hops`, "hop_limit");
  const request = command.message.kind === "request";
  if (request) await checkChainBudget(db, run);
  const conversationId = botPairId(run.botId, recipient.id);
  if (command.replyToMessageId) {
    const earlier = await db
      .prepare("SELECT 1 FROM messages WHERE workspace_id = ? AND id = ? AND conversation_id = ?")
      .bind(workspaceId, command.replyToMessageId, conversationId)
      .first();
    if (!earlier) {
      throw new HttpError("INVALID_INPUT", "replyToMessageId is not in this bot conversation");
    }
  }
  const receivedAt = new Date().toISOString();
  const messageId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const inboxItemId = crypto.randomUUID();
  const delivery = request ? "wake" : "notify";
  const scope = `workspace:${workspaceId}`;
  const response: RunAgentSendAccepted = {
    operationId: env.operationId,
    status: "accepted",
    messageId,
    conversationId,
    inboxItemId,
    hop,
  };
  return receipt(
    db,
    run.runId,
    env as unknown as Envelope,
    [
      ...botPair(db, workspaceId, conversationId),
      insertMessage(db, {
        id: messageId,
        workspaceId,
        conversationId,
        actorId: run.botActorId,
        clientMessageId: env.idempotencyKey,
        body: command.message.text,
        kind: command.message.kind,
        hop,
        replyToMessageId: command.replyToMessageId,
        jobId: run.jobId,
      }),
      insertEvent(db, {
        id: eventId,
        workspaceId,
        type: "agent.message.sent",
        schemaVersion: 1,
        sourceKind: "bot",
        actorKind: "bot",
        actorId: run.botId,
        subjectKind: "message",
        subjectId: messageId,
        // `channelId: null` routes into the conversation's lane with a workspace-wide scope (pump.ts).
        data: {
          messageId,
          kind: command.message.kind,
          recipientBotId: recipient.id,
          channelId: null,
          conversationId,
          inboxItemId,
          delivery,
          hop,
        },
        correlationId: run.correlationId,
        occurredAt: receivedAt,
        receivedAt,
      }),
      insertInboxItem(db, {
        id: inboxItemId,
        workspaceId,
        inputId: eventId,
        botId: recipient.id,
        conversationId,
        lane: conversationId,
        purpose: "agent.send",
        deliveryMode: delivery,
        hop,
      }),
      enqueueOutbox(db, { workspaceId, topic: "event.route", payload: { eventId } }),
      indexLater(db, workspaceId, "message", messageId),
    ],
    response,
    [
      { entityKind: "conversation", entityId: conversationId, scope },
      { entityKind: "message", entityId: messageId, scope },
      { entityKind: "inbox_item", entityId: inboxItemId, scope },
    ],
  );
};

/**
 * The response to a request this Run's Bot received (§8.1): Message with `reply_to_message_id`, an Inbox item for the
 * requester and, when the requester's Job is waiting for it, that Job back to `queued` for a successor Run (§8.2).
 * A reply that arrives before the requester's Run ends is picked up by its `waiting` result (finishRun).
 */
const runAgentReply: RunHandler<v.InferOutput<typeof AgentReply>> = async (db, run, env) => {
  requireScope(run, "agent.reply");
  const { workspaceId, command } = env;
  const request = await db
    .prepare(
      `SELECT m.id, m.conversation_id, m.job_id, j.bot_id FROM messages m
         JOIN jobs j ON j.workspace_id = m.workspace_id AND j.id = m.job_id
        WHERE m.workspace_id = ? AND m.id = ? AND m.kind = 'request'
          AND EXISTS (SELECT 1 FROM inbox_items i JOIN events e ON e.workspace_id = i.workspace_id AND e.id = i.input_id
                       WHERE i.workspace_id = m.workspace_id AND i.bot_id = ?
                         AND e.subject_kind = 'message' AND e.subject_id = m.id)`,
    )
    .bind(workspaceId, command.requestMessageId, run.botId)
    .first<{ id: string; conversation_id: string; job_id: string; bot_id: string }>();
  if (!request) throw new HttpError("NOT_FOUND", "no bot request to this bot with that id");
  const messageId = crypto.randomUUID();
  const inboxItemId = crypto.randomUUID();
  const now = new Date().toISOString();
  const scope = `workspace:${workspaceId}`;
  const response: AgentReplyAccepted = {
    operationId: env.operationId,
    status: "accepted",
    messageId,
    inboxItemId,
  };
  return receipt(
    db,
    run.runId,
    env as unknown as Envelope,
    [
      insertMessage(db, {
        id: messageId,
        workspaceId,
        conversationId: request.conversation_id,
        actorId: run.botActorId,
        clientMessageId: env.idempotencyKey,
        body: command.text,
        kind: "response",
        hop: run.hop,
        replyToMessageId: request.id,
        jobId: run.jobId,
      }),
      insertInboxItem(db, {
        id: inboxItemId,
        workspaceId,
        inputId: messageId,
        botId: request.bot_id,
        conversationId: request.conversation_id,
        lane: request.conversation_id,
        purpose: "agent.reply",
        deliveryMode: "wake",
        hop: run.hop,
      }),
      indexLater(db, workspaceId, "message", messageId),
      // Not guarded: the requester may still be running (then its `waiting` result sees this reply).
      db
        .prepare(
          `UPDATE jobs SET state = 'queued', revision = revision + 1, updated_at = ?
            WHERE workspace_id = ? AND id = ? AND state = 'waiting_input' AND waiting_for_message_id = ?`,
        )
        .bind(now, workspaceId, request.job_id, request.id),
    ],
    response,
    [
      { entityKind: "message", entityId: messageId, scope },
      { entityKind: "inbox_item", entityId: inboxItemId, scope },
      { entityKind: "job", entityId: request.job_id, scope },
    ],
  );
};

/** docs/roadmap.md §1: approval timeout 10 min; a timeout means deny. */
export const approvalTimeoutSeconds = 10 * 60;

/**
 * A pending approval for this Run's generation; the Run goes `waiting_approval` (fenced, lease kept). Each call is a
 * new approval: one is never reused for another tool call (§9.3).
 */
const runApprovalRequest: RunHandler<v.InferOutput<typeof ApprovalRequest>> = async (
  db,
  run,
  env,
) => {
  const { workspaceId, command } = env;
  const approval = pendingApproval(db, run, command);
  const pending = receipt(
    db,
    run.runId,
    env as unknown as Envelope,
    approval.statements,
    {
      operationId: env.operationId,
      status: "accepted",
      approvalId: approval.approvalId,
      expiresAt: approval.expiresAt,
    },
    approval.changes,
  );
  return explainFailure(pending, () => explainRunNotRunning(db, workspaceId, run));
};

/**
 * The approval row and the Run's move to `waiting_approval` (fenced on its generation): one batch with the caller's
 * statements.
 */
const pendingApproval = (
  db: D1Database,
  run: Run,
  input: { actionKind: string; argsHash: string; argsSummary: string; cwdLabel: string },
) => {
  const approvalId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + approvalTimeoutSeconds * 1000).toISOString();
  const scope = `workspace:${run.workspaceId}`;
  const [setGuard, clearGuard] = guard(db);
  return {
    approvalId,
    expiresAt,
    statements: [
      db
        .prepare(
          `INSERT INTO approvals (id, workspace_id, run_id, execution_generation, job_id, bot_id, action_kind, args_hash,
             args_summary, cwd_label, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          approvalId,
          run.workspaceId,
          run.runId,
          run.executionGeneration,
          run.jobId,
          run.botId,
          input.actionKind,
          input.argsHash,
          input.argsSummary,
          input.cwdLabel,
          expiresAt,
        ),
      db
        .prepare(
          `UPDATE runs SET state = 'waiting_approval', updated_at = ?
            WHERE workspace_id = ? AND id = ? AND execution_generation = ?
              AND state IN ('starting', 'running', 'waiting_approval')`,
        )
        .bind(new Date().toISOString(), run.workspaceId, run.runId, run.executionGeneration),
      setGuard,
      clearGuard,
    ],
    changes: [
      { entityKind: "approval", entityId: approvalId, scope },
      { entityKind: "run", entityId: run.runId, scope },
    ] as Change[],
  };
};

/** Only a Run that left `starting / running / waiting_approval` explains a failed batch; anything else rethrows. */
const explainRunNotRunning = async (db: D1Database, workspaceId: string, run: Run) =>
  (await db
    .prepare(
      `SELECT 1 FROM runs WHERE workspace_id = ? AND id = ? AND execution_generation = ?
        AND state IN ('starting', 'running', 'waiting_approval')`,
    )
    .bind(workspaceId, run.runId, run.executionGeneration)
    .first())
    ? null
    : new HttpError("STALE_GENERATION", "run is not running", false, "stale_generation");

// ------------------------------------------- External effects (docs/architecture.md §19)

type EffectPrepareCommand = v.InferOutput<typeof EffectPrepare>;
const providerOf = { "slack.post": "slack", "github.comment": "github" } as const;

/** The named installation (404 outside the Workspace, 422 wrong kind / disabled) or the only enabled one. */
const effectIntegration = async (
  db: D1Database,
  workspaceId: string,
  command: EffectPrepareCommand,
) => {
  const provider = providerOf[command.kind];
  if (command.integrationId) {
    const row = await db
      .prepare(
        "SELECT kind, enabled FROM integration_installations WHERE workspace_id = ? AND id = ?",
      )
      .bind(workspaceId, command.integrationId)
      .first<{ kind: string; enabled: number }>();
    if (!row) throw new HttpError("NOT_FOUND", "integration not found");
    if (row.kind !== provider) {
      throw new HttpError(
        "INVALID_INPUT",
        `${command.kind} needs a ${provider} integration`,
        false,
        "integration_kind",
      );
    }
    if (!row.enabled)
      throw new HttpError(
        "INVALID_INPUT",
        "integration is disabled",
        false,
        "integration_disabled",
      );
    return command.integrationId;
  }
  const { results } = await db
    .prepare(
      "SELECT id FROM integration_installations WHERE workspace_id = ? AND kind = ? AND enabled = 1 LIMIT 2",
    )
    .bind(workspaceId, provider)
    .all<{ id: string }>();
  if (results.length !== 1) {
    throw new HttpError(
      "INVALID_INPUT",
      `give integrationId: the workspace has ${results.length === 0 ? "no" : "several"} ${provider} integrations`,
      false,
      "integration_ambiguous",
    );
  }
  return results[0]!.id;
};

/**
 * Records the intent (§19). Policy `deny` → 403; `ask` → `prepared` + a pending approval (the Run waits as for a tool
 * approval); `allow` → `approved` + `effect.perform`. The same normalized request from the same Run returns the
 * existing effect (UNIQUE run_id, request_digest); the random per-call idempotency key would not dedupe it.
 */
const runEffectPrepare: RunHandler<EffectPrepareCommand> = async (db, run, env) => {
  const { workspaceId, command } = env;
  const integrationId = await effectIntegration(db, workspaceId, command);
  const bot = (await db
    .prepare("SELECT tool_policy FROM bots WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, run.botId)
    .first<{ tool_policy: string }>())!;
  const mode = ((JSON.parse(bot.tool_policy) as ToolPolicy).effects ?? {})[command.kind] ?? "deny";
  if (mode === "deny") {
    throw new HttpError(
      "FORBIDDEN",
      `${command.kind} is not allowed for this bot`,
      false,
      "effect_denied",
    );
  }
  // Valibot output keys follow the schema order, so this JSON is canonical.
  const request = JSON.stringify(command.request);
  const requestDigest = await digest({
    kind: command.kind,
    integrationId,
    request: command.request,
  });
  const existing = () =>
    db
      .prepare("SELECT id, state, approval_id FROM effects WHERE run_id = ? AND request_digest = ?")
      .bind(run.runId, requestDigest)
      .first<{ id: string; state: string; approval_id: string | null }>();
  const accepted = (row: { id: string; state: string; approval_id: string | null }) => ({
    status: 200,
    response: {
      operationId: env.operationId,
      status: "accepted",
      effectId: row.id,
      state: row.state,
      approvalId: row.approval_id,
    },
  });
  const found = await existing();
  if (found) return accepted(found);

  const effectId = crypto.randomUUID();
  const approval =
    mode === "ask"
      ? pendingApproval(db, run, {
          actionKind: command.kind,
          argsHash: requestDigest,
          argsSummary: summarize(command.kind, command.request),
          cwdLabel: "cloud",
        })
      : null;
  const state = approval ? "prepared" : "approved";
  const scope = `workspace:${workspaceId}`;
  const prepared = receipt(
    db,
    run.runId,
    env as unknown as Envelope,
    [
      ...(approval?.statements ?? []),
      db
        .prepare(
          `INSERT INTO effects (id, workspace_id, run_id, execution_generation, bot_id, integration_id, kind, request,
             request_digest, operation_marker, state, approval_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          effectId,
          workspaceId,
          run.runId,
          run.executionGeneration,
          run.botId,
          integrationId,
          command.kind,
          request,
          requestDigest,
          `hive:${effectId}`,
          state,
          approval?.approvalId ?? null,
        ),
      queuePerform(db, effectId),
    ],
    {
      operationId: env.operationId,
      status: "accepted",
      effectId,
      state,
      approvalId: approval?.approvalId ?? null,
    },
    [{ entityKind: "effect", entityId: effectId, scope }, ...(approval?.changes ?? [])],
  );
  return prepared.catch(async (error: unknown) => {
    if (error instanceof IdempotencyConflict) throw error;
    // A concurrent identical prepare won the UNIQUE (run_id, request_digest).
    const raced = await existing();
    if (raced) return accepted(raced);
    throw (await explainRunNotRunning(db, workspaceId, run)) ?? error;
  });
};

/**
 * A Run writes only to its own Bot, its Task or its Conversation's Channel. Workspace (and Project) scope would carry
 * what the Run read out of its sources' ACL: that promotion goes through policy, not a Run (AT-33).
 */
const runMemoryWrite: RunHandler<MemoryWriteCommand> = async (db, run, env) => {
  requireScope(run, "memory.write");
  const { scopeKind, scopeId } = env.command;
  const own = { bot: run.botId, task: run.taskId, channel: run.channelId } as Record<
    string,
    string | null
  >;
  if (!(scopeKind in own) || own[scopeKind] === null || own[scopeKind] !== scopeId) {
    throw new HttpError(
      "FORBIDDEN",
      "a run may write memory only to its bot, task or channel; wider scopes need promotion",
      false,
      "scope_not_permitted",
    );
  }
  return memoryWrite(
    db,
    { receiptActorId: run.runId, actorId: run.botActorId, sourceKind: "bot", sourceId: run.runId },
    env as unknown as Envelope & { command: MemoryWriteCommand },
  );
};

const taskHandlers = {
  "task.create": taskCreate,
  "task.assign": taskAssign,
  "task.plan": taskPlan,
  "task.complete": taskComplete,
} as const;

/** Task writes need `task.write` and stay inside the Project of the Run's own Task (403 otherwise). */
const runTaskCommand = async (
  db: D1Database,
  run: Run,
  env: RunEnvelopeValue & { command: { type: keyof typeof taskHandlers } },
) => {
  requireScope(run, "task.write");
  // A delegated Run writes Tasks only under an active `write` Delegation (§8.1).
  if (run.delegation && (run.delegation.mode !== "write" || run.delegation.state !== "active")) {
    throw new HttpError(
      "FORBIDDEN",
      "this run's delegation does not allow task writes",
      false,
      "delegation_read_only",
    );
  }
  const { workspaceId, command } = env as unknown as Envelope & {
    command: Extract<Command, { type: keyof typeof taskHandlers }>;
  };
  let projectId: string | null = null;
  if (command.type !== "task.create") {
    projectId = (await loadTask(db, workspaceId, command.taskId)).project_id;
  } else if (command.projectKey) {
    projectId =
      (
        await db
          .prepare("SELECT id FROM projects WHERE workspace_id = ? AND key = ?")
          .bind(workspaceId, command.projectKey)
          .first<{ id: string }>()
      )?.id ?? null;
  } else if (command.parentTaskId) {
    projectId = (await loadTask(db, workspaceId, command.parentTaskId)).project_id;
  }
  if (!run.taskProjectId || projectId !== run.taskProjectId) {
    throw new HttpError("FORBIDDEN", "a run may only write tasks of its own task's project");
  }
  return (taskHandlers[command.type] as TaskHandler<Command>)(
    db,
    run.runId,
    env as unknown as Envelope,
  );
};

export const runRunCommand = (db: D1Database, run: Run, envelope: RunEnvelopeValue) => {
  if (envelope.workspaceId !== run.workspaceId) {
    throw new HttpError("FORBIDDEN", "capability is for another workspace");
  }
  const { command } = envelope;
  if (command.type === "agent.send") {
    return runAgentSend(db, run, envelope as RunEnvelopeValue & { command: typeof command });
  }
  if (command.type === "agent.reply") {
    return runAgentReply(db, run, envelope as RunEnvelopeValue & { command: typeof command });
  }
  if (command.type === "approval.request") {
    return runApprovalRequest(db, run, envelope as RunEnvelopeValue & { command: typeof command });
  }
  if (command.type === "memory.write") {
    return runMemoryWrite(db, run, envelope as RunEnvelopeValue & { command: typeof command });
  }
  if (command.type === "effect.prepare") {
    return runEffectPrepare(db, run, envelope as RunEnvelopeValue & { command: typeof command });
  }
  if (command.type === "task.delegate") {
    return taskDelegate(
      db,
      { kind: "run", run },
      envelope as unknown as Envelope & {
        command: typeof command;
      },
    );
  }
  return runTaskCommand(db, run, envelope as RunEnvelopeValue & { command: typeof command });
};
