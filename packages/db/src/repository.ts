// Critical commands as prepared-statement batches (docs/architecture.md §11).
// A D1 batch rolls back on any SQL error, but a 0-row conditional UPDATE is not an error:
// `atomic_guards` turns it into a CHECK violation (§11.3).
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { events, inboxItems, messages, operationReceipts, outbox } from "./schema.ts";

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const activeRunStates = "('starting', 'running', 'waiting_approval', 'stopping')";

/** [set, clear] around a statement that must change exactly one row. Each pair in a batch needs its own id. */
export const guard = (db: D1Database, operationId: string = crypto.randomUUID()) =>
  [
    db
      .prepare("INSERT INTO atomic_guards (operation_id, ok) VALUES (?, changes())")
      .bind(operationId),
    db.prepare("DELETE FROM atomic_guards WHERE operation_id = ?").bind(operationId),
  ] as const;

export const digest = async (value: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

// ------------------------------------------------------- Operation receipts

export class IdempotencyConflict extends Error {
  override name = "IdempotencyConflict";
}

export type ReceiptKey = {
  workspaceId: string;
  actorId: string;
  idempotencyKey: string;
  requestDigest: string;
};

const readReceipt = async (db: D1Database, key: ReceiptKey) => {
  const [row] = await drizzle(db)
    .select()
    .from(operationReceipts)
    .where(
      and(
        eq(operationReceipts.workspaceId, key.workspaceId),
        eq(operationReceipts.actorId, key.actorId),
        eq(operationReceipts.idempotencyKey, key.idempotencyKey),
      ),
    );
  if (!row) return null;
  if (row.requestDigest !== key.requestDigest) {
    throw new IdempotencyConflict(
      `idempotency key reused with a different request: ${key.idempotencyKey}`,
    );
  }
  return { replayed: true, status: row.status, response: row.response };
};

/**
 * Runs `build().statements` and stores the receipt in the same batch. A replay with the same digest
 * returns the stored response without running anything; a different digest throws IdempotencyConflict.
 * Any other SQL error is rethrown after the batch rolled back.
 */
export const withOperationReceipt = async <T>(
  db: D1Database,
  key: ReceiptKey,
  build: () => { statements: D1PreparedStatement[]; status: number; response: T },
): Promise<{ replayed: boolean; status: number; response: T }> => {
  const stored = await readReceipt(db, key);
  if (stored) return stored as { replayed: true; status: number; response: T };
  const { statements, status, response } = build();
  const receipt = db
    .prepare(
      `INSERT INTO operation_receipts
         (workspace_id, actor_id, idempotency_key, request_digest, status, response)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      key.workspaceId,
      key.actorId,
      key.idempotencyKey,
      key.requestDigest,
      status,
      JSON.stringify(response),
    );
  try {
    await db.batch([...statements, receipt]);
    return { replayed: false, status, response };
  } catch (error) {
    // A concurrent request with the same key may have won the receipt.
    const raced = await readReceipt(db, key);
    if (raced) return raced as { replayed: true; status: number; response: T };
    throw error;
  }
};

// --------------------------------------------------------------- Job claim

export type ClaimInput = {
  workspaceId: string;
  jobId: string;
  deviceId: string;
  expectedRevision: number;
  leaseSeconds: number;
  resourceKeys: string[];
  operationId: string;
};
export type Claim = {
  runId: string;
  executionId: string;
  generation: number;
  leaseExpiresAt: string;
};
export type ClaimFailure =
  | { ok: false; reason: "stale_revision" | "resource_busy" }
  | { ok: false; reason: "already_claimed"; jobState: string };
export type ClaimResult = ({ ok: true } & Claim) | ClaimFailure;

/** job.claim (§9.2 step 4): Job CAS, root Run, Execution, reservations, change rows and receipt in one batch. */
export const claimJob = async (db: D1Database, input: ClaimInput): Promise<ClaimResult> => {
  const { workspaceId, jobId, deviceId, operationId } = input;
  const key = {
    workspaceId,
    actorId: deviceId,
    idempotencyKey: operationId,
    requestDigest: await digest([
      jobId,
      input.expectedRevision,
      input.leaseSeconds,
      input.resourceKeys,
    ]),
  };
  // Safe to read outside the batch: any claim that inserts a newer Run also bumps the Job revision,
  // so our CAS fails. UNIQUE (job_id, execution_generation) is the backstop.
  const previous = await db
    .prepare("SELECT COALESCE(MAX(execution_generation), 0) AS g FROM runs WHERE job_id = ?")
    .bind(jobId)
    .first<{ g: number }>();
  const now = Date.now();
  const claim: Claim = {
    runId: crypto.randomUUID(),
    executionId: crypto.randomUUID(),
    generation: (previous?.g ?? 0) + 1,
    leaseExpiresAt: iso(now + input.leaseSeconds * 1000),
  };
  const [setGuard, clearGuard] = guard(db, operationId);
  try {
    const { response } = await withOperationReceipt(db, key, () => ({
      status: 201,
      response: claim,
      statements: [
        db
          .prepare(
            // A `waiting_device` Job is claimable too: the claiming (eligible) device is evidently online.
            `UPDATE jobs SET state = 'active', revision = revision + 1, updated_at = ?
              WHERE workspace_id = ? AND id = ? AND state IN ('queued', 'waiting_device') AND revision = ?`,
          )
          .bind(iso(now), workspaceId, jobId, input.expectedRevision),
        setGuard,
        db
          .prepare(
            `INSERT INTO runs (id, workspace_id, job_id, kind, device_id, execution_generation, state, lease_expires_at)
             VALUES (?, ?, ?, 'root', ?, ?, 'starting', ?)`,
          )
          .bind(claim.runId, workspaceId, jobId, deviceId, claim.generation, claim.leaseExpiresAt),
        // A Task Job's Execution records the Task and its current scope revision (§3.1).
        db
          .prepare(
            `INSERT INTO executions (id, workspace_id, run_id, task_id, task_scope_revision)
             SELECT ?, ?, ?, j.task_id, t.scope_revision
               FROM jobs j LEFT JOIN tasks t ON t.workspace_id = j.workspace_id AND t.id = j.task_id
              WHERE j.workspace_id = ? AND j.id = ?`,
          )
          .bind(claim.executionId, workspaceId, claim.runId, workspaceId, jobId),
        appendChange(db, {
          workspaceId,
          entityKind: "job",
          entityId: jobId,
          revision: input.expectedRevision + 1,
          scope: `workspace:${workspaceId}`,
        }),
        appendChange(db, {
          workspaceId,
          entityKind: "run",
          entityId: claim.runId,
          scope: `workspace:${workspaceId}`,
        }),
        ...input.resourceKeys.map((resourceKey) =>
          db
            .prepare(
              "INSERT INTO resource_reservations (id, workspace_id, resource_key, run_id) VALUES (?, ?, ?, ?)",
            )
            .bind(crypto.randomUUID(), workspaceId, resourceKey, claim.runId),
        ),
        clearGuard,
      ],
    }));
    return { ok: true, ...response };
  } catch (error) {
    if (error instanceof IdempotencyConflict) throw error;
    const failure = await diagnoseClaimFailure(db, input);
    if (failure) return failure;
    throw error;
  }
};

// The batch already rolled back; re-read state to name the failure instead of parsing SQL errors.
const diagnoseClaimFailure = async (
  db: D1Database,
  input: ClaimInput,
): Promise<ClaimFailure | null> => {
  const job = await db
    .prepare("SELECT state, revision FROM jobs WHERE workspace_id = ? AND id = ?")
    .bind(input.workspaceId, input.jobId)
    .first<{ state: string; revision: number }>();
  if (!job) return null;
  if (job.state !== "queued" && job.state !== "waiting_device") {
    return { ok: false, reason: "already_claimed", jobState: job.state };
  }
  if (job.revision !== input.expectedRevision) return { ok: false, reason: "stale_revision" };
  if (input.resourceKeys.length === 0) return null;
  const busy = await db
    .prepare(
      `SELECT 1 FROM resource_reservations
        WHERE workspace_id = ? AND released_at IS NULL
          AND resource_key IN (${input.resourceKeys.map(() => "?").join(", ")})`,
    )
    .bind(input.workspaceId, ...input.resourceKeys)
    .first();
  return busy ? { ok: false, reason: "resource_busy" } : null;
};

// ------------------------------------------------------- Lease and finish

export type Fence = { runId: string; deviceId: string; executionGeneration: number };

/** Fenced by run_id + device_id + execution_generation (§10.3). */
export const renewLease = async (
  db: D1Database,
  input: Fence & { leaseSeconds: number },
): Promise<{ ok: true; leaseExpiresAt: string } | { ok: false; reason: "stale_generation" }> => {
  const leaseExpiresAt = iso(Date.now() + input.leaseSeconds * 1000);
  const result = await db
    .prepare(
      `UPDATE runs SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND device_id = ? AND execution_generation = ? AND state IN ${activeRunStates}`,
    )
    .bind(leaseExpiresAt, iso(), input.runId, input.deviceId, input.executionGeneration)
    .run();
  return result.meta.changes === 1
    ? { ok: true, leaseExpiresAt }
    : { ok: false, reason: "stale_generation" };
};

/**
 * Run completion (§11.1): fenced terminal Run with its result, Execution, released reservations, Job state,
 * outbox, change rows, the caller's extra `statements` (e.g. the Inbox outcome) and receipt. A replay with the same
 * operationId returns the stored `{ ok: true }`. `cancelled` (a stop after job.cancel) leaves the Execution
 * `interrupted`.
 */
const executionOutcome = { succeeded: "finished", failed: "failed", cancelled: "interrupted" };

export const finishRun = async (
  db: D1Database,
  input: Fence & {
    state: "succeeded" | "failed" | "cancelled";
    operationId: string;
    summary?: string;
    error?: string;
    statements?: D1PreparedStatement[];
  },
): Promise<{ ok: true } | { ok: false; reason: "stale_generation" }> => {
  const run = await db
    .prepare("SELECT workspace_id, job_id FROM runs WHERE id = ?")
    .bind(input.runId)
    .first<{ workspace_id: string; job_id: string }>();
  if (!run) return { ok: false, reason: "stale_generation" };
  const key = {
    workspaceId: run.workspace_id,
    actorId: input.deviceId,
    idempotencyKey: input.operationId,
    requestDigest: await digest([
      input.runId,
      input.executionGeneration,
      input.state,
      input.summary ?? null,
      input.error ?? null,
    ]),
  };
  const now = iso();
  const [setGuard, clearGuard] = guard(db, input.operationId);
  try {
    const { response } = await withOperationReceipt(db, key, () => ({
      status: 200,
      response: { ok: true } as const,
      statements: [
        db
          .prepare(
            `UPDATE runs SET state = ?, result_summary = ?, result_error = ?, lease_expires_at = NULL, updated_at = ?
            WHERE id = ? AND device_id = ? AND execution_generation = ? AND state IN ${activeRunStates}`,
          )
          .bind(
            input.state,
            input.summary ?? null,
            input.error ?? null,
            now,
            input.runId,
            input.deviceId,
            input.executionGeneration,
          ),
        setGuard,
        db
          .prepare(
            "UPDATE executions SET state = ?, updated_at = ? WHERE run_id = ? AND state = 'active'",
          )
          .bind(executionOutcome[input.state], now, input.runId),
        db
          .prepare(
            "UPDATE resource_reservations SET released_at = ? WHERE run_id = ? AND released_at IS NULL",
          )
          .bind(now, input.runId),
        db
          .prepare(
            `UPDATE jobs SET state = ?, revision = revision + 1, updated_at = ?
            WHERE workspace_id = ? AND id = ? AND state = 'active'`,
          )
          .bind(input.state, now, run.workspace_id, run.job_id),
        enqueueOutbox(db, {
          workspaceId: run.workspace_id,
          topic: "run.finished",
          payload: { runId: input.runId, jobId: run.job_id, state: input.state },
        }),
        appendChange(db, {
          workspaceId: run.workspace_id,
          entityKind: "run",
          entityId: input.runId,
          scope: `workspace:${run.workspace_id}`,
        }),
        appendChange(db, {
          workspaceId: run.workspace_id,
          entityKind: "job",
          entityId: run.job_id,
          scope: `workspace:${run.workspace_id}`,
        }),
        ...(input.statements ?? []),
        clearGuard,
      ],
    }));
    return response;
  } catch (error) {
    if (error instanceof IdempotencyConflict) throw error;
    const fenced = await db
      .prepare(
        `SELECT 1 FROM runs
          WHERE id = ? AND device_id = ? AND execution_generation = ? AND state IN ${activeRunStates}`,
      )
      .bind(input.runId, input.deviceId, input.executionGeneration)
      .first();
    if (!fenced) return { ok: false, reason: "stale_generation" };
    throw error;
  }
};

// --------------------------------------------------- Recovery (§10.3, §10.4)
// Lease expiry is not proof of a stop: a Run whose lease expired goes `unknown`, keeps its reservations and its Job
// waits for a human (`recovery_required`). Only a confirmed stop (`confirmRunStopped`) releases them. There is no
// automatic re-run (`recovery: safe_auto` is not implemented).

/**
 * Moves active Runs whose lease expired to `unknown` and their Jobs to `recovery_required`, one guarded batch per Run
 * (a Run renewed meanwhile is skipped). `result_error` records whether the launch was ever confirmed
 * (`runtime.run.started`). Returns the touched Workspaces.
 */
export const expireLeases = async (db: D1Database, limit = 50) => {
  const now = iso();
  const { results } = await db
    .prepare(
      `SELECT id, workspace_id, job_id, started_at FROM runs
        WHERE state IN ${activeRunStates} AND lease_expires_at < ? ORDER BY lease_expires_at LIMIT ?`,
    )
    .bind(now, limit)
    .all<{ id: string; workspace_id: string; job_id: string; started_at: string | null }>();
  const expired = await Promise.all(
    results.map(async (run) => {
      const [setGuard, clearGuard] = guard(db);
      const scope = `workspace:${run.workspace_id}`;
      try {
        await db.batch([
          db
            .prepare(
              `UPDATE runs SET state = 'unknown', result_error = ?, updated_at = ?
                WHERE id = ? AND state IN ${activeRunStates} AND lease_expires_at < ?`,
            )
            .bind(
              run.started_at ? "lease_expired" : "lease_expired_before_start",
              now,
              run.id,
              now,
            ),
          setGuard,
          clearGuard,
          db
            .prepare(
              `UPDATE jobs SET state = 'recovery_required', revision = revision + 1, updated_at = ?
                WHERE workspace_id = ? AND id = ? AND state = 'active'`,
            )
            .bind(now, run.workspace_id, run.job_id),
          appendChange(db, {
            workspaceId: run.workspace_id,
            entityKind: "run",
            entityId: run.id,
            scope,
          }),
          appendChange(db, {
            workspaceId: run.workspace_id,
            entityKind: "job",
            entityId: run.job_id,
            scope,
          }),
        ]);
        return run.workspace_id;
      } catch (error) {
        const row = await db
          .prepare(
            `SELECT 1 FROM runs WHERE id = ? AND state IN ${activeRunStates} AND lease_expires_at < ?`,
          )
          .bind(run.id, now)
          .first();
        if (!row) return null;
        throw error;
      }
    }),
  );
  return [...new Set(expired.filter((w) => w !== null))];
};

/**
 * `runtime.run.stopped` (confirmed): an `unknown` Run becomes `interrupted`, its Execution too, and its reservations
 * are released, fenced like a renew. Already terminal → `{ ok: true }` (idempotent); still active → `not_unknown`.
 */
export const confirmRunStopped = async (
  db: D1Database,
  input: Fence & { workspaceId: string },
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_unknown" }> => {
  const now = iso();
  const fence = [input.runId, input.workspaceId, input.deviceId, input.executionGeneration];
  const [setGuard, clearGuard] = guard(db);
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE runs SET state = 'interrupted', lease_expires_at = NULL, updated_at = ?
            WHERE id = ? AND workspace_id = ? AND device_id = ? AND execution_generation = ? AND state = 'unknown'`,
        )
        .bind(now, ...fence),
      setGuard,
      clearGuard,
      db
        .prepare(
          "UPDATE executions SET state = 'interrupted', updated_at = ? WHERE run_id = ? AND state = 'active'",
        )
        .bind(now, input.runId),
      db
        .prepare(
          "UPDATE resource_reservations SET released_at = ? WHERE run_id = ? AND released_at IS NULL",
        )
        .bind(now, input.runId),
      appendChange(db, {
        workspaceId: input.workspaceId,
        entityKind: "run",
        entityId: input.runId,
        scope: `workspace:${input.workspaceId}`,
      }),
    ]);
    return { ok: true };
  } catch (error) {
    const run = await db
      .prepare(
        `SELECT state FROM runs
          WHERE id = ? AND workspace_id = ? AND device_id = ? AND execution_generation = ?`,
      )
      .bind(...fence)
      .first<{ state: string }>();
    if (!run) return { ok: false, reason: "not_found" };
    if (["succeeded", "failed", "interrupted", "cancelled"].includes(run.state))
      return { ok: true };
    if (run.state !== "unknown") return { ok: false, reason: "not_unknown" };
    throw error;
  }
};

// A device is online when it heartbeated within this window: 3 × the 15 s heartbeat (docs/roadmap.md §1).
const onlineSeconds = 45;
// `placement` names devices; an empty `allowedDeviceIds` (any device) never waits here.
const allOfflineSql = `json_array_length(placement, '$.allowedDeviceIds') > 0
  AND NOT EXISTS (SELECT 1 FROM devices d, json_each(jobs.placement, '$.allowedDeviceIds') a
                   WHERE d.workspace_id = jobs.workspace_id AND d.id = a.value AND d.revoked_at IS NULL
                     AND d.last_heartbeat_at >= ?)`;

/**
 * Queued Jobs whose allowed devices are all offline go `waiting_device` (§10.4, AT-30), with their change rows in the
 * same batch. A heartbeat flips them back (`resumeWaitingJobs`).
 */
export const parkOfflineJobs = async (db: D1Database) => {
  const now = iso();
  const since = iso(Date.now() - onlineSeconds * 1000);
  const parked = await db.batch<{ workspace_id: string }>([
    db
      .prepare(
        `INSERT INTO change_log (workspace_id, entity_kind, entity_id, op, revision, scope)
         SELECT workspace_id, 'job', id, 'upsert', revision + 1, 'workspace:' || workspace_id FROM jobs
          WHERE state = 'queued' AND ${allOfflineSql}
         RETURNING workspace_id`,
      )
      .bind(since),
    db
      .prepare(
        `UPDATE jobs SET state = 'waiting_device', revision = revision + 1, updated_at = ?
          WHERE state = 'queued' AND ${allOfflineSql}`,
      )
      .bind(now, since),
  ]);
  return [...new Set(parked[0]!.results.map((r) => r.workspace_id))];
};

/** Heartbeat side (AT-12): `waiting_device` Jobs this device may run go back to `queued`. Returns how many. */
export const resumeWaitingJobs = async (
  db: D1Database,
  input: { workspaceId: string; deviceId: string },
) => {
  const mine = `workspace_id = ? AND state = 'waiting_device'
    AND EXISTS (SELECT 1 FROM json_each(jobs.placement, '$.allowedDeviceIds') WHERE value = ?)`;
  const [changes] = await db.batch([
    db
      .prepare(
        `INSERT INTO change_log (workspace_id, entity_kind, entity_id, op, revision, scope)
         SELECT workspace_id, 'job', id, 'upsert', revision + 1, 'workspace:' || workspace_id FROM jobs WHERE ${mine}`,
      )
      .bind(input.workspaceId, input.deviceId),
    db
      .prepare(
        `UPDATE jobs SET state = 'queued', revision = revision + 1, updated_at = ? WHERE ${mine}`,
      )
      .bind(iso(), input.workspaceId, input.deviceId),
  ]);
  return changes!.meta.changes;
};

// -------------------------------------------------------------- Change log

/**
 * Returns a statement to include in the batch that commits the change (§12.2). `scope` is
 * `workspace:<id>` or `channel:<id>`; `revision` is omitted for entities without a revision column.
 */
export const appendChange = (
  db: D1Database,
  input: {
    workspaceId: string;
    entityKind: string;
    entityId: string;
    op?: "upsert" | "delete";
    revision?: number;
    scope: string;
  },
) =>
  db
    .prepare(
      "INSERT INTO change_log (workspace_id, entity_kind, entity_id, op, revision, scope) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      input.workspaceId,
      input.entityKind,
      input.entityId,
      input.op ?? "upsert",
      input.revision ?? null,
      input.scope,
    );

// ------------------------------------------------------------------ Outbox

/** Returns a statement to include in the batch that commits the state change. */
export const enqueueOutbox = (
  db: D1Database,
  input: { workspaceId: string; topic: string; payload: unknown },
) =>
  db
    .prepare("INSERT INTO outbox (id, workspace_id, topic, payload) VALUES (?, ?, ?, ?)")
    .bind(crypto.randomUUID(), input.workspaceId, input.topic, JSON.stringify(input.payload));

/** Conditional acquisition: one UPDATE claims ready rows (pending, or `sending` with an expired lease). */
export const acquireOutboxBatch = (
  db: D1Database,
  input: { owner: string; limit: number; leaseSeconds: number },
) => {
  const now = iso();
  const orm = drizzle(db);
  const ready = orm
    .select({ id: outbox.id })
    .from(outbox)
    .where(
      or(
        and(eq(outbox.state, "pending"), lte(outbox.availableAt, now)),
        and(eq(outbox.state, "sending"), lte(outbox.leaseUntil, now)),
      ),
    )
    .orderBy(asc(outbox.availableAt))
    .limit(input.limit);
  return orm
    .update(outbox)
    .set({
      state: "sending",
      leaseOwner: input.owner,
      leaseUntil: iso(Date.now() + input.leaseSeconds * 1000),
      attempt: sql`${outbox.attempt} + 1`,
      updatedAt: now,
    })
    .where(inArray(outbox.id, ready))
    .returning();
};

const settleOutbox = async (
  db: D1Database,
  input: { id: string; owner: string },
  state: "sent" | "dead",
) => {
  const rows = await drizzle(db)
    .update(outbox)
    .set({ state, updatedAt: iso() })
    .where(
      and(eq(outbox.id, input.id), eq(outbox.leaseOwner, input.owner), eq(outbox.state, "sending")),
    )
    .returning({ id: outbox.id });
  return rows.length === 1;
};

export const markOutboxSent = (db: D1Database, input: { id: string; owner: string }) =>
  settleOutbox(db, input, "sent");

/** Gives up on a row; it stays for inspection and explicit replay (§6.3). */
export const markOutboxDead = (db: D1Database, input: { id: string; owner: string }) =>
  settleOutbox(db, input, "dead");

// ------------------------------------------------- Messages and inbox items

/** Appends with the next `seq`; a repeated (actor_id, client_message_id) returns the existing row. */
export const appendMessage = async (
  db: D1Database,
  input: {
    workspaceId: string;
    conversationId: string;
    actorId: string;
    clientMessageId: string;
    body: string;
  },
) => {
  const orm = drizzle(db);
  const [created] = await orm
    .insert(messages)
    .values({
      id: crypto.randomUUID(),
      ...input,
      seq: sql`(SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ${input.conversationId})`,
    })
    .onConflictDoNothing({ target: [messages.actorId, messages.clientMessageId] })
    .returning();
  if (created) return { created: true, message: created };
  const [existing] = await orm
    .select()
    .from(messages)
    .where(
      and(eq(messages.actorId, input.actorId), eq(messages.clientMessageId, input.clientMessageId)),
    );
  return { created: false, message: existing! };
};

/** Dedupe on logical input + recipient Bot + lane + purpose (§6.2); a duplicate returns the existing row. */
export const createInboxItem = async (
  db: D1Database,
  input: {
    workspaceId: string;
    inputId: string;
    botId: string;
    lane: string;
    purpose: string;
    conversationId?: string;
    deliveryId?: string;
  },
) => {
  const orm = drizzle(db);
  const dedupe = [
    inboxItems.workspaceId,
    inboxItems.inputId,
    inboxItems.botId,
    inboxItems.lane,
    inboxItems.purpose,
  ];
  const [created] = await orm
    .insert(inboxItems)
    .values({ id: crypto.randomUUID(), ...input })
    .onConflictDoNothing({ target: dedupe })
    .returning();
  if (created) return { created: true, item: created };
  const [existing] = await orm
    .select()
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.workspaceId, input.workspaceId),
        eq(inboxItems.inputId, input.inputId),
        eq(inboxItems.botId, input.botId),
        eq(inboxItems.lane, input.lane),
        eq(inboxItems.purpose, input.purpose),
      ),
    );
  return { created: false, item: existing! };
};

// ------------------------------------------------ Batchable statement forms
// For commands that commit Message, Event, Inbox, Receipt and Outbox in one batch (§11.1).
// Plain INSERTs: a duplicate violates a UNIQUE constraint, which fails and rolls back the batch.

/** Same `seq` rule as `appendMessage`. */
export const insertMessage = (
  db: D1Database,
  input: {
    id: string;
    workspaceId: string;
    conversationId: string;
    actorId: string;
    clientMessageId: string;
    body: string;
  },
) =>
  db
    .prepare(
      `INSERT INTO messages (id, workspace_id, conversation_id, seq, actor_id, client_message_id, body)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?), ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.workspaceId,
      input.conversationId,
      input.conversationId,
      input.actorId,
      input.clientMessageId,
      input.body,
    );

export const insertEvent = (db: D1Database, e: typeof events.$inferInsert) =>
  db
    .prepare(
      `INSERT INTO events (id, workspace_id, type, schema_version, source_kind, integration_id,
         external_event_id, source_device_id, actor_kind, actor_id, subject_kind, subject_id, data,
         correlation_id, causation_id, occurred_at, received_at, expires_at, logical_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      e.id,
      e.workspaceId,
      e.type,
      e.schemaVersion,
      e.sourceKind,
      e.integrationId ?? null,
      e.externalEventId ?? null,
      e.sourceDeviceId ?? null,
      e.actorKind,
      e.actorId,
      e.subjectKind ?? null,
      e.subjectId ?? null,
      JSON.stringify(e.data),
      e.correlationId,
      e.causationId ?? null,
      e.occurredAt,
      e.receivedAt,
      e.expiresAt ?? null,
      e.logicalKey ?? null,
    );

type InboxInput = {
  id: string;
  workspaceId: string;
  inputId: string;
  botId: string;
  lane: string;
  purpose: string;
  conversationId: string | null;
  deliveryMode: "wake" | "notify" | "batch";
};

export const insertInboxItem = (db: D1Database, input: InboxInput) =>
  db
    .prepare(
      `INSERT INTO inbox_items (id, workspace_id, input_id, bot_id, conversation_id, lane, purpose, delivery_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.workspaceId,
      input.inputId,
      input.botId,
      input.conversationId,
      input.lane,
      input.purpose,
      input.deliveryMode,
    );

/**
 * A queued Job; UNIQUE (workspace_id, trigger_key) makes it idempotent. Placement is `placement` when given,
 * else the Bot's policy snapshot.
 */
export const createJob = (
  db: D1Database,
  input: {
    id: string;
    workspaceId: string;
    botId: string;
    triggerKey: string;
    taskId?: string;
    inboxBatchId?: string;
    placement?: unknown;
  },
) =>
  db
    .prepare(
      `INSERT INTO jobs (id, workspace_id, bot_id, state, trigger_key, task_id, inbox_batch_id, placement)
       VALUES (?, ?, ?, 'queued', ?, ?, ?,
         COALESCE(?, (SELECT placement_policy FROM bots WHERE workspace_id = ? AND id = ?)))`,
    )
    .bind(
      input.id,
      input.workspaceId,
      input.botId,
      input.triggerKey,
      input.taskId ?? null,
      input.inboxBatchId ?? null,
      input.placement === undefined ? null : JSON.stringify(input.placement),
      input.workspaceId,
      input.botId,
    );

// ------------------------------------------------------------- Event route

export const eventRouter = { consumer: "event-router", handlerVersion: "1" } as const;

/** The router's consumer receipt. In an intake batch it marks an event that must never route (AT-27). */
export const insertConsumerReceipt = (db: D1Database, workspaceId: string, eventId: string) =>
  db
    .prepare(
      "INSERT INTO event_receipts (workspace_id, event_id, consumer, handler_version) VALUES (?, ?, ?, ?)",
    )
    .bind(workspaceId, eventId, eventRouter.consumer, eventRouter.handlerVersion);

const hasConsumerReceipt = async (db: D1Database, eventId: string) =>
  (await db
    .prepare(
      "SELECT 1 FROM event_receipts WHERE event_id = ? AND consumer = ? AND handler_version = ?",
    )
    .bind(eventId, eventRouter.consumer, eventRouter.handlerVersion)
    .first()) !== null;

/**
 * Runs the router's batch behind its consumer receipt. Returns false when the event was already routed
 * (receipt present before, or written by a concurrent consumer whose batch won).
 */
const routeOnce = async (
  db: D1Database,
  workspaceId: string,
  eventId: string,
  statements: D1PreparedStatement[],
) => {
  if (await hasConsumerReceipt(db, eventId)) return false;
  try {
    await db.batch([insertConsumerReceipt(db, workspaceId, eventId), ...statements]);
    return true;
  } catch (error) {
    if (await hasConsumerReceipt(db, eventId)) return false;
    throw error;
  }
};

/** An event with no recipients (no subscriptions yet): only the consumer receipt (§9.4, AT-06). */
export const recordEventRouted = (
  db: D1Database,
  input: { workspaceId: string; eventId: string },
) => routeOnce(db, input.workspaceId, input.eventId, []);

export type Recipient = InboxInput & {
  /** Change-log scope of the inbox item. */
  scope: string;
  matchedSubscriptionIds?: string[];
  /** `batch` mode: the open batch to create if (bot, lane) has none. */
  batch?: { sealAt: string; maxItems: number };
};

/**
 * One recipient's Delivery, Inbox item and (for `wake`) queued Job with trigger key `inbox:<id>`. The Inbox item may
 * already exist (agent.send writes it at intake): it is linked to the Delivery, and exactly one row must change. A
 * `batch` item joins the (bot, lane)'s open batch, opened here if there is none; the pump seals it.
 */
const deliveryStatements = (
  db: D1Database,
  input: Recipient & { eventId: string },
  deliveryId: string,
  jobId: string | null,
) => {
  const [setGuard, clearGuard] = guard(db);
  const now = iso();
  const lane = [input.workspaceId, input.botId, input.lane];
  const openBatch =
    "SELECT id FROM inbox_batches WHERE workspace_id = ? AND bot_id = ? AND lane = ? AND state = 'open'";
  const batch = input.deliveryMode === "batch" ? input.batch : undefined;
  if (input.deliveryMode === "batch" && !batch)
    throw new Error("batch delivery needs batch settings");
  return [
    db
      .prepare(
        `INSERT INTO event_deliveries (id, workspace_id, event_id, bot_id, lane, purpose, matched_subscription_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        deliveryId,
        input.workspaceId,
        input.eventId,
        input.botId,
        input.lane,
        input.purpose,
        JSON.stringify(input.matchedSubscriptionIds ?? []),
      ),
    ...(batch
      ? [
          db
            .prepare(
              `INSERT INTO inbox_batches (id, workspace_id, bot_id, lane, seal_at, max_items) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (workspace_id, bot_id, lane) WHERE state = 'open' DO NOTHING`,
            )
            .bind(crypto.randomUUID(), ...lane, batch.sealAt, batch.maxItems),
          db
            .prepare(
              `UPDATE inbox_batches SET item_count = item_count + 1, updated_at = ? WHERE id = (${openBatch})`,
            )
            .bind(now, ...lane),
        ]
      : []),
    db
      .prepare(
        `INSERT INTO inbox_items (id, workspace_id, input_id, bot_id, conversation_id, lane, purpose, delivery_mode,
           delivery_id, batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${batch ? `(${openBatch})` : "NULL"})
         ON CONFLICT (workspace_id, input_id, bot_id, lane, purpose)
         DO UPDATE SET delivery_id = excluded.delivery_id, updated_at = ?
         WHERE inbox_items.delivery_id IS NULL`,
      )
      .bind(
        input.id,
        input.workspaceId,
        input.inputId,
        input.botId,
        input.conversationId,
        input.lane,
        input.purpose,
        input.deliveryMode,
        deliveryId,
        ...(batch ? lane : []),
        now,
      ),
    setGuard,
    clearGuard,
    appendChange(db, {
      workspaceId: input.workspaceId,
      entityKind: "inbox_item",
      entityId: input.id,
      scope: input.scope,
    }),
    ...(jobId
      ? [
          createJob(db, {
            id: jobId,
            workspaceId: input.workspaceId,
            botId: input.botId,
            triggerKey: `inbox:${input.id}`,
          }),
          appendChange(db, {
            workspaceId: input.workspaceId,
            entityKind: "job",
            entityId: jobId,
            revision: 1,
            scope: `workspace:${input.workspaceId}`,
          }),
        ]
      : []),
  ];
};

/**
 * Event route (§11.1): consumer receipt plus every recipient's Delivery, Inbox item and Job in one batch. Returns
 * `{routed: false}` when the event was already routed.
 */
export const routeToRecipients = async (
  db: D1Database,
  input: { workspaceId: string; eventId: string; recipients: Omit<Recipient, "workspaceId">[] },
): Promise<
  { routed: false } | { routed: true; deliveries: { deliveryId: string; jobId: string | null }[] }
> => {
  const deliveries = input.recipients.map((r) => ({
    deliveryId: crypto.randomUUID(),
    jobId: r.deliveryMode === "wake" ? crypto.randomUUID() : null,
  }));
  const statements = input.recipients.flatMap((r, i) =>
    deliveryStatements(
      db,
      { ...r, workspaceId: input.workspaceId, eventId: input.eventId },
      deliveries[i]!.deliveryId,
      deliveries[i]!.jobId,
    ),
  );
  const routed = await routeOnce(db, input.workspaceId, input.eventId, statements);
  return routed ? { routed: true, deliveries } : { routed: false };
};

/** A single recipient (agent.send). */
export const createDeliveryAndInbox = async (
  db: D1Database,
  input: InboxInput & { eventId: string; scope: string },
): Promise<{ routed: false } | { routed: true; deliveryId: string; jobId: string | null }> => {
  const { workspaceId, eventId, ...recipient } = input;
  const result = await routeToRecipients(db, { workspaceId, eventId, recipients: [recipient] });
  return result.routed ? { routed: true, ...result.deliveries[0]! } : result;
};

// ------------------------------------------------------------ Inbox batches

/**
 * Seals open batches whose `seal_at` passed or that reached `max_items`, each with its one queued Job
 * (`trigger_key = batch:<id>`, `inbox_batch_id`) in one guarded batch. A batch sealed concurrently is skipped.
 */
export const sealDueBatches = async (db: D1Database, limit = 50) => {
  const now = iso();
  const { results } = await db
    .prepare(
      `SELECT id, workspace_id, bot_id FROM inbox_batches
        WHERE state = 'open' AND (seal_at <= ? OR item_count >= max_items) ORDER BY seal_at LIMIT ?`,
    )
    .bind(now, limit)
    .all<{ id: string; workspace_id: string; bot_id: string }>();
  const sealed = await Promise.all(
    results.map(async (batch) => {
      const jobId = crypto.randomUUID();
      const [setGuard, clearGuard] = guard(db);
      try {
        await db.batch([
          db
            .prepare(
              "UPDATE inbox_batches SET state = 'sealed', updated_at = ? WHERE id = ? AND state = 'open'",
            )
            .bind(now, batch.id),
          setGuard,
          clearGuard,
          createJob(db, {
            id: jobId,
            workspaceId: batch.workspace_id,
            botId: batch.bot_id,
            triggerKey: `batch:${batch.id}`,
            inboxBatchId: batch.id,
          }),
          appendChange(db, {
            workspaceId: batch.workspace_id,
            entityKind: "job",
            entityId: jobId,
            revision: 1,
            scope: `workspace:${batch.workspace_id}`,
          }),
        ]);
        return { workspaceId: batch.workspace_id, batchId: batch.id, jobId };
      } catch (error) {
        const row = await db
          .prepare("SELECT state FROM inbox_batches WHERE id = ?")
          .bind(batch.id)
          .first<{ state: string }>();
        if (row?.state === "sealed") return null;
        throw error;
      }
    }),
  );
  return sealed.filter((s) => s !== null);
};
