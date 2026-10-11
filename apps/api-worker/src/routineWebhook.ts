import { appendChange, guard } from "@hive/db";
import { HttpError } from "./errors.ts";
import { occurrenceStatements, routineColumns, routineFrom, type RoutineRow } from "./routines.ts";

export const maxRoutineWebhookBytes = 64 * 1024;

const deliveryRetentionMs = 7 * 24 * 60 * 60_000;
const requestsPerMinute = 60;
const encoder = new TextEncoder();

type WebhookRoutine = RoutineRow & { webhook_secret_hash: string | null };

/** Validates and durably turns one unauthenticated Routine hook into its regular occurrence and Job. */
export const receiveRoutineWebhook = async (
  db: D1Database,
  input: { routineId: string; signature: string; deliveryId: string | null; body: Uint8Array },
) => {
  const routine = await db
    .prepare(
      `SELECT ${routineColumns}, r.webhook_secret_hash FROM ${routineFrom}
        WHERE r.id = ? AND json_extract(r.schedule, '$.kind') = 'webhook'`,
    )
    .bind(input.routineId)
    .first<WebhookRoutine>();
  if (!routine) throw new HttpError("NOT_FOUND", "webhook routine not found");
  if (!routine.webhook_secret_hash) {
    throw new HttpError("UNAUTHENTICATED", "invalid webhook signature");
  }
  // The displayed secret is 77 bytes, so HMAC-SHA256 normalizes it to this stored SHA-256 digest.
  const key = new Uint8Array(
    routine.webhook_secret_hash.match(/../g)!.map((pair) => Number.parseInt(pair, 16)),
  );
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", hmacKey, input.body);
  const expected = `sha256=${[...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
  const actual = encoder.encode(input.signature);
  const expectedBytes = encoder.encode(expected);
  if (
    actual.length !== expectedBytes.length ||
    !crypto.subtle.timingSafeEqual(actual, expectedBytes)
  ) {
    throw new HttpError("UNAUTHENTICATED", "invalid webhook signature");
  }
  if (!routine.enabled) {
    throw new HttpError("REVISION_CONFLICT", "routine is disabled", false, "routine_disabled");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(input.body));
  } catch {
    throw new HttpError("INVALID_INPUT", "webhook body must be JSON");
  }
  const now = Date.now();
  const receivedAt = new Date(now).toISOString();
  const retainedAfter = new Date(now - deliveryRetentionMs).toISOString();
  if (input.deliveryId !== null) {
    await db
      .prepare("DELETE FROM routine_webhook_deliveries WHERE routine_id = ? AND received_at < ?")
      .bind(routine.id, retainedAfter)
      .run();
    const duplicate = await db
      .prepare(
        `SELECT 1 FROM routine_webhook_deliveries
          WHERE routine_id = ? AND delivery_id = ? AND received_at >= ?`,
      )
      .bind(routine.id, input.deliveryId, retainedAfter)
      .first();
    if (duplicate) return { ok: true, duplicate: true };
  }
  const occurrence = occurrenceStatements(db, routine, receivedAt, {
    // Delivery ids expire after seven days; only the delivery table, never the occurrence identity, deduplicates them.
    occurrenceKey: `webhook:${crypto.randomUUID()}`,
    payload,
  });
  const minute = Math.floor(now / 60_000);
  const authorizationFenceId = `routine-webhook:${crypto.randomUUID()}`;
  const [setGuard, clearGuard] = guard(db);
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO atomic_guards (operation_id, ok)
           SELECT ?, EXISTS(
             SELECT 1 FROM routines
              WHERE id = ? AND enabled = 1 AND schedule_revision = ? AND webhook_secret_hash = ?
                AND json_extract(schedule, '$.kind') = 'webhook'
           )`,
        )
        .bind(
          authorizationFenceId,
          routine.id,
          routine.schedule_revision,
          routine.webhook_secret_hash,
        ),
      ...(input.deliveryId === null
        ? []
        : [
            db
              .prepare(
                `INSERT INTO routine_webhook_deliveries (routine_id, delivery_id, received_at) VALUES (?, ?, ?)`,
              )
              .bind(routine.id, input.deliveryId, receivedAt),
          ]),
      db
        .prepare(
          "DELETE FROM routine_webhook_rate_limits WHERE routine_id = ? AND window_started_at < ?",
        )
        .bind(routine.id, minute),
      db
        .prepare(
          `INSERT INTO routine_webhook_rate_limits (routine_id, window_started_at, request_count) VALUES (?, ?, 1)
           ON CONFLICT (routine_id, window_started_at) DO UPDATE SET request_count = request_count + 1
           WHERE request_count < ?`,
        )
        .bind(routine.id, minute, requestsPerMinute),
      setGuard,
      clearGuard,
      ...occurrence.statements,
      ...occurrence.changes.map((change) =>
        appendChange(db, { workspaceId: routine.workspace_id, ...change }),
      ),
      db.prepare("DELETE FROM atomic_guards WHERE operation_id = ?").bind(authorizationFenceId),
    ]);
  } catch (error) {
    if (input.deliveryId !== null) {
      const duplicate = await db
        .prepare(
          `SELECT 1 FROM routine_webhook_deliveries
            WHERE routine_id = ? AND delivery_id = ? AND received_at >= ?`,
        )
        .bind(routine.id, input.deliveryId, retainedAfter)
        .first();
      if (duplicate) return { ok: true, duplicate: true };
    }
    const current = await db
      .prepare(
        `SELECT enabled, schedule_revision, webhook_secret_hash, json_extract(schedule, '$.kind') AS schedule_kind
           FROM routines WHERE id = ?`,
      )
      .bind(routine.id)
      .first<{
        enabled: number;
        schedule_revision: number;
        webhook_secret_hash: string | null;
        schedule_kind: string;
      }>();
    if (!current) throw new HttpError("NOT_FOUND", "webhook routine not found");
    if (!current.enabled) {
      throw new HttpError("REVISION_CONFLICT", "routine is disabled", false, "routine_disabled");
    }
    if (
      current.schedule_kind !== "webhook" ||
      current.schedule_revision !== routine.schedule_revision
    ) {
      throw new HttpError("REVISION_CONFLICT", "routine trigger changed", false, "routine_moved");
    }
    if (current.webhook_secret_hash !== routine.webhook_secret_hash) {
      throw new HttpError("UNAUTHENTICATED", "invalid webhook signature");
    }
    const rate = await db
      .prepare(
        `SELECT request_count FROM routine_webhook_rate_limits
          WHERE routine_id = ? AND window_started_at = ?`,
      )
      .bind(routine.id, minute)
      .first<{ request_count: number }>();
    if ((rate?.request_count ?? 0) >= requestsPerMinute) {
      throw new HttpError(
        "RATE_LIMITED",
        "webhook rate limit exceeded",
        true,
        "routine_webhook_rate",
      );
    }
    throw error;
  }
  return {
    ok: true,
    routineId: routine.id,
    occurrenceId: occurrence.occurrenceId,
    jobId: occurrence.jobId,
    scheduledAt: receivedAt,
  };
};
