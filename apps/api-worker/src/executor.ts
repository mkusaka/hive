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
  type RunResultSubmit,
} from "@hive/contracts";
import { appendChange, claimJob, finishRun, renewLease } from "@hive/db";
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
      `SELECT i.id, c.channel_id FROM runs r
         JOIN jobs j ON j.workspace_id = r.workspace_id AND j.id = r.job_id
         JOIN inbox_items i ON i.workspace_id = j.workspace_id AND 'inbox:' || i.id = j.trigger_key
         LEFT JOIN conversations c ON c.workspace_id = i.workspace_id AND c.id = i.conversation_id
        WHERE r.id = ? AND r.workspace_id = ?`,
    )
    .bind(command.runId, workspaceId)
    .first<{ id: string; channel_id: string | null }>();
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
          inboxOutcome,
          appendChange(db, {
            workspaceId,
            entityKind: "inbox_item",
            entityId: item.id,
            scope: itemScope,
          }),
        ]
      : [inboxOutcome],
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

export const heartbeat = async (db: D1Database, device: Device) => {
  const now = new Date().toISOString();
  await db
    .prepare("UPDATE devices SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?")
    .bind(now, now, device.deviceId)
    .run();
  return { lastHeartbeatAt: now };
};
