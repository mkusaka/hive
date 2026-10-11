// POST /v1/commands handlers (docs/architecture.md §22.3). Each runs inside `withOperationReceipt`.
import {
  AgentSend,
  type AgentSendAccepted,
  BotCreate,
  ChannelCreate,
  commandEnvelope,
  DeviceRegister,
  DeviceRevoke,
  EventEmit,
  type EventEmitAccepted,
  userEventType,
  WorkspaceCreate,
} from "@hive/contracts";
import {
  appendChange,
  digest,
  enqueueOutbox,
  IdempotencyConflict,
  insertEvent,
  insertInboxItem,
  insertMessage,
  withOperationReceipt,
} from "@hive/db";
import * as v from "valibot";
import { hashSecret, newDeviceSecret } from "./auth/device.ts";
import type { Principal } from "./auth/principal.ts";
import { HttpError } from "./errors.ts";

export const CommandEnvelope = commandEnvelope(
  v.variant("type", [
    WorkspaceCreate,
    DeviceRegister,
    DeviceRevoke,
    ChannelCreate,
    BotCreate,
    AgentSend,
    EventEmit,
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

type Change = Omit<Parameters<typeof appendChange>[1], "workspaceId">;

/** Runs the batch with one change row per `changes` entry; returns the touched scopes unless replayed. */
const receipt = async <T>(
  db: D1Database,
  user: User,
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
      actorId: user.userId,
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
  return receipt(
    db,
    user,
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
};

const deviceRegister: Handler<v.InferOutput<typeof DeviceRegister>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const deviceId = crypto.randomUUID();
  const secret = newDeviceSecret();
  const result = await receipt(
    db,
    user,
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
    user,
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

/** Maps a batch failure caused by UNIQUE (workspace_id, name) to 422. A replay never reaches the batch. */
const uniqueName = <T>(
  db: D1Database,
  table: "channels" | "bots",
  workspaceId: string,
  name: string,
  run: Promise<T>,
) =>
  run.catch(async (error: unknown) => {
    if (error instanceof IdempotencyConflict) throw error;
    const taken = await db
      .prepare(`SELECT 1 FROM ${table} WHERE workspace_id = ? AND name = ?`)
      .bind(workspaceId, name)
      .first();
    if (taken) throw new HttpError("INVALID_INPUT", `name already exists: ${name}`);
    throw error;
  });

const channelCreate: Handler<v.InferOutput<typeof ChannelCreate>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const actorId = await userActorId(db, workspaceId, user.userId);
  const channelId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  const run = receipt(
    db,
    user,
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

const botCreate: Handler<v.InferOutput<typeof BotCreate>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const actorId = crypto.randomUUID();
  const botId = crypto.randomUUID();
  const run = receipt(
    db,
    user,
    env,
    [
      db
        .prepare(
          "INSERT INTO actors (id, workspace_id, kind, display_name) VALUES (?, ?, 'bot', ?)",
        )
        .bind(actorId, workspaceId, command.name),
      db
        .prepare(
          "INSERT INTO bots (id, workspace_id, actor_id, name, placement_policy) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(botId, workspaceId, actorId, command.name, JSON.stringify(command.placementPolicy)),
    ],
    { operationId: env.operationId, status: "accepted", botId },
    [{ entityKind: "bot", entityId: botId, revision: 1, scope: `workspace:${workspaceId}` }],
  );
  return uniqueName(db, "bots", workspaceId, command.name, run);
};

/** §11.1: Message, Inbox item, Event, Change Log, Outbox and Receipt in one batch. Routing creates the Job later. */
const agentSend: Handler<v.InferOutput<typeof AgentSend>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const member = await db
    .prepare(
      `SELECT c.id AS conversation_id, a.id AS actor_id
         FROM conversations c
         JOIN channel_members m ON m.workspace_id = c.workspace_id AND m.channel_id = c.channel_id
         JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
        WHERE c.workspace_id = ? AND c.channel_id = ? AND a.user_id = ?`,
    )
    .bind(workspaceId, command.channelId, user.userId)
    .first<{ conversation_id: string; actor_id: string }>();
  if (!member) throw new HttpError("FORBIDDEN", "not a member of this channel");
  const bot = await db
    .prepare("SELECT 1 FROM bots WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, command.recipientBotId)
    .first();
  if (!bot) throw new HttpError("NOT_FOUND", "bot not found");

  const receivedAt = new Date().toISOString();
  const messageId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
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
    user,
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
      insertEvent(db, {
        id: eventId,
        workspaceId,
        type: "agent.message.sent",
        schemaVersion: 1,
        sourceKind: "cli",
        actorKind: "user",
        actorId: user.userId,
        subjectKind: "message",
        subjectId: messageId,
        // Read by the event router (pump.ts); the message text stays in `messages`.
        data: {
          messageId,
          kind: command.message.kind,
          recipientBotId: command.recipientBotId,
          channelId: command.channelId,
          conversationId: member.conversation_id,
          inboxItemId,
          delivery: command.delivery,
        },
        correlationId: env.operationId,
        occurredAt: receivedAt,
        receivedAt,
      }),
      insertInboxItem(db, {
        id: inboxItemId,
        workspaceId,
        inputId: eventId,
        botId: command.recipientBotId,
        conversationId: member.conversation_id,
        lane: command.channelId,
        purpose: "agent.send",
        deliveryMode: command.delivery,
      }),
      enqueueOutbox(db, { workspaceId, topic: "event.route", payload: { eventId } }),
    ],
    response,
    [
      { entityKind: "message", entityId: messageId, scope: `channel:${command.channelId}` },
      { entityKind: "inbox_item", entityId: inboxItemId, scope: `channel:${command.channelId}` },
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
    user,
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

const handlers: { [T in Command["type"]]: Handler<Extract<Command, { type: T }>> } = {
  "workspace.create": workspaceCreate,
  "device.register": deviceRegister,
  "device.revoke": deviceRevoke,
  "channel.create": channelCreate,
  "bot.create": botCreate,
  "agent.send": agentSend,
  "event.emit": eventEmit,
};

export const runCommand = (db: D1Database, principal: Principal, envelope: Envelope) => {
  if (principal.kind !== "user") throw new HttpError("FORBIDDEN", "user principal required");
  const { type } = envelope.command;
  if (type !== "workspace.create" && !principal.workspaceIds.includes(envelope.workspaceId)) {
    throw new HttpError("FORBIDDEN", "not a member of this workspace");
  }
  return (handlers[type] as Handler<Command>)(db, principal, envelope);
};
