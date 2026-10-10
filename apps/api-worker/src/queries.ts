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
