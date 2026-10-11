// Outbox pump and event router (docs/architecture.md §6.1, §6.3).
// Known gap: the design hands outbox rows to Cloudflare Queues and routes in a Queue consumer. Until
// then this function is both, driven by the cron trigger and `POST /v1/executor/pump`.
import {
  type SearchKind,
  type FilterExpression,
  type FilterTarget,
  matchesEventType,
  matchesFilter,
} from "@hive/contracts";
import {
  acquireOutboxBatch,
  createDeliveryAndInbox,
  expireApprovals,
  expireLeases,
  markOutboxDead,
  markOutboxSent,
  recordEventRouted,
  type Recipient,
  routeToRecipients,
  sealDueBatches,
} from "@hive/db";
import { performEffect, type Performers, reconcileEffect } from "./effects.ts";
import { parkWaitingJobs } from "./executor.ts";
import type { Notification } from "./realtime.ts";
import { fireDueRoutines } from "./routines.ts";
import { indexSource } from "./search.ts";

const maxAttempts = 5;
const leaseSeconds = 60;

type AgentMessageSent = {
  inboxItemId: string;
  recipientBotId: string;
  /** Null for a bot-to-bot message: its lane is the bot pair's conversation (§8). */
  channelId: string | null;
  conversationId: string;
  delivery: "wake" | "notify";
};

export type EventRow = {
  id: string;
  workspace_id: string;
  type: string;
  source_kind: string;
  integration_id: string | null;
  subject_kind: string | null;
  subject_id: string | null;
  data: string;
  received_at: string;
  correlation_id: string;
};
export const eventColumns =
  "id, workspace_id, type, source_kind, integration_id, subject_kind, subject_id, data, received_at, correlation_id";

export type SubscriptionRow = {
  id: string;
  bot_id: string;
  integration_id: string | null;
  event_types: string;
  filter: string;
  destination: string;
  delivery: string;
};
type Delivery = { mode: "notify" | "wake" | "batch"; debounceMs: number; maxBatchItems: number };

const toTarget = (e: EventRow): FilterTarget => ({
  type: e.type,
  source: { kind: e.source_kind },
  subject: e.subject_kind === null ? null : { kind: e.subject_kind, id: e.subject_id ?? "" },
  data: JSON.parse(e.data) as unknown,
});

/** Event type pattern, integration and filter AST (docs/architecture.md §6.4). */
export const subscriptionMatches = (sub: SubscriptionRow, event: EventRow) =>
  matchesEventType(JSON.parse(sub.event_types) as string[], event.type) &&
  (sub.integration_id === null || sub.integration_id === event.integration_id) &&
  matchesFilter(JSON.parse(sub.filter) as FilterExpression, toTarget(event));

// When Subscriptions of one (bot, lane) disagree, the strongest mode wins.
const modeRank = { notify: 0, batch: 1, wake: 2 } as const;

/**
 * Enabled, unexpired Subscriptions matching the event, collapsed to one recipient per (bot, lane) with every
 * matched id (§6.2). Lane = destination Conversation; purpose `subscription`.
 */
const subscriptionRecipients = async (db: D1Database, event: EventRow) => {
  const now = new Date();
  const { results } = await db
    .prepare(
      `SELECT s.id, s.bot_id, s.integration_id, s.event_types, s.filter, s.destination, s.delivery,
              c.id AS conversation_id, c.channel_id
         FROM subscriptions s
         JOIN conversations c ON c.workspace_id = s.workspace_id
                             AND c.id = json_extract(s.destination, '$.conversationId')
        WHERE s.workspace_id = ? AND s.enabled = 1 AND (s.expires_at IS NULL OR s.expires_at > ?)
        ORDER BY s.id`,
    )
    .bind(event.workspace_id, now.toISOString())
    .all<SubscriptionRow & { conversation_id: string; channel_id: string }>();
  const groups = new Map<string, Omit<Recipient, "workspaceId"> & { delivery: Delivery }>();
  for (const sub of results.filter((s) => subscriptionMatches(s, event))) {
    const delivery = JSON.parse(sub.delivery) as Delivery;
    const key = `${sub.bot_id}\n${sub.conversation_id}`;
    const group = groups.get(key);
    if (group) {
      group.matchedSubscriptionIds!.push(sub.id);
      if (modeRank[delivery.mode] > modeRank[group.delivery.mode]) group.delivery = delivery;
      continue;
    }
    groups.set(key, {
      id: crypto.randomUUID(),
      inputId: event.id,
      botId: sub.bot_id,
      conversationId: sub.conversation_id,
      lane: sub.conversation_id,
      purpose: "subscription",
      deliveryMode: delivery.mode,
      scope: `channel:${sub.channel_id}`,
      matchedSubscriptionIds: [sub.id],
      delivery,
    });
  }
  const recipients = [...groups.values()];
  for (const r of recipients) {
    r.deliveryMode = r.delivery.mode;
    if (r.delivery.mode === "batch") {
      r.batch = {
        sealAt: new Date(now.getTime() + r.delivery.debounceMs).toISOString(),
        maxItems: r.delivery.maxBatchItems,
      };
    }
  }
  return recipients;
};

/**
 * Idempotent: the consumer receipt makes a second route of the same event a no-op. Returns the realtime
 * hint for what this call changed, or null.
 */
export const routeEvent = async (db: D1Database, eventId: string): Promise<Notification | null> => {
  const event = await db
    .prepare(`SELECT ${eventColumns} FROM events WHERE id = ?`)
    .bind(eventId)
    .first<EventRow>();
  if (!event) throw new Error(`event not found: ${eventId}`);
  const workspaceId = event.workspace_id;
  if (event.type !== "agent.message.sent") {
    const recipients = await subscriptionRecipients(db, event);
    if (recipients.length === 0) {
      // matched=0 (AT-06): only the consumer receipt is written.
      await recordEventRouted(db, { workspaceId, eventId });
      return null;
    }
    const routed = await routeToRecipients(db, {
      workspaceId,
      eventId,
      correlationId: event.correlation_id,
      recipients,
    });
    if (!routed.routed) return null;
    const jobAvailable = routed.deliveries.some((d) => d.jobId !== null);
    const scopes = [...new Set(recipients.map((r) => r.scope))];
    return jobAvailable
      ? { workspaceId, scopes: [...scopes, `workspace:${workspaceId}`], jobAvailable }
      : { workspaceId, scopes };
  }
  const data = JSON.parse(event.data) as AgentMessageSent;
  const scope = data.channelId ? `channel:${data.channelId}` : `workspace:${workspaceId}`;
  const routed = await createDeliveryAndInbox(db, {
    id: data.inboxItemId,
    workspaceId,
    eventId,
    correlationId: event.correlation_id,
    inputId: eventId,
    botId: data.recipientBotId,
    conversationId: data.conversationId,
    lane: data.channelId ?? data.conversationId,
    purpose: "agent.send",
    deliveryMode: data.delivery,
    scope,
  });
  if (!routed.routed) return null;
  return routed.jobId
    ? { workspaceId, scopes: [scope, `workspace:${workspaceId}`], jobAvailable: true }
    : { workspaceId, scopes: [scope] };
};

/**
 * Acquires ready outbox rows and handles them. A failed row keeps its lease and is retried after it expires; at
 * `maxAttempts` it goes `dead`. Topics without a consumer yet (e.g. `run.finished`) are marked sent so they do not
 * cycle to dead. Then the time-driven work: due Inbox batches are sealed, due Routines fire, expired leases go
 * `unknown`, Jobs whose devices are all offline go `waiting_device` and timed-out approvals `expired` (`expired` / `parked` /
 * `approvalsExpired` count Workspaces).
 * `notify` receives the realtime hints.
 */
export const pump = async (
  db: D1Database,
  input: {
    owner: string;
    limit: number;
    notify?: (n: Notification) => void;
    /** External effect providers (effects.ts); the Worker builds them from its secrets. */
    performers: Performers;
  },
) => {
  const rows = await acquireOutboxBatch(db, {
    owner: input.owner,
    limit: input.limit,
    leaseSeconds,
  });
  // Rows are independent events, so they are handled concurrently.
  const outcomes = await Promise.all(
    rows.map(async (row) => {
      const settle = { id: row.id, owner: input.owner };
      try {
        if (row.topic === "event.route") {
          const routed = await routeEvent(db, (row.payload as { eventId: string }).eventId);
          if (routed) input.notify?.(routed);
        }
        if (row.topic === "search.index") {
          await indexSource(db, row.payload as { sourceKind: SearchKind; sourceId: string });
        }
        // Provider errors settle the effect inside; only a D1 error throws (and the claim CAS makes a retry safe).
        if (row.topic === "effect.perform" || row.topic === "effect.reconcile") {
          const workspaceId =
            row.topic === "effect.perform"
              ? await performEffect(
                  db,
                  input.performers,
                  row.payload as { effectId: string; attempt: number },
                )
              : await reconcileEffect(
                  db,
                  input.performers,
                  row.payload as { effectId: string; round: number },
                );
          if (workspaceId) input.notify?.({ workspaceId, scopes: [`workspace:${workspaceId}`] });
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
  // Inbox batches due by time or size get their one Job (§7.2).
  const sealed = await sealDueBatches(db);
  for (const { workspaceId } of sealed) {
    input.notify?.({ workspaceId, scopes: [`workspace:${workspaceId}`], jobAvailable: true });
  }
  // Due Routine occurrences get their Inbox item + Job (§17.2).
  const fired = await fireDueRoutines(db);
  for (const { workspaceId, jobIds } of fired) {
    if (jobIds.length > 0) {
      input.notify?.({ workspaceId, scopes: [`workspace:${workspaceId}`], jobAvailable: true });
    }
  }
  // Recovery (§10.4): expired leases → unknown / recovery_required; Jobs no online device can run wait.
  const expired = await expireLeases(db);
  const parked = await parkWaitingJobs(db);
  // Approval timeout (§19, roadmap §1): pending past expires_at, or for a Run no longer current, is a deny.
  const approvals = await expireApprovals(db);
  for (const workspaceId of new Set([...expired, ...parked, ...approvals])) {
    input.notify?.({ workspaceId, scopes: [`workspace:${workspaceId}`] });
  }
  return {
    processed: outcomes.filter((o) => o === "processed").length,
    dead: outcomes.filter((o) => o === "dead").length,
    sealed: sealed.length,
    routineJobs: fired.reduce((n, f) => n + f.jobIds.length, 0),
    expired: expired.length,
    parked: parked.length,
    approvalsExpired: approvals.length,
  };
};
