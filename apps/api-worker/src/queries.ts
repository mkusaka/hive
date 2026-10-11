// Read routes for a user principal, scoped to the user's Workspaces (docs/architecture.md §22.2).
import {
  type ApprovalStatus,
  defaultSidebarPrefs,
  type PlacementPolicy,
  type SidebarPrefs,
} from "@hive/contracts";
import { displayState } from "@hive/db";
import { HttpError } from "./errors.ts";
import { placementDevices } from "./executor.ts";
import { deviceReasons } from "./placement.ts";
import { conversationReadableSql, searchAccess } from "./search.ts";

const notFound = (what: string) => new HttpError("NOT_FOUND", `${what} not found`);
const placeholders = (ids: string[]) => ids.map(() => "?").join(", ");

const inboxItemColumns = `i.id, i.workspace_id AS workspaceId, i.bot_id AS botId, i.conversation_id AS conversationId,
  i.lane, i.purpose, i.delivery_mode AS delivery, i.delivery_id AS deliveryId, i.state,
  i.created_at AS createdAt, i.updated_at AS updatedAt`;

/**
 * The receipt of one of the user's own commands, plus current routing state for an agent.send (`jobId`) or a
 * message.post (`jobIds`, one per mentioned Bot, null until routed).
 */
export const getOperation = async (db: D1Database, userId: string, wsIds: string[], id: string) => {
  if (wsIds.length === 0) throw notFound("operation");
  // ponytail: receipts have no operation_id column, so this scans the user's receipts in their
  // Workspaces; add an indexed column if operation lookups get hot.
  const receipt = await db
    .prepare(
      `SELECT status, response FROM operation_receipts
        WHERE workspace_id IN (${placeholders(wsIds)}) AND actor_id = ?
          AND json_extract(response, '$.operationId') = ?`,
    )
    .bind(...wsIds, userId, id)
    .first<{ status: number; response: string }>();
  if (!receipt) throw notFound("operation");
  const response = JSON.parse(receipt.response) as {
    inboxItemId?: string;
    inboxItemIds?: string[];
  };
  const base = { operationId: id, receiptStatus: receipt.status, response };
  if (response.inboxItemIds) {
    const ids = response.inboxItemIds;
    const { results } = await db
      .prepare(
        `SELECT i.id, j.id AS jobId FROM inbox_items i
           LEFT JOIN jobs j ON j.workspace_id = i.workspace_id AND j.trigger_key = 'inbox:' || i.id
          WHERE i.id IN (${placeholders(ids)})`,
      )
      .bind(...ids)
      .all<{ id: string; jobId: string | null }>();
    const jobIds = ids.map((itemId) => results.find((r) => r.id === itemId)?.jobId ?? null);
    return { ...base, routingStatus: jobIds.includes(null) ? "pending" : "routed", jobIds };
  }
  if (!response.inboxItemId) return base;
  const item = await db
    .prepare(
      `SELECT ${inboxItemColumns}, j.id AS jobId FROM inbox_items i
         LEFT JOIN jobs j ON j.workspace_id = i.workspace_id AND j.trigger_key = 'inbox:' || i.id
        WHERE i.id = ?`,
    )
    .bind(response.inboxItemId)
    .first<{ deliveryId: string | null; jobId: string | null }>();
  if (!item) return base;
  const { jobId, ...inboxItem } = item;
  return { ...base, routingStatus: item.deliveryId ? "routed" : "pending", inboxItem, jobId };
};

/**
 * Why a queued / `waiting_device` Job has no device that can take it now (AT-22): every device with the reasons it
 * cannot (placement.ts). Null while some device can, and for any other state.
 */
const waitingReason = async (
  db: D1Database,
  job: { workspaceId: string; state: string },
  placement: PlacementPolicy,
) => {
  if (job.state !== "queued" && job.state !== "waiting_device") return null;
  const now = Date.now();
  const devices = (await placementDevices(db, job.workspaceId)).map((d) => ({
    deviceId: d.id,
    reasons: deviceReasons(placement, d, now),
  }));
  return devices.every((d) => d.reasons.length > 0)
    ? { code: "no_eligible_device" as const, devices }
    : null;
};

/** The Job with its root Runs (oldest first): recovery needs every attempt's state and device (§22.2). */
export const getJob = async (db: D1Database, wsIds: string[], id: string) => {
  if (wsIds.length === 0) throw notFound("job");
  const job = await db
    .prepare(
      `SELECT id, workspace_id AS workspaceId, bot_id AS botId, job_kind AS jobKind, conversation_id AS conversationId, task_id AS taskId, state, revision,
              trigger_key AS triggerKey, placement, cancel_requested_at AS cancelRequestedAt,
              created_at AS createdAt, updated_at AS updatedAt
         FROM jobs WHERE id = ? AND workspace_id IN (${placeholders(wsIds)})`,
    )
    .bind(id, ...wsIds)
    .first<{ placement: string; workspaceId: string; state: string }>();
  if (!job) throw notFound("job");
  const placement = JSON.parse(job.placement) as PlacementPolicy;
  const { results: runs } = await db
    .prepare(
      `SELECT id, state, execution_generation AS generation, lease_expires_at AS leaseExpiresAt,
              device_id AS deviceId, started_at AS startedAt, result_error AS error
         FROM runs WHERE workspace_id = ? AND job_id = ? AND kind = 'root' ORDER BY execution_generation`,
    )
    .bind(job.workspaceId, id)
    .all();
  return { ...job, placement, runs, waitingReason: await waitingReason(db, job, placement) };
};

// ponytail: first 100 items, no cursor yet; add `limit / cursor` (§22.2) with the CLI.
export const listInbox = async (db: D1Database, wsIds: string[], botId: string) => {
  if (wsIds.length === 0) throw notFound("bot");
  const { results } = await db
    .prepare(
      `SELECT ${inboxItemColumns} FROM inbox_items i
        WHERE i.bot_id = ? AND i.workspace_id IN (${placeholders(wsIds)})
        ORDER BY i.created_at, i.id LIMIT 100`,
    )
    .bind(botId, ...wsIds)
    .all();
  return { items: results };
};

// ---------------------------------------------- Bootstrap lists (§12.3)
// The caller already checked Workspace membership. Bounded; no pagination yet.

/** Member channels by name, each with its main conversation's latest message (`lastMessage`, null when empty). */
export const listChannels = async (db: D1Database, workspaceId: string, userId: string) => {
  const { results } = await db
    .prepare(
      `SELECT ch.id, ch.name, ch.topic, c.id AS conversationId, m.role, ch.created_at AS createdAt,
              (SELECT COUNT(*) FROM channel_members cm
                WHERE cm.workspace_id = ch.workspace_id AND cm.channel_id = ch.id) AS memberCount,
              (SELECT json_object('body', lm.body, 'createdAt', lm.created_at, 'actorId', lm.actor_id)
                 FROM messages lm WHERE lm.workspace_id = c.workspace_id AND lm.conversation_id = c.id
                ORDER BY lm.seq DESC LIMIT 1) AS lastMessage
         FROM channels ch
         JOIN channel_members m ON m.workspace_id = ch.workspace_id AND m.channel_id = ch.id
         JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
         LEFT JOIN conversations c ON c.workspace_id = ch.workspace_id AND c.channel_id = ch.id AND c.kind = 'channel'
        WHERE ch.workspace_id = ? AND a.user_id = ?
        ORDER BY ch.name LIMIT 500`,
    )
    .bind(workspaceId, userId)
    .all<{ lastMessage: string | null }>();
  for (const ch of results) ch.lastMessage = ch.lastMessage && JSON.parse(ch.lastMessage);
  return { channels: results };
};

/** The caller's sidebar document (UI-04), the default at revision 0 when none, and the Workspace's name. */
export const getSidebar = async (db: D1Database, workspaceId: string, userId: string) => {
  const row = await db
    .prepare(
      `SELECT w.name AS workspaceName, s.prefs, s.revision FROM workspaces w
         LEFT JOIN sidebar_prefs s ON s.workspace_id = w.id AND s.user_id = ?
        WHERE w.id = ?`,
    )
    .bind(userId, workspaceId)
    .first<{ workspaceName: string; prefs: string | null; revision: number | null }>();
  if (!row) throw notFound("workspace");
  return {
    workspaceName: row.workspaceName,
    prefs: row.prefs ? (JSON.parse(row.prefs) as SidebarPrefs) : defaultSidebarPrefs,
    revision: row.revision ?? 0,
  };
};

/** The Channel's members (role `owner` / `member`); Bots carry `botId` and their current name. Callers must be members. */
export const listChannelMembers = async (
  db: D1Database,
  input: { workspaceId: string; userId: string; channelId: string },
) => {
  const member = await db
    .prepare(
      `SELECT 1 FROM channel_members m
         JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
        WHERE m.workspace_id = ? AND m.channel_id = ? AND a.user_id = ?`,
    )
    .bind(input.workspaceId, input.channelId, input.userId)
    .first();
  if (!member) throw notFound("channel");
  const { results } = await db
    .prepare(
      `SELECT a.id AS actorId, a.kind, COALESCE(b.name, a.display_name) AS name, a.user_id AS userId,
              b.id AS botId, m.role
         FROM channel_members m
         JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
         LEFT JOIN bots b ON b.workspace_id = a.workspace_id AND b.actor_id = a.id
        WHERE m.workspace_id = ? AND m.channel_id = ?
        ORDER BY a.kind DESC, name LIMIT 500`,
    )
    .bind(input.workspaceId, input.channelId)
    .all();
  return { members: results };
};

/** The caller's DMs by Bot name: `id` = `conversationId`, the Bot (`botId`, `name`) and `lastMessage` like a channel. */
export const listDms = async (db: D1Database, workspaceId: string, userId: string) => {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.id AS conversationId, b.id AS botId, b.name, c.created_at AS createdAt,
              (SELECT json_object('body', lm.body, 'createdAt', lm.created_at, 'actorId', lm.actor_id)
                 FROM messages lm WHERE lm.workspace_id = c.workspace_id AND lm.conversation_id = c.id
                ORDER BY lm.seq DESC LIMIT 1) AS lastMessage
         FROM conversations c JOIN bots b ON b.workspace_id = c.workspace_id AND b.id = c.dm_bot_id
        WHERE c.workspace_id = ? AND c.kind = 'dm' AND c.dm_user_id = ?
        ORDER BY b.name LIMIT 500`,
    )
    .bind(workspaceId, userId)
    .all<{ lastMessage: string | null }>();
  for (const dm of results) dm.lastMessage = dm.lastMessage && JSON.parse(dm.lastMessage);
  return { dms: results };
};

export const listBots = async (db: D1Database, workspaceId: string) => {
  const { results } = await db
    .prepare(
      `SELECT id, actor_id AS actorId, name, instructions, placement_policy AS placementPolicy, tool_policy AS toolPolicy,
              config_revision AS revision, created_at AS createdAt, updated_at AS updatedAt
         FROM bots WHERE workspace_id = ? ORDER BY name LIMIT 500`,
    )
    .bind(workspaceId)
    .all<{ placementPolicy: unknown; toolPolicy: unknown }>();
  for (const bot of results) {
    bot.placementPolicy = JSON.parse(bot.placementPolicy as string);
    bot.toolPolicy = JSON.parse(bot.toolPolicy as string);
  }
  return { bots: results };
};

/** `bot_pair` conversations (§8.1) with both Bots and their last 20 messages, oldest first (max 100). */
export const listBotConversations = async (db: D1Database, workspaceId: string) => {
  const { results } = await db
    .prepare(
      `SELECT id, created_at AS createdAt FROM conversations
        WHERE workspace_id = ? AND kind = 'bot_pair' ORDER BY created_at DESC, id LIMIT 100`,
    )
    .bind(workspaceId)
    .all<{ id: string; createdAt: string }>();
  const conversations = await Promise.all(
    results.map(async (c) => {
      const [bots, messages] = await Promise.all([
        db
          .prepare(
            `SELECT id, name FROM bots WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))
              ORDER BY name`,
          )
          .bind(workspaceId, JSON.stringify(c.id.split(":").slice(1)))
          .all(),
        db
          .prepare(
            `SELECT * FROM (
               SELECT m.id, m.seq, b.name AS bot, m.kind, m.hop, m.reply_to_message_id AS replyToMessageId,
                      m.body, m.created_at AS createdAt
                 FROM messages m LEFT JOIN bots b ON b.workspace_id = m.workspace_id AND b.actor_id = m.actor_id
                WHERE m.workspace_id = ? AND m.conversation_id = ? ORDER BY m.seq DESC LIMIT 20
             ) ORDER BY seq`,
          )
          .bind(workspaceId, c.id)
          .all(),
      ]);
      return Object.assign(c, { bots: bots.results, messages: messages.results });
    }),
  );
  return { conversations };
};

export const listDevices = async (db: D1Database, workspaceId: string) => {
  const { results } = await db
    .prepare(
      `SELECT id, name, os, agent_version AS agentVersion, owner_user_id AS ownerUserId, capabilities,
              capacity_background AS capacityBackground, last_heartbeat_at AS lastHeartbeatAt,
              revoked_at AS revokedAt, created_at AS createdAt
         FROM devices WHERE workspace_id = ? ORDER BY created_at, id LIMIT 500`,
    )
    .bind(workspaceId)
    .all<{ capabilities: unknown }>();
  for (const d of results) d.capabilities = JSON.parse(d.capabilities as string);
  return { devices: results };
};

const jobStates = [
  "queued",
  "waiting_device",
  "waiting_input",
  "active",
  "recovery_required",
  "succeeded",
  "failed",
  "cancelled",
];

/** Newest first, optionally one `state`. */
export const listJobs = async (
  db: D1Database,
  workspaceId: string,
  limit: number,
  state?: string,
) => {
  if (state !== undefined && !jobStates.includes(state)) {
    throw new HttpError("INVALID_INPUT", `state must be one of ${jobStates.join(", ")}`);
  }
  const { results } = await db
    .prepare(
      `SELECT id, bot_id AS botId, job_kind AS jobKind, conversation_id AS conversationId, task_id AS taskId, state, revision, trigger_key AS triggerKey,
              cancel_requested_at AS cancelRequestedAt, created_at AS createdAt, updated_at AS updatedAt
         FROM jobs WHERE workspace_id = ? AND (? IS NULL OR state = ?)
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .bind(workspaceId, state ?? null, state ?? null, limit)
    .all();
  return { jobs: results };
};

/** SQL: user `?uid` may read conversation `c`: a member of its Channel, or the user of its DM (a thread: its parent's). */
const mayRead = (uid: string) => `EXISTS (
  SELECT 1 FROM conversations p WHERE p.workspace_id = c.workspace_id AND p.id = COALESCE(c.parent_conversation_id, c.id)
     AND ((p.kind = 'dm' AND p.dm_user_id = ${uid})
          OR (p.kind = 'channel' AND EXISTS (SELECT 1 FROM channel_members cm
                JOIN actors ca ON ca.workspace_id = cm.workspace_id AND ca.id = cm.actor_id
               WHERE cm.workspace_id = p.workspace_id AND cm.channel_id = p.channel_id AND ca.user_id = ${uid}))))`;

/** Per thread of the conversation `?parent`: its id, reply count, last reply and up to 5 participants (actor ids). */
const threadSummaries = (parent: string) => `SELECT t.root_message_id, t.id AS conversationId,
    COUNT(r.id) AS replyCount, MAX(r.created_at) AS lastReplyAt,
    (SELECT json_group_array(actor_id) FROM (SELECT DISTINCT actor_id FROM messages
       WHERE workspace_id = t.workspace_id AND conversation_id = t.id LIMIT 5)) AS participants
  FROM conversations t JOIN messages r ON r.workspace_id = t.workspace_id AND r.conversation_id = t.id
 WHERE t.workspace_id = ?1 AND t.parent_conversation_id = ${parent} AND t.kind = 'thread'
 GROUP BY t.id`;

const messageColumns = `m.id, m.conversation_id AS conversationId, m.seq, m.actor_id AS actorId, a.user_id AS userId,
  m.body, m.created_at AS createdAt`;

type Thread = {
  conversationId: string;
  replyCount: number;
  lastReplyAt: string;
  participants: string[];
};

/**
 * Newest first, from a channel's main conversation (`channelId`, members only), a DM (`conversationId`, its user only)
 * or a thread (`conversationId`, whoever may read its parent); 404 otherwise. Each message carries its `thread`
 * summary (null without replies); a thread's response also has its `root` message.
 */
export const listMessages = async (
  db: D1Database,
  input: { workspaceId: string; userId: string; limit: number } & (
    | { channelId: string }
    | { conversationId: string }
  ),
) => {
  const conversation = await (
    "channelId" in input
      ? db
          .prepare(
            `SELECT c.id, c.root_message_id FROM conversations c
             JOIN channel_members m ON m.workspace_id = c.workspace_id AND m.channel_id = c.channel_id
             JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
            WHERE c.workspace_id = ? AND c.channel_id = ? AND c.kind = 'channel' AND a.user_id = ?`,
          )
          .bind(input.workspaceId, input.channelId, input.userId)
      : db
          .prepare(
            `SELECT c.id, c.root_message_id FROM conversations c
              WHERE c.workspace_id = ?1 AND c.id = ?2 AND c.kind IN ('dm', 'thread') AND ${mayRead("?3")}`,
          )
          .bind(input.workspaceId, input.conversationId, input.userId)
  ).first<{ id: string; root_message_id: string | null }>();
  if (!conversation) throw notFound("channelId" in input ? "channel" : "conversation");
  const { results } = await db
    .prepare(
      `SELECT ${messageColumns},
              CASE WHEN th.conversationId IS NULL THEN NULL ELSE json_object('conversationId', th.conversationId,
                'replyCount', th.replyCount, 'lastReplyAt', th.lastReplyAt, 'participants', json(th.participants))
              END AS thread
         FROM messages m
         LEFT JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
         LEFT JOIN (${threadSummaries("?2")}) th ON th.root_message_id = m.id
        WHERE m.workspace_id = ?1 AND m.conversation_id = ?2
        ORDER BY m.seq DESC LIMIT ?3`,
    )
    .bind(input.workspaceId, conversation.id, input.limit)
    .all<{ thread: string | Thread | null }>();
  for (const m of results) m.thread = m.thread && (JSON.parse(m.thread as string) as Thread);
  if (!conversation.root_message_id) return { messages: results };
  const root = await db
    .prepare(
      `SELECT ${messageColumns} FROM messages m
         LEFT JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
        WHERE m.workspace_id = ? AND m.id = ?`,
    )
    .bind(input.workspaceId, conversation.root_message_id)
    .first();
  return { messages: results, root };
};

/**
 * `GET /v1/threads?participant=me`: threads the user replied in or started (authored the root) and may still read,
 * newest reply first (max 50), each with its root message, parent and reply summary.
 */
export const listThreads = async (db: D1Database, workspaceId: string, userId: string) => {
  const { results } = await db
    .prepare(
      `SELECT c.id AS conversationId, c.channel_id AS channelId, c.parent_conversation_id AS parentConversationId,
              p.kind AS parentKind, ch.name AS channelName,
              json_object('id', rm.id, 'actorId', rm.actor_id, 'body', rm.body, 'createdAt', rm.created_at) AS root,
              (SELECT COUNT(*) FROM messages r WHERE r.workspace_id = c.workspace_id AND r.conversation_id = c.id)
                AS replyCount,
              (SELECT MAX(created_at) FROM messages r WHERE r.workspace_id = c.workspace_id AND r.conversation_id = c.id)
                AS lastReplyAt
         FROM conversations c
         JOIN conversations p ON p.workspace_id = c.workspace_id AND p.id = c.parent_conversation_id
         JOIN channels ch ON ch.workspace_id = c.workspace_id AND ch.id = c.channel_id
         JOIN messages rm ON rm.workspace_id = c.workspace_id AND rm.id = c.root_message_id
         JOIN actors me ON me.workspace_id = c.workspace_id AND me.user_id = ?2
        WHERE c.workspace_id = ?1 AND c.kind = 'thread' AND ${mayRead("?2")}
          AND (rm.actor_id = me.id OR EXISTS (SELECT 1 FROM messages r WHERE r.workspace_id = c.workspace_id
                                                AND r.conversation_id = c.id AND r.actor_id = me.id))
        ORDER BY lastReplyAt DESC, c.id LIMIT 50`,
    )
    .bind(workspaceId, userId)
    .all<{ root: string | Record<string, unknown> }>();
  for (const t of results) t.root = JSON.parse(t.root as string) as Record<string, unknown>;
  return { threads: results };
};

// ------------------------------------------------- Projects and Tasks (§4)

export const listProjects = async (db: D1Database, workspaceId: string) => {
  const { results } = await db
    .prepare(
      `SELECT id, key, name, status, primary_channel_id AS primaryChannelId, created_at AS createdAt,
              updated_at AS updatedAt
         FROM projects WHERE workspace_id = ? ORDER BY key LIMIT 500`,
    )
    .bind(workspaceId)
    .all();
  return { projects: results };
};

const taskStatuses = ["pending", "in_progress", "completed", "cancelled"];
const taskColumns = `t.id, t.workspace_id AS workspaceId, t.project_id AS projectId, p.key AS projectKey,
  t.parent_task_id AS parentTaskId, t.key, t.title, t.description, t.status, t.assignee_kind, t.assignee_id,
  t.priority, t.revision, t.scope_revision AS scopeRevision, t.completion_policy AS completionPolicy,
  t.created_at AS createdAt, t.updated_at AS updatedAt`;
type TaskRow = {
  id: string;
  projectId: string | null;
  status: string;
  assignee_kind: string | null;
  assignee_id: string | null;
};
type Prerequisite = { dependentId: string; id: string; key: string; status: string };

/** `display` is computed (§4.1): the status, or `ready` / `blocked` while `pending`. */
const toTask = (
  { assignee_kind, assignee_id, ...task }: TaskRow,
  prerequisites: Prerequisite[],
) => {
  const prereqs = prerequisites.map(({ id, key, status }) => ({ id, key, status }));
  return {
    ...task,
    assignee: assignee_kind ? { kind: assignee_kind, id: assignee_id } : null,
    display: displayState(task, prereqs),
    prerequisites: prereqs,
  };
};

const prerequisitesOf = async (db: D1Database, workspaceId: string, dependentId?: string) =>
  (
    await db
      .prepare(
        `SELECT d.dependent_task_id AS dependentId, p.id, p.key, p.status FROM task_dependencies d
           JOIN tasks p ON p.workspace_id = d.workspace_id AND p.id = d.prerequisite_task_id
          WHERE d.workspace_id = ? ${dependentId ? "AND d.dependent_task_id = ?" : ""}
          ORDER BY p.key`,
      )
      .bind(workspaceId, ...(dependentId ? [dependentId] : []))
      .all<Prerequisite>()
  ).results;

// ponytail: bounded at 500 Tasks and reads the Workspace's whole dependency table; page with a cursor later.
export const listTasks = async (
  db: D1Database,
  workspaceId: string,
  filter: { projectKey?: string; status?: string },
) => {
  if (filter.status !== undefined && !taskStatuses.includes(filter.status)) {
    throw new HttpError("INVALID_INPUT", `status must be one of ${taskStatuses.join(", ")}`);
  }
  const { results } = await db
    .prepare(
      `SELECT ${taskColumns} FROM tasks t
         LEFT JOIN projects p ON p.workspace_id = t.workspace_id AND p.id = t.project_id
        WHERE t.workspace_id = ? AND (? IS NULL OR p.key = ?) AND (? IS NULL OR t.status = ?)
        ORDER BY t.created_at, t.id LIMIT 500`,
    )
    .bind(
      workspaceId,
      filter.projectKey ?? null,
      filter.projectKey ?? null,
      filter.status ?? null,
      filter.status ?? null,
    )
    .all<TaskRow>();
  const prerequisites = await prerequisitesOf(db, workspaceId);
  return {
    tasks: results.map((task) =>
      toTask(
        task,
        prerequisites.filter((p) => p.dependentId === task.id),
      ),
    ),
  };
};

/** One Task with its prerequisites, dependents, Results, Jobs and Delegations. */
export const getTask = async (db: D1Database, wsIds: string[], id: string) => {
  if (wsIds.length === 0) throw notFound("task");
  const task = await db
    .prepare(
      `SELECT ${taskColumns} FROM tasks t
         LEFT JOIN projects p ON p.workspace_id = t.workspace_id AND p.id = t.project_id
        WHERE t.id = ? AND t.workspace_id IN (${placeholders(wsIds)})`,
    )
    .bind(id, ...wsIds)
    .first<TaskRow & { workspaceId: string }>();
  if (!task) throw notFound("task");
  const { workspaceId } = task;
  const [prerequisites, dependents, results, jobs, git, delegations] = await Promise.all([
    prerequisitesOf(db, workspaceId, id),
    db
      .prepare(
        `SELECT t.id, t.key, t.status FROM task_dependencies d
           JOIN tasks t ON t.workspace_id = d.workspace_id AND t.id = d.dependent_task_id
          WHERE d.workspace_id = ? AND d.prerequisite_task_id = ? ORDER BY t.key`,
      )
      .bind(workspaceId, id)
      .all(),
    db
      .prepare(
        `SELECT id, execution_id AS executionId, run_id AS runId, scope_revision AS scopeRevision, state,
                summary, created_at AS createdAt
           FROM task_results WHERE workspace_id = ? AND task_id = ? ORDER BY created_at, id`,
      )
      .bind(workspaceId, id)
      .all(),
    db
      .prepare(
        `SELECT id, bot_id AS botId, state, revision, trigger_key AS triggerKey, created_at AS createdAt,
                updated_at AS updatedAt
           FROM jobs WHERE workspace_id = ? AND task_id = ? ORDER BY created_at, id`,
      )
      .bind(workspaceId, id)
      .all(),
    db
      .prepare(
        `SELECT repository, commits, prs FROM run_git
          WHERE workspace_id = ? AND run_id IN (SELECT run_id FROM executions WHERE workspace_id = ? AND task_id = ?)
          ORDER BY created_at, run_id`,
      )
      .bind(workspaceId, workspaceId, id)
      .all<{ repository: string; commits: string; prs: string }>(),
    db
      .prepare(
        `SELECT id, from_kind AS fromKind, from_id AS fromId, to_bot_id AS toBotId, mode, state, deadline,
                scope_revision AS scopeRevision, job_id AS jobId, outcome_summary AS outcomeSummary,
                created_at AS createdAt, closed_at AS closedAt
           FROM delegations WHERE workspace_id = ? AND task_id = ? ORDER BY created_at, id`,
      )
      .bind(workspaceId, id)
      .all(),
  ]);
  // GIT-01 rollup over the Task's Runs: distinct commits, PRs unique by URL, repositories.
  const shas = new Set<string>();
  const prs = new Map<string, unknown>();
  const repositories = new Set<string>();
  for (const g of git.results) {
    for (const c of JSON.parse(g.commits) as { sha: string }[]) shas.add(c.sha);
    for (const pr of JSON.parse(g.prs) as { url: string }[]) prs.set(pr.url, pr);
    if (g.repository) repositories.add(g.repository);
  }
  return {
    ...toTask(task, prerequisites),
    dependents: dependents.results,
    results: results.results,
    jobs: jobs.results,
    delegations: delegations.results,
    git: { commits: shas.size, prs: [...prs.values()], repositories: [...repositories] },
  };
};

/** Subscriptions of the Workspace with their spec JSON parsed (max 500). */
export const listSubscriptions = async (db: D1Database, workspaceId: string) => {
  const { results } = await db
    .prepare(
      `SELECT id, bot_id AS botId, integration_id AS integrationId, event_types AS eventTypes, filter, destination,
              delivery, enabled, expires_at AS expiresAt, revision, created_at AS createdAt, updated_at AS updatedAt
         FROM subscriptions WHERE workspace_id = ? ORDER BY created_at, id LIMIT 500`,
    )
    .bind(workspaceId)
    .all<Record<string, unknown>>();
  for (const s of results) {
    for (const key of ["eventTypes", "filter", "destination", "delivery"]) {
      s[key] = JSON.parse(s[key] as string);
    }
    s.enabled = s.enabled === 1;
  }
  return { subscriptions: results };
};

/** Routines of the Workspace (or of one Bot / one Conversation) with their schedule parsed (max 500). */
export const listRoutines = async (
  db: D1Database,
  workspaceId: string,
  botId?: string,
  conversationId?: string,
) => {
  const { results } = await db
    .prepare(
      `SELECT id, bot_id AS botId, name, conversation_id AS conversationId, task_id AS taskId, input_text AS inputText,
              job_kind AS jobKind, schedule, schedule_revision AS scheduleRevision, misfire, next_fire_at AS nextFireAt, enabled, revision,
              created_at AS createdAt, updated_at AS updatedAt
         FROM routines WHERE workspace_id = ? AND (? IS NULL OR bot_id = ?) AND (? IS NULL OR conversation_id = ?)
        ORDER BY created_at, id LIMIT 500`,
    )
    .bind(workspaceId, botId ?? null, botId ?? null, conversationId ?? null, conversationId ?? null)
    .all<Record<string, unknown>>();
  for (const r of results) {
    r.schedule = JSON.parse(r.schedule as string);
    r.enabled = r.enabled === 1;
  }
  return { routines: results };
};

export const getConversationSummary = async (
  db: D1Database,
  workspaceId: string,
  conversationId: string,
  userId: string,
) => {
  const access = await searchAccess(db, workspaceId, {
    kind: "user",
    userId,
    workspaceIds: [workspaceId],
  });
  if (
    !(await db
      .prepare(
        `SELECT 1 FROM conversations c WHERE c.workspace_id = ? AND c.id = ? AND ${conversationReadableSql(access)}`,
      )
      .bind(workspaceId, conversationId)
      .first())
  )
    throw notFound("conversation");
  const summary = await db
    .prepare(
      `SELECT id, conversation_id AS conversationId, bot_id AS botId, covers_from_seq AS coversFromSeq,
      covers_to_seq AS coversToSeq, text, pinned_facts AS pinnedFacts, revision, created_by_run_id AS createdByRunId,
      created_at AS createdAt FROM conversation_summaries WHERE workspace_id = ? AND conversation_id = ?
      ORDER BY covers_to_seq DESC, created_at DESC, id DESC LIMIT 1`,
    )
    .bind(workspaceId, conversationId)
    .first<Record<string, unknown>>();
  if (summary) summary.pinnedFacts = JSON.parse(summary.pinnedFacts as string);
  return { summary: summary ?? null };
};

const approvalStates = ["pending", "approved", "denied", "expired"];

/** Newest first (max 100), optionally one `state`; `argsSummary` is redacted on the device (§19). */
export const listApprovals = async (db: D1Database, workspaceId: string, state?: string) => {
  if (state !== undefined && !approvalStates.includes(state)) {
    throw new HttpError("INVALID_INPUT", `state must be one of ${approvalStates.join(", ")}`);
  }
  const { results } = await db
    .prepare(
      `SELECT a.id, a.run_id AS runId, a.execution_generation AS executionGeneration, a.job_id AS jobId,
              a.bot_id AS botId, b.name AS botName, a.action_kind AS actionKind, a.args_summary AS argsSummary,
              a.args_hash AS argsHash, a.cwd_label AS cwdLabel, a.state, a.requested_at AS requestedAt,
              a.expires_at AS expiresAt, a.resolved_at AS resolvedAt, a.resolved_by AS resolvedBy,
              a.decision_reason AS decisionReason
         FROM approvals a JOIN bots b ON b.workspace_id = a.workspace_id AND b.id = a.bot_id
        WHERE a.workspace_id = ? AND (? IS NULL OR a.state = ?)
        ORDER BY a.requested_at DESC, a.id DESC LIMIT 100`,
    )
    .bind(workspaceId, state ?? null, state ?? null)
    .all();
  return { approvals: results };
};

/** The Run's own approval at its generation (what its executor polls), else 404. */
export const getRunApproval = async (
  db: D1Database,
  run: { runId: string; executionGeneration: number },
  id: string,
): Promise<ApprovalStatus> => {
  const row = await db
    .prepare(
      `SELECT id, state, args_hash AS argsHash, expires_at AS expiresAt, decision_reason AS decisionReason
         FROM approvals WHERE id = ? AND run_id = ? AND execution_generation = ?`,
    )
    .bind(id, run.runId, run.executionGeneration)
    .first<ApprovalStatus>();
  if (!row) throw notFound("approval");
  return row;
};
