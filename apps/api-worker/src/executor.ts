// Executor routes (docs/architecture.md §9.2, §10.3, §22.3): device principal only.
import {
  commandEnvelope,
  ExecutorCommand,
  type ExecutorRun,
  type JobClaimed,
  type JobClaim,
  type LeaseRenewed,
  type PlacementPolicy,
  type QueuedJob,
  type RunLeaseRenew,
  type RunResultAccepted,
  type RunContext,
  type RunObservation,
  type RunResultSubmit,
} from "@hive/contracts";
import { appendChange, claimJob, finishRun, insertMessage, renewLease } from "@hive/db";
import type * as v from "valibot";
import type { Principal } from "./auth/principal.ts";
import { HttpError } from "./errors.ts";

export const ExecutorEnvelope = commandEnvelope(ExecutorCommand);
type Envelope = v.InferOutput<typeof ExecutorEnvelope>;
type Command = Envelope["command"];
export type Device = Extract<Principal, { kind: "device" }>;
type Handler<T extends Command> = (
  db: D1Database,
  device: Device,
  envelope: Envelope & { command: T },
) => Promise<{ status: number; response: unknown; scopes?: string[] }>;

/** docs/roadmap.md §1 defaults. */
export const leaseSeconds = 90;
const activeRunStates = new Set(["starting", "running", "waiting_approval", "stopping"]);
const activeRunStatesSql = `(${[...activeRunStates].map((s) => `'${s}'`).join(", ")})`;

/**
 * Placement (§10.2) as a safety constraint: a non-empty `allowedDeviceIds` is always intersected, whatever
 * the mode; an empty list means any device in the Workspace.
 */
const eligible = (placement: PlacementPolicy, deviceId: string) =>
  placement.allowedDeviceIds.length === 0 ||
  (placement.allowedDeviceIds as string[]).includes(deviceId);

type JobRow = {
  id: string;
  bot_id: string;
  revision: number;
  trigger_key: string;
  placement: string;
  created_at: string;
};
const jobColumns = "id, bot_id, revision, trigger_key, placement, created_at";

const toQueuedJob = (row: JobRow): QueuedJob => ({
  id: row.id,
  botId: row.bot_id,
  revision: row.revision,
  inboxItemId: row.trigger_key.startsWith("inbox:") ? row.trigger_key.slice(6) : null,
  placement: JSON.parse(row.placement) as PlacementPolicy,
  createdAt: row.created_at,
});

const notEligible = () =>
  new HttpError("FORBIDDEN", "device is not eligible for this job", false, "not_eligible");

const jobClaim: Handler<v.InferOutput<typeof JobClaim>> = async (db, device, env) => {
  const { workspaceId, command } = env;
  const row = await db
    .prepare(`SELECT ${jobColumns} FROM jobs WHERE workspace_id = ? AND id = ?`)
    .bind(workspaceId, command.jobId)
    .first<JobRow>();
  if (!row) throw new HttpError("NOT_FOUND", "job not found");
  const job = toQueuedJob(row);
  if (!eligible(job.placement, device.deviceId)) throw notEligible();
  // Job state is not checked here: the claim CAS decides, and a replay must reach the stored receipt.
  const result = await claimJob(db, {
    workspaceId,
    jobId: job.id,
    deviceId: device.deviceId,
    expectedRevision: command.expectedRevision,
    leaseSeconds,
    resourceKeys: command.resourceKeys ?? [`bot:${job.botId}`],
    operationId: env.idempotencyKey,
  });
  if (!result.ok) {
    if (result.reason === "resource_busy") {
      throw new HttpError(
        "RESOURCE_BUSY",
        "a resource is reserved by another run",
        true,
        "resource_busy",
      );
    }
    const message =
      result.reason === "already_claimed" ? `job is ${result.jobState}` : "job revision changed";
    throw new HttpError("REVISION_CONFLICT", message, false, result.reason);
  }
  const response: JobClaimed = {
    runId: result.runId,
    executionId: result.executionId,
    executionGeneration: result.generation,
    leaseExpiresAt: result.leaseExpiresAt,
    job: { id: job.id, botId: job.botId, inboxItemId: job.inboxItemId, placement: job.placement },
  };
  return { status: 200, response, scopes: [`workspace:${workspaceId}`] };
};

const staleGeneration = () =>
  new HttpError("STALE_GENERATION", "run generation is not current", false, "stale_generation");

const runLeaseRenew: Handler<v.InferOutput<typeof RunLeaseRenew>> = async (db, device, env) => {
  const result = await renewLease(db, {
    runId: env.command.runId,
    deviceId: device.deviceId,
    executionGeneration: env.command.executionGeneration,
    leaseSeconds,
  });
  if (!result.ok) throw staleGeneration();
  const response: LeaseRenewed = { leaseExpiresAt: result.leaseExpiresAt };
  return { status: 200, response };
};

/** Run completion plus the Inbox outcome of the Job's trigger item, in `finishRun`'s batch (§11.1). */
const runResultSubmit: Handler<v.InferOutput<typeof RunResultSubmit>> = async (db, device, env) => {
  const { workspaceId, command } = env;
  // The trigger item's channel names its change scope; an item without a conversation is workspace-wide.
  const item = await db
    .prepare(
      `SELECT i.id, i.conversation_id, c.channel_id, b.actor_id FROM runs r
         JOIN jobs j ON j.workspace_id = r.workspace_id AND j.id = r.job_id
         JOIN bots b ON b.workspace_id = j.workspace_id AND b.id = j.bot_id
         JOIN inbox_items i ON i.workspace_id = j.workspace_id AND 'inbox:' || i.id = j.trigger_key
         LEFT JOIN conversations c ON c.workspace_id = i.workspace_id AND c.id = i.conversation_id
        WHERE r.id = ? AND r.workspace_id = ?`,
    )
    .bind(command.runId, workspaceId)
    .first<{
      id: string;
      conversation_id: string | null;
      channel_id: string | null;
      actor_id: string;
    }>();
  const itemScope = item?.channel_id ? `channel:${item.channel_id}` : `workspace:${workspaceId}`;
  const inboxOutcome = db
    .prepare(
      `UPDATE inbox_items SET state = ?, updated_at = ?
        WHERE workspace_id = ? AND id = (
          SELECT substr(j.trigger_key, 7) FROM runs r
            JOIN jobs j ON j.workspace_id = r.workspace_id AND j.id = r.job_id
           WHERE r.id = ? AND j.trigger_key LIKE 'inbox:%')`,
    )
    // ponytail: schema state `processed` is the design's `handled` (§7.1); renaming needs a table rebuild.
    .bind(
      command.state === "succeeded" ? "processed" : "failed",
      new Date().toISOString(),
      workspaceId,
      command.runId,
    );
  // A Task Job's Execution gets an immutable Task Result for its scope revision. Task status is not touched:
  // Run success is not Task completion (AT-16). The Execution still goes `finished` / `failed`, not `submitted`.
  const execution = await db
    .prepare(
      "SELECT id FROM executions WHERE workspace_id = ? AND run_id = ? AND task_id IS NOT NULL",
    )
    .bind(workspaceId, command.runId)
    .first<{ id: string }>();
  const resultId = crypto.randomUUID();
  const taskResult = execution
    ? [
        db
          .prepare(
            `INSERT INTO task_results (id, workspace_id, task_id, execution_id, run_id, scope_revision, state, summary)
             SELECT ?, workspace_id, task_id, id, run_id, task_scope_revision, ?, ? FROM executions WHERE id = ?`,
          )
          .bind(resultId, command.state, command.summary, execution.id),
        appendChange(db, {
          workspaceId,
          entityKind: "task_result",
          entityId: resultId,
          scope: `workspace:${workspaceId}`,
        }),
      ]
    : [];
  // The Run's capability decides where the Bot may reply: only in its trigger item's Conversation (§8.1).
  const { reply } = command;
  if (reply && (!item?.channel_id || item.conversation_id !== reply.conversationId)) {
    throw new HttpError("FORBIDDEN", "reply must go to the trigger item's conversation");
  }
  const messageId = crypto.randomUUID();
  const replyMessage =
    reply && item?.channel_id
      ? [
          insertMessage(db, {
            id: messageId,
            workspaceId,
            conversationId: reply.conversationId,
            actorId: item.actor_id,
            clientMessageId: `run:${command.runId}`,
            body: reply.text,
          }),
          appendChange(db, {
            workspaceId,
            entityKind: "message",
            entityId: messageId,
            scope: itemScope,
          }),
        ]
      : [];
  const result = await finishRun(db, {
    runId: command.runId,
    deviceId: device.deviceId,
    executionGeneration: command.executionGeneration,
    state: command.state,
    summary: command.summary,
    error: command.error,
    operationId: env.idempotencyKey,
    statements: item
      ? [
          ...taskResult,
          ...replyMessage,
          inboxOutcome,
          appendChange(db, {
            workspaceId,
            entityKind: "inbox_item",
            entityId: item.id,
            scope: itemScope,
          }),
        ]
      : [...taskResult, inboxOutcome],
  });
  if (!result.ok) throw staleGeneration();
  const response: RunResultAccepted = { ok: true };
  return { status: 200, response, scopes: [...new Set([`workspace:${workspaceId}`, itemScope])] };
};

const handlers: { [T in Command["type"]]: Handler<Extract<Command, { type: T }>> } = {
  "job.claim": jobClaim,
  "run.lease.renew": runLeaseRenew,
  "run.result.submit": runResultSubmit,
};

export const runExecutorCommand = (db: D1Database, device: Device, envelope: Envelope) => {
  if (!device.workspaceIds.includes(envelope.workspaceId)) {
    throw new HttpError("FORBIDDEN", "device is not registered in this workspace");
  }
  return (handlers[envelope.command.type] as Handler<Command>)(db, device, envelope);
};

// ponytail: placement is filtered after LIMIT, so a page can hold fewer than `limit` eligible Jobs;
// filter in SQL (json_each) or page with a cursor if devices get pinned out of many Jobs.
export const listQueuedJobs = async (db: D1Database, device: Device, limit: number) => {
  const { results } = await db
    .prepare(
      `SELECT ${jobColumns} FROM jobs WHERE workspace_id = ? AND state = 'queued'
        ORDER BY created_at, id LIMIT ?`,
    )
    .bind(device.workspaceIds[0], limit)
    .all<JobRow>();
  return {
    jobs: results.map(toQueuedJob).filter((job) => eligible(job.placement, device.deviceId)),
  };
};

export const getExecutorRun = async (db: D1Database, device: Device, id: string) => {
  const row = await db
    .prepare(
      `SELECT id, job_id, state, execution_generation FROM runs
        WHERE id = ? AND workspace_id = ? AND device_id = ?`,
    )
    .bind(id, device.workspaceIds[0], device.deviceId)
    .first<{ id: string; job_id: string; state: string; execution_generation: number }>();
  if (!row) throw new HttpError("NOT_FOUND", "run not found");
  const run: ExecutorRun = {
    id: row.id,
    jobId: row.job_id,
    state: row.state,
    executionGeneration: row.execution_generation,
    active: activeRunStates.has(row.state),
  };
  return run;
};

/** Fenced: the device's own active Run of `jobId` at `executionGeneration`, else 404 / 409. */
const fencedRun = async (
  db: D1Database,
  device: Device,
  fence: { runId: string; executionGeneration: number; jobId?: string },
) => {
  const run = await db
    .prepare(
      "SELECT job_id, state, execution_generation FROM runs WHERE id = ? AND workspace_id = ? AND device_id = ?",
    )
    .bind(fence.runId, device.workspaceIds[0], device.deviceId)
    .first<{ job_id: string; state: string; execution_generation: number }>();
  if (!run || (fence.jobId !== undefined && run.job_id !== fence.jobId)) {
    throw new HttpError("NOT_FOUND", "run not found");
  }
  if (run.execution_generation !== fence.executionGeneration || !activeRunStates.has(run.state)) {
    throw staleGeneration();
  }
  return run;
};

/** Run context (SDK-01): Bot instructions, Task, recent Conversation and the trigger item's body. */
export const getRunContext = async (
  db: D1Database,
  device: Device,
  input: { jobId: string; runId: string; executionGeneration: number },
): Promise<RunContext> => {
  await fencedRun(db, device, input);
  const workspaceId = device.workspaceIds[0];
  const row = await db
    .prepare(
      `SELECT b.id AS bot_id, b.name, b.instructions, t.key, t.title, t.description,
              i.id AS item_id, i.conversation_id, c.channel_id,
              COALESCE(m.body, e.data) AS body
         FROM jobs j
         JOIN bots b ON b.workspace_id = j.workspace_id AND b.id = j.bot_id
         LEFT JOIN tasks t ON t.workspace_id = j.workspace_id AND t.id = j.task_id
         LEFT JOIN inbox_items i ON i.workspace_id = j.workspace_id AND 'inbox:' || i.id = j.trigger_key
         LEFT JOIN conversations c ON c.workspace_id = i.workspace_id AND c.id = i.conversation_id
         LEFT JOIN events e ON e.workspace_id = i.workspace_id AND e.id = i.input_id
         LEFT JOIN messages m ON m.workspace_id = e.workspace_id AND e.subject_kind = 'message'
                             AND m.id = e.subject_id
        WHERE j.workspace_id = ? AND j.id = ?`,
    )
    .bind(workspaceId, input.jobId)
    .first<{
      bot_id: string;
      name: string;
      instructions: string;
      key: string | null;
      title: string | null;
      description: string | null;
      item_id: string | null;
      conversation_id: string | null;
      channel_id: string | null;
      body: string | null;
    }>();
  if (!row) throw new HttpError("NOT_FOUND", "job not found");
  let conversation: RunContext["conversation"] = null;
  if (row.conversation_id && row.channel_id) {
    const { results } = await db
      .prepare(
        `SELECT actorKind, actorId, body, createdAt FROM (
           SELECT a.kind AS actorKind, a.id AS actorId, m.body, m.created_at AS createdAt, m.seq
             FROM messages m JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
            WHERE m.workspace_id = ? AND m.conversation_id = ? ORDER BY m.seq DESC LIMIT 20
         ) ORDER BY seq`,
      )
      .bind(workspaceId, row.conversation_id)
      .all<NonNullable<RunContext["conversation"]>["recent"][number]>();
    conversation = {
      id: row.conversation_id,
      channelId: row.channel_id,
      recent: results,
    };
  }
  return {
    bot: { id: row.bot_id, name: row.name, instructions: row.instructions },
    task:
      row.key === null
        ? null
        : { key: row.key, title: row.title ?? "", description: row.description ?? "" },
    conversation,
    inboxItem: row.item_id ? { id: row.item_id, body: row.body ?? "" } : null,
  };
};

/** Executor observations (§9.2 step 7). Only `runtime.run.started` is stored, fenced like a renew. */
export const recordObservation = async (db: D1Database, device: Device, input: RunObservation) => {
  const providerSessionId = input.payload?.providerSessionId;
  if (input.kind !== "runtime.run.started") return { status: 202 as const, body: { ok: true } };
  if (typeof providerSessionId !== "string" || providerSessionId === "") {
    throw new HttpError("INVALID_INPUT", "payload.providerSessionId is required");
  }
  const { meta } = await db
    .prepare(
      `UPDATE runs SET provider_session_id = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND device_id = ? AND execution_generation = ?
          AND state IN ${activeRunStatesSql}`,
    )
    .bind(
      providerSessionId,
      new Date().toISOString(),
      input.runId,
      device.workspaceIds[0],
      device.deviceId,
      input.executionGeneration,
    )
    .run();
  if (meta.changes === 0) await fencedRun(db, device, input);
  return { status: 200 as const, body: { ok: true } };
};

export const heartbeat = async (db: D1Database, device: Device) => {
  const now = new Date().toISOString();
  await db
    .prepare("UPDATE devices SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?")
    .bind(now, now, device.deviceId)
    .run();
  return { lastHeartbeatAt: now };
};
