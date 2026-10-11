// Read routes for a user principal, scoped to the user's Workspaces (docs/architecture.md §22.2).
import { displayState } from "@hive/db";
import { HttpError } from "./errors.ts";

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

export const getJob = async (db: D1Database, wsIds: string[], id: string) => {
  if (wsIds.length === 0) throw notFound("job");
  const job = await db
    .prepare(
      `SELECT id, workspace_id AS workspaceId, bot_id AS botId, task_id AS taskId, state, revision,
              trigger_key AS triggerKey, placement, created_at AS createdAt, updated_at AS updatedAt
         FROM jobs WHERE id = ? AND workspace_id IN (${placeholders(wsIds)})`,
    )
    .bind(id, ...wsIds)
    .first<{ placement: string }>();
  if (!job) throw notFound("job");
  return { ...job, placement: JSON.parse(job.placement) as unknown };
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

export const listChannels = async (db: D1Database, workspaceId: string, userId: string) => {
  const { results } = await db
    .prepare(
      `SELECT ch.id, ch.name, c.id AS conversationId, m.role, ch.created_at AS createdAt
         FROM channels ch
         JOIN channel_members m ON m.workspace_id = ch.workspace_id AND m.channel_id = ch.id
         JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
         LEFT JOIN conversations c ON c.workspace_id = ch.workspace_id AND c.channel_id = ch.id
        WHERE ch.workspace_id = ? AND a.user_id = ?
        ORDER BY ch.name LIMIT 500`,
    )
    .bind(workspaceId, userId)
    .all();
  return { channels: results };
};

export const listBots = async (db: D1Database, workspaceId: string) => {
  const { results } = await db
    .prepare(
      `SELECT id, name, placement_policy AS placementPolicy, config_revision AS revision,
              created_at AS createdAt, updated_at AS updatedAt
         FROM bots WHERE workspace_id = ? ORDER BY name LIMIT 500`,
    )
    .bind(workspaceId)
    .all<{ placementPolicy: unknown }>();
  for (const bot of results) bot.placementPolicy = JSON.parse(bot.placementPolicy as string);
  return { bots: results };
};

export const listDevices = async (db: D1Database, workspaceId: string) => {
  const { results } = await db
    .prepare(
      `SELECT id, name, os, agent_version AS agentVersion, owner_user_id AS ownerUserId,
              last_heartbeat_at AS lastHeartbeatAt, revoked_at AS revokedAt, created_at AS createdAt
         FROM devices WHERE workspace_id = ? ORDER BY created_at, id LIMIT 500`,
    )
    .bind(workspaceId)
    .all();
  return { devices: results };
};

/** Newest first. */
export const listJobs = async (db: D1Database, workspaceId: string, limit: number) => {
  const { results } = await db
    .prepare(
      `SELECT id, bot_id AS botId, task_id AS taskId, state, revision, trigger_key AS triggerKey,
              created_at AS createdAt, updated_at AS updatedAt
         FROM jobs WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .bind(workspaceId, limit)
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
      `SELECT m.id, m.conversation_id AS conversationId, m.seq, m.actor_id AS actorId, m.body,
              m.created_at AS createdAt
         FROM messages m
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

/** One Task with its prerequisites, dependents, Results and Jobs. */
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
  const [prerequisites, dependents, results, jobs] = await Promise.all([
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
  ]);
  return {
    ...toTask(task, prerequisites),
    dependents: dependents.results,
    results: results.results,
    jobs: jobs.results,
  };
};
