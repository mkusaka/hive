// Outbox pump and event router (docs/architecture.md §6.1, §6.3).
// Known gap: the design hands outbox rows to Cloudflare Queues and routes in a Queue consumer. Until
// then this function is both, driven by the cron trigger and `POST /v1/executor/pump`.
import {
  acquireOutboxBatch,
  createDeliveryAndInbox,
  markOutboxDead,
  markOutboxSent,
  recordEventRouted,
} from "@hive/db";

const maxAttempts = 5;
const leaseSeconds = 60;

type AgentMessageSent = {
  inboxItemId: string;
  recipientBotId: string;
  channelId: string;
  conversationId: string;
  delivery: "wake" | "notify";
};

/** Idempotent: the consumer receipt makes a second route of the same event a no-op. */
export const routeEvent = async (db: D1Database, eventId: string) => {
  const event = await db
    .prepare("SELECT workspace_id, type, data FROM events WHERE id = ?")
    .bind(eventId)
    .first<{ workspace_id: string; type: string; data: string }>();
  if (!event) throw new Error(`event not found: ${eventId}`);
  const workspaceId = event.workspace_id;
  if (event.type !== "agent.message.sent") {
    // No subscriptions yet: nothing matches (matched=0), only the consumer receipt is written.
    await recordEventRouted(db, { workspaceId, eventId });
    return;
  }
  const data = JSON.parse(event.data) as AgentMessageSent;
  await createDeliveryAndInbox(db, {
    id: data.inboxItemId,
    workspaceId,
    eventId,
    inputId: eventId,
    botId: data.recipientBotId,
    conversationId: data.conversationId,
    lane: data.channelId,
    purpose: "agent.send",
    deliveryMode: data.delivery,
  });
};

/**
 * Acquires ready outbox rows and handles them. A failed row keeps its lease and is retried after it
 * expires; at `maxAttempts` it goes `dead`. Topics without a consumer yet (e.g. `run.finished`) are
 * marked sent so they do not cycle to dead.
 */
export const pump = async (db: D1Database, input: { owner: string; limit: number }) => {
  const rows = await acquireOutboxBatch(db, { ...input, leaseSeconds });
  // Rows are independent events, so they are handled concurrently.
  const outcomes = await Promise.all(
    rows.map(async (row) => {
      const settle = { id: row.id, owner: input.owner };
      try {
        if (row.topic === "event.route") {
          await routeEvent(db, (row.payload as { eventId: string }).eventId);
        }
        await markOutboxSent(db, settle);
        return "processed";
      } catch (error) {
        console.error(`outbox ${row.id} attempt ${row.attempt} failed`, error);
        if (row.attempt >= maxAttempts && (await markOutboxDead(db, settle))) return "dead";
        return "retry";
      }
    }),
  );
  return {
    processed: outcomes.filter((o) => o === "processed").length,
    dead: outcomes.filter((o) => o === "dead").length,
  };
};
