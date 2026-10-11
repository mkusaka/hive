// GitHub / Slack intake (docs/architecture.md §1.1, §6.1, §15.2, §16.3): verify the signature over the raw body,
// commit Event + `event.route` outbox in ONE D1 batch, then answer. Nothing is left to `waitUntil`.
// Known gap: the design has this Worker write through api-worker's internal ingest RPC; it binds D1 directly.
import { enqueueOutbox, insertConsumerReceipt, insertEvent } from "@hive/db";
import { type Context, Hono } from "hono";
import {
  type Normalized,
  normalizeGitHub,
  normalizeSlack,
  type SlackCallback,
} from "./normalize.ts";

export type Bindings = {
  DB: D1Database;
  GITHUB_WEBHOOK_SECRET: string;
  SLACK_SIGNING_SECRET: string;
};
type Ctx = Context<{ Bindings: Bindings }>;

/** docs/roadmap.md §1: internal event payload limit. */
export const maxPayloadBytes = 256 * 1024;
/** Slack's replay window for `X-Slack-Request-Timestamp`. */
const slackWindowSeconds = 5 * 60;

type Installation = {
  id: string;
  workspace_id: string;
  kind: "github" | "slack";
  external_account_id: string | null;
};

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

const hmacHex = async (secret: string, data: Uint8Array) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, data));
};

const safeEqual = (a: string, b: string) => {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
};

const fail = (c: Ctx, status: 401 | 404 | 413 | 422 | 500, error: string) =>
  c.json({ error }, status);

const installation = (db: D1Database, id: string, kind: Installation["kind"]) =>
  db
    .prepare(
      `SELECT id, workspace_id, kind, external_account_id FROM integration_installations
        WHERE id = ? AND kind = ? AND enabled = 1`,
    )
    .bind(id, kind)
    .first<Installation>();

/** An authenticated payload over the limit is refused and recorded as missing coverage (§15.2). */
const rejectOversized = async (
  c: Ctx,
  inst: Installation,
  bytes: number,
  externalEventId: string | null,
) => {
  await c.env.DB.prepare(
    `INSERT INTO audit_log (id, workspace_id, actor_id, action, target_kind, target_id, data)
     VALUES (?, ?, ?, 'integration.coverage_gap', 'integration', ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      inst.workspace_id,
      inst.id,
      inst.id,
      JSON.stringify({ reason: "payload_too_large", bytes, externalEventId }),
    )
    .run();
  return fail(c, 413, `payload exceeds ${maxPayloadBytes} bytes`);
};

/**
 * Event + (`event.route` outbox, or for an echo the router's receipt so it never routes) in one batch. A repeated
 * source delivery or logical key fails the batch on a UNIQUE index and answers 200 `duplicate: true`.
 */
const accept = async (c: Ctx, inst: Installation, n: Normalized) => {
  const db = c.env.DB;
  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await db.batch([
      insertEvent(db, {
        id: eventId,
        workspaceId: inst.workspace_id,
        type: n.type,
        schemaVersion: 1,
        sourceKind: inst.kind,
        integrationId: inst.id,
        externalEventId: n.externalEventId,
        actorKind: "integration",
        actorId: inst.id,
        subjectKind: n.subject?.kind,
        subjectId: n.subject?.id,
        data: n.data,
        correlationId: eventId,
        occurredAt: now,
        receivedAt: now,
        logicalKey: n.logicalKey,
      }),
      n.echo
        ? insertConsumerReceipt(db, inst.workspace_id, eventId)
        : enqueueOutbox(db, {
            workspaceId: inst.workspace_id,
            topic: "event.route",
            payload: { eventId },
          }),
    ]);
    return c.json({ ok: true, eventId, routed: !n.echo });
  } catch (error) {
    const existing = await db
      .prepare(
        `SELECT id FROM events WHERE workspace_id = ?
            AND ((source_kind = ? AND integration_id = ? AND external_event_id = ?) OR logical_key = ?)`,
      )
      .bind(inst.workspace_id, inst.kind, inst.id, n.externalEventId, n.logicalKey)
      .first<{ id: string }>();
    if (existing) return c.json({ ok: true, eventId: existing.id, duplicate: true });
    throw error;
  }
};

const parseJson = (body: ArrayBuffer): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
};

export const app = new Hono<{ Bindings: Bindings }>();

app.get("/healthz", (c) => c.json({ ok: true }));

app.post("/hooks/github/:integrationId", async (c) => {
  const secret = c.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return fail(c, 500, "GITHUB_WEBHOOK_SECRET is not configured");
  const inst = await installation(c.env.DB, c.req.param("integrationId"), "github");
  if (!inst) return fail(c, 404, "integration not found");
  const body = await c.req.arrayBuffer();
  const signature = c.req.header("X-Hub-Signature-256") ?? "";
  const expected = `sha256=${await hmacHex(secret, new Uint8Array(body))}`;
  if (!safeEqual(signature, expected)) return fail(c, 401, "invalid signature");
  const deliveryId = c.req.header("X-GitHub-Delivery");
  const event = c.req.header("X-GitHub-Event");
  if (!deliveryId || !event)
    return fail(c, 422, "X-GitHub-Delivery and X-GitHub-Event are required");
  if (body.byteLength > maxPayloadBytes) {
    return rejectOversized(c, inst, body.byteLength, deliveryId);
  }
  const payload = parseJson(body);
  const normalized =
    typeof payload === "object" && payload !== null
      ? normalizeGitHub(event, deliveryId, payload)
      : null;
  if (!normalized) return fail(c, 422, "unsupported payload");
  return accept(c, inst, normalized);
});

app.post("/hooks/slack/:integrationId", async (c) => {
  const secret = c.env.SLACK_SIGNING_SECRET;
  if (!secret) return fail(c, 500, "SLACK_SIGNING_SECRET is not configured");
  const inst = await installation(c.env.DB, c.req.param("integrationId"), "slack");
  if (!inst) return fail(c, 404, "integration not found");
  const body = await c.req.arrayBuffer();
  const timestamp = c.req.header("X-Slack-Request-Timestamp") ?? "";
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!/^\d+$/.test(timestamp) || !(age <= slackWindowSeconds)) {
    return fail(c, 401, "stale or missing timestamp");
  }
  const prefix = encoder.encode(`v0:${timestamp}:`);
  const base = new Uint8Array(prefix.length + body.byteLength);
  base.set(prefix);
  base.set(new Uint8Array(body), prefix.length);
  const expected = `v0=${await hmacHex(secret, base)}`;
  if (!safeEqual(c.req.header("X-Slack-Signature") ?? "", expected)) {
    return fail(c, 401, "invalid signature");
  }
  if (body.byteLength > maxPayloadBytes) return rejectOversized(c, inst, body.byteLength, null);
  const payload = parseJson(body) as
    | (SlackCallback & { type?: unknown; challenge?: unknown })
    | undefined;
  if (typeof payload !== "object" || payload === null) return fail(c, 422, "invalid JSON");
  if (payload.type === "url_verification") return c.json({ challenge: payload.challenge });
  // Other envelope types (e.g. app_rate_limited) carry no event.
  if (payload.type !== "event_callback") return c.json({ ok: true, ignored: true });
  const normalized = normalizeSlack(payload, inst.external_account_id);
  if (!normalized) return fail(c, 422, "unsupported payload");
  return accept(c, inst, normalized);
});

export default { fetch: app.fetch } satisfies ExportedHandler<Bindings>;
