// Read routes for a user principal, scoped to the user's Workspaces (docs/architecture.md §22.2).
import type { ApprovalStatus, PlacementPolicy } from "@hive/contracts";
import { displayState } from "@hive/db";
import { HttpError } from "./errors.ts";
import { placementDevices } from "./executor.ts";
import { deviceReasons } from "./placement.ts";

const notFound = (what: string) => new HttpError("NOT_FOUND", `${what} not found`);
const placeholders = (ids: string[]) => ids.map(() => "?").join(", ");

const inboxItemColumns = `i.id, i.workspace_id AS workspaceId, i.bot_id AS botId, i.conversation_id AS conversationId,
  i.lane, i.purpose, i.delivery_mode AS delivery, i.delivery_id AS deliveryId, i.state,
  i.created_at AS createdAt, i.updated_at AS updatedAt`;

/** The receipt of one of the user's own commands, plus current routing state for an agent.send. */
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
  const response = JSON.parse(receipt.response) as { inboxItemId?: string };
  const base = { operationId: id, receiptStatus: receipt.status, response };
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
      `SELECT id, workspace_id AS workspaceId, bot_id AS botId, task_id AS taskId, state, revision,
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
              (SELECT json_object('body', lm.body, 'createdAt', lm.created_at, 'actorId', lm.actor_id)
                 FROM messages lm WHERE lm.workspace_id = c.workspace_id AND lm.conversation_id = c.id
                ORDER BY lm.seq DESC LIMIT 1) AS lastMessage
         FROM channels ch
         JOIN channel_members m ON m.workspace_id = ch.workspace_id AND m.channel_id = ch.id
         JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
         LEFT JOIN conversations c ON c.workspace_id = ch.workspace_id AND c.channel_id = ch.id
        WHERE ch.workspace_id = ? AND a.user_id = ?
        ORDER BY ch.name LIMIT 500`,
    )
    .bind(workspaceId, userId)
    .all<{ lastMessage: string | null }>();
  for (const ch of results) ch.lastMessage = ch.lastMessage && JSON.parse(ch.lastMessage);
  return { channels: results };
};

/**
 * The Channel's members (role `owner` / `member`) and the actors that posted in it without being members (role null,
 * e.g. a Bot replying through its Inbox). Bots carry `botId` and their current name. Callers must be members.
 */
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
         FROM actors a
         LEFT JOIN channel_members m
           ON m.workspace_id = a.workspace_id AND m.channel_id = ? AND m.actor_id = a.id
         LEFT JOIN bots b ON b.workspace_id = a.workspace_id AND b.actor_id = a.id
        WHERE a.workspace_id = ? AND (m.actor_id IS NOT NULL OR EXISTS (
                SELECT 1 FROM messages msg JOIN conversations c
                    ON c.workspace_id = msg.workspace_id AND c.id = msg.conversation_id
                 WHERE msg.workspace_id = a.workspace_id AND msg.actor_id = a.id AND c.channel_id = ?))
        ORDER BY m.role IS NULL, a.kind DESC, name LIMIT 500`,
    )
    .bind(input.channelId, input.workspaceId, input.channelId)
    .all();
  return { members: results };
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
      `SELECT id, bot_id AS botId, task_id AS taskId, state, revision, trigger_key AS triggerKey,
              cancel_requested_at AS cancelRequestedAt, created_at AS createdAt, updated_at AS updatedAt
         FROM jobs WHERE workspace_id = ? AND (? IS NULL OR state = ?)
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .bind(workspaceId, state ?? null, state ?? null, limit)
    .all();
  return { jobs: results };
};

/** Newest first, from the channel's main conversation; channel membership required (404 otherwise). */
export const listMessages = async (
  db: D1Database,
  input: { workspaceId: string; userId: string; channelId: string; limit: number },
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
      `SELECT m.id, m.conversation_id AS conversationId, m.seq, m.actor_id AS actorId, a.user_id AS userId, m.body,
              m.created_at AS createdAt
         FROM messages m
         LEFT JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
         JOIN conversations c ON c.workspace_id = m.workspace_id AND c.id = m.conversation_id
        WHERE c.workspace_id = ? AND c.channel_id = ?
        ORDER BY m.seq DESC LIMIT ?`,
    )
    .bind(input.workspaceId, input.channelId, input.limit)
    .all();
  return { messages: results };
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
              schedule, schedule_revision AS scheduleRevision, misfire, next_fire_at AS nextFireAt, enabled, revision,
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
