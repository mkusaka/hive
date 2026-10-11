// Read routes for a user principal, scoped to the user's Workspaces (docs/architecture.md §22.2).
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
      `SELECT id, workspace_id AS workspaceId, bot_id AS botId, state, revision, trigger_key AS triggerKey,
              placement, created_at AS createdAt, updated_at AS updatedAt
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
      `SELECT id, bot_id AS botId, state, revision, trigger_key AS triggerKey,
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
