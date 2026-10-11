// Executor routes (docs/architecture.md §9.2, §10.3, §22.3): device principal only.
import {
  commandEnvelope,
  ExecutorCommand,
  type ExecutorHeartbeat,
  GitCollected,
  type ExecutorRun,
  type JobClaimed,
  type JobClaim,
  type LeaseRenewed,
  parse,
  type PlacementPolicy,
  type QueuedJob,
  type RunLeaseRenew,
  type RunResultAccepted,
  type RunContext,
  type ContextSnapshot,
  type RunObservation,
  type RunResultSubmit,
  type ToolPolicy,
  renderMentions,
} from "@hive/contracts";
import {
  appendChange,
  claimJob,
  confirmRunStopped,
  finishRun,
  insertMessage,
  createJob,
  guard,
  renewLease,
  setJobsWaitingDevice,
} from "@hive/db";
import type * as v from "valibot";
import { hashSecret, newDeviceSecret } from "./auth/device.ts";
import type { Principal } from "./auth/principal.ts";
import { capabilityExpiresAt, insertCapability } from "./auth/run.ts";
import { HttpError } from "./errors.ts";
import { constraintReasons, type PlacementDevice, refusal, shouldWait } from "./placement.ts";
import {
  botSearchAccess,
  conversationReadableSql,
  indexLater,
  memoryProvenance,
  memoryReadableSql,
  relatedQuery,
  searchDocuments,
  sourcesReadableSql,
  type SearchAccess,
} from "./search.ts";

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
const memoryContextBytes = 8 * 1024;
const activeRunStates = new Set(["starting", "running", "waiting_approval", "stopping"]);
const activeRunStatesSql = `(${[...activeRunStates].map((s) => `'${s}'`).join(", ")})`;

/** The Workspace's non-revoked devices as placement sees them (placement.ts). */
export const placementDevices = async (db: D1Database, workspaceId: string) => {
  const { results } = await db
    .prepare(
      `SELECT d.id, d.last_heartbeat_at, d.capabilities, d.capacity_background,
              (SELECT json_group_array(e.name) FROM device_environments e
                WHERE e.workspace_id = d.workspace_id AND e.device_id = d.id) AS environments,
              (SELECT COUNT(*) FROM runs r
                WHERE r.workspace_id = d.workspace_id AND r.device_id = d.id AND r.kind = 'root'
                  AND r.state IN ${activeRunStatesSql}) AS active
         FROM devices d WHERE d.workspace_id = ? AND d.revoked_at IS NULL`,
    )
    .bind(workspaceId)
    .all<{
      id: string;
      last_heartbeat_at: string | null;
      capabilities: string;
      capacity_background: number;
      environments: string;
      active: number;
    }>();
  return results.map((r): PlacementDevice => ({
    id: r.id,
    lastHeartbeatAt: r.last_heartbeat_at,
    capabilities: JSON.parse(r.capabilities) as string[],
    environments: JSON.parse(r.environments) as string[],
    capacity: r.capacity_background,
    active: r.active,
  }));
};

/** The offer rule (placement.ts) for the calling device; null when it may take the Job. */
const refusalFor = (placement: PlacementPolicy, devices: PlacementDevice[], deviceId: string) => {
  const self = devices.find((d) => d.id === deviceId);
  return self ? refusal(placement, devices, self, Date.now()) : "not_allowed";
};

type JobRow = {
  id: string;
  bot_id: string;
  state: string;
  revision: number;
  trigger_key: string;
  job_kind: "normal" | "summarize" | "consolidate";
  placement: string;
  task_id: string | null;
  created_at: string;
};
const jobColumns =
  "id, bot_id, state, revision, trigger_key, job_kind, placement, task_id, created_at";

const toQueuedJob = (row: JobRow): QueuedJob => ({
  id: row.id,
  botId: row.bot_id,
  revision: row.revision,
  jobKind: row.job_kind,
  inboxItemId: row.trigger_key.startsWith("inbox:") ? row.trigger_key.slice(6) : null,
  placement: JSON.parse(row.placement) as PlacementPolicy,
  createdAt: row.created_at,
});

/** `at_capacity` is a 409 the device may retry; every other refusal is a 403 `not_eligible` naming the rule. */
const refused = (reason: string) =>
  reason === "at_capacity"
    ? new HttpError("RESOURCE_BUSY", "device is at capacity", true, "at_capacity")
    : new HttpError(
        "FORBIDDEN",
        `device is not eligible for this job: ${reason}`,
        false,
        "not_eligible",
      );

const jobClaim: Handler<v.InferOutput<typeof JobClaim>> = async (db, device, env) => {
  const { workspaceId, command } = env;
  const row = await db
    .prepare(`SELECT ${jobColumns} FROM jobs WHERE workspace_id = ? AND id = ?`)
    .bind(workspaceId, command.jobId)
    .first<JobRow>();
  if (!row) throw new HttpError("NOT_FOUND", "job not found");
  const job = toQueuedJob(row);
  const { results: jobSources } = await db
    .prepare(
      `SELECT DISTINCT c.id, c.channel_id FROM jobs j
      LEFT JOIN inbox_items i ON i.workspace_id = j.workspace_id AND ('inbox:' || i.id = j.trigger_key OR i.batch_id = j.inbox_batch_id)
      LEFT JOIN delegations d ON d.workspace_id = j.workspace_id AND d.id = j.delegation_id
      JOIN conversations c ON c.workspace_id = j.workspace_id AND c.id = COALESCE(j.conversation_id, i.conversation_id, d.conversation_id)
      WHERE j.workspace_id = ? AND j.id = ?`,
    )
    .bind(workspaceId, job.id)
    .all<{ id: string; channel_id: string }>();
  const sourceIds = jobSources.map((c) => c.id);
  const claimAccess: SearchAccess =
    row.job_kind === "normal"
      ? {
          workspaceId,
          botId: row.bot_id,
          jobId: job.id,
          allBotsAndTasks: false,
          scopes: [
            `workspace:${workspaceId}`,
            `bot:${row.bot_id}`,
            ...jobSources.map((c) => `channel:${c.channel_id}`),
          ],
        }
      : await botSearchAccess(db, workspaceId, row.bot_id);
  await requireConversationAccess(db, claimAccess, sourceIds);
  // Re-validated here (§9.2 step 3) so a stale list cannot bypass the offer rule. Only a claimable Job: a replay of
  // a claim that went through must reach its receipt even though the device now holds that Run.
  if (row.state === "queued" || row.state === "waiting_device") {
    const reason = refusalFor(
      job.placement,
      await placementDevices(db, workspaceId),
      device.deviceId,
    );
    if (reason) throw refused(reason);
  }
  // The Run capability (§18.2) is committed with the claim. Task writes need a Task Job.
  const secret = newDeviceSecret();
  const tokenHash = await hashSecret(secret);
  const scopes =
    row.job_kind === "summarize"
      ? ["summary.write"]
      : row.job_kind === "consolidate"
        ? ["memory.write", "memory.delete"]
        : [
            "agent.send",
            "agent.reply",
            "task.read",
            "memory.write",
            "search.read",
            ...(row.task_id ? ["task.write"] : []),
          ];
  // Job state is not checked here: the claim CAS decides, and a replay must reach the stored receipt.
  const result = await claimJob(db, {
    workspaceId,
    jobId: job.id,
    deviceId: device.deviceId,
    expectedRevision: command.expectedRevision,
    leaseSeconds,
    resourceKeys: command.resourceKeys ?? [`bot:${job.botId}`],
    operationId: env.idempotencyKey,
    statements: (claim) => [
      db
        .prepare(
          `INSERT INTO atomic_guards (operation_id, ok) VALUES (?, ${sourcesReadableSql(claimAccess, sourceIds)})`,
        )
        .bind(`${claim.runId}:source-access`),
      db
        .prepare("DELETE FROM atomic_guards WHERE operation_id = ?")
        .bind(`${claim.runId}:source-access`),
      insertCapability(db, {
        workspaceId,
        runId: claim.runId,
        executionGeneration: claim.generation,
        tokenHash,
        scopes,
        expiresAt: capabilityExpiresAt(claim.leaseExpiresAt),
      }),
    ],
  });
  if (!result.ok) {
    if (result.reason === "at_capacity") throw refused(result.reason);
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
    // Like a device token, the secret is returned once: a replayed claim has none (the run goes without tools).
    capability: result.replayed
      ? null
      : {
          token: `cap.${result.runId}.${secret}`,
          expiresAt: capabilityExpiresAt(result.leaseExpiresAt),
        },
    job: { id: job.id, botId: job.botId, inboxItemId: job.inboxItemId, placement: job.placement },
  };
  return { status: 200, response, scopes: [`workspace:${workspaceId}`] };
};

const staleGeneration = () =>
  new HttpError("STALE_GENERATION", "run generation is not current", false, "stale_generation");

/** Whether a user asked to cancel the Run's Job (job.cancel, §9.3). */
const cancelRequested = async (db: D1Database, workspaceId: string, runId: string) =>
  (await db
    .prepare(
      `SELECT 1 FROM runs r JOIN jobs j ON j.workspace_id = r.workspace_id AND j.id = r.job_id
        WHERE r.id = ? AND r.workspace_id = ? AND j.cancel_requested_at IS NOT NULL`,
    )
    .bind(runId, workspaceId)
    .first()) !== null;

/** Renewal answers `cancelRequested`: the executor stops the agent and submits `failed` (§9.3). */
const runLeaseRenew: Handler<v.InferOutput<typeof RunLeaseRenew>> = async (db, device, env) => {
  const result = await renewLease(db, {
    runId: env.command.runId,
    deviceId: device.deviceId,
    executionGeneration: env.command.executionGeneration,
    leaseSeconds,
  });
  if (!result.ok) throw staleGeneration();
  await db
    .prepare("UPDATE run_capabilities SET expires_at = ? WHERE run_id = ? AND revoked_at IS NULL")
    .bind(capabilityExpiresAt(result.leaseExpiresAt), env.command.runId)
    .run();
  const response: LeaseRenewed = {
    leaseExpiresAt: result.leaseExpiresAt,
    cancelRequested: await cancelRequested(db, env.workspaceId, env.command.runId),
  };
  return { status: 200, response };
};

/** The Run's capability ends with its result. */
const revokeCapability = (db: D1Database, runId: string) =>
  db
    .prepare("UPDATE run_capabilities SET revoked_at = ? WHERE run_id = ? AND revoked_at IS NULL")
    .bind(new Date().toISOString(), runId);

/**
 * `waiting` (§8.2, AT-29): the Run ends at a safe checkpoint, so it holds no slot or reservation while the other Bot
 * works. Its Inbox items stay pending for the successor Run. `waitingFor` must be a request this Job sent.
 */
const submitWaiting = async (
  db: D1Database,
  device: Device,
  env: Envelope & { command: v.InferOutput<typeof RunResultSubmit> },
  requestMessageId: string,
) => {
  const { workspaceId, command } = env;
  const request = await db
    .prepare(
      `SELECT 1 FROM messages m JOIN runs r ON r.workspace_id = m.workspace_id AND r.job_id = m.job_id
        WHERE r.id = ? AND r.workspace_id = ? AND m.id = ? AND m.kind = 'request'`,
    )
    .bind(command.runId, workspaceId, requestMessageId)
    .first();
  if (!request) {
    throw new HttpError(
      "INVALID_INPUT",
      "waitingFor must be a request message this job sent",
      false,
      "unknown_request",
    );
  }
  // A reply older than this Run was already in its context: waiting again would re-queue the Job at once, forever.
  // A reply that arrived while the Run worked is the race finishRun turns into an immediate `queued`.
  const answered = await db
    .prepare(
      `SELECT 1 FROM messages m JOIN runs r ON r.id = ?
        WHERE m.workspace_id = ? AND m.reply_to_message_id = ? AND m.created_at < r.created_at`,
    )
    .bind(command.runId, workspaceId, requestMessageId)
    .first();
  if (answered) {
    throw new HttpError(
      "INVALID_INPUT",
      "that request was already answered before this run",
      false,
      "already_replied",
    );
  }
  const result = await finishRun(db, {
    runId: command.runId,
    deviceId: device.deviceId,
    executionGeneration: command.executionGeneration,
    state: "succeeded",
    summary: command.summary,
    waitingFor: requestMessageId,
    operationId: env.idempotencyKey,
    statements: [revokeCapability(db, command.runId)],
  });
  if (!result.ok) throw staleGeneration();
  const response: RunResultAccepted = { ok: true };
  return { status: 200, response, scopes: [`workspace:${workspaceId}`] };
};

/**
 * Run completion plus the Inbox outcome of the Job's input items, in `finishRun`'s batch (§11.1). A `failed` Run of
 * a Job with a cancel request finishes `cancelled` (Run and Job); so does a `waiting` one.
 */
const runResultSubmit: Handler<v.InferOutput<typeof RunResultSubmit>> = async (db, device, env) => {
  const { workspaceId, command } = env;
  if ((command.state === "waiting") !== (command.waitingFor !== undefined)) {
    throw new HttpError(
      "INVALID_INPUT",
      "waitingFor is required with state waiting, and only then",
    );
  }
  const cancel =
    command.state !== "succeeded" && (await cancelRequested(db, workspaceId, command.runId));
  if (command.waitingFor && !cancel) {
    return submitWaiting(db, device, env, command.waitingFor.requestMessageId);
  }
  const state = cancel ? "cancelled" : (command.state as "succeeded" | "failed");
  // The Job's input items: its trigger item, or every member of its sealed Inbox batch (one lane, so one
  // Conversation), plus the replies to its requests (§8.2). The channel names an item's change scope; an item without
  // a conversation is workspace-wide.
  const { results: items } = await db
    .prepare(
      `SELECT i.id, i.conversation_id, c.channel_id, b.actor_id FROM runs r
         JOIN jobs j ON j.workspace_id = r.workspace_id AND j.id = r.job_id
         JOIN bots b ON b.workspace_id = j.workspace_id AND b.id = j.bot_id
         JOIN inbox_items i ON i.workspace_id = j.workspace_id
                           AND ('inbox:' || i.id = j.trigger_key OR i.batch_id = j.inbox_batch_id
                                OR (i.purpose = 'agent.reply' AND i.input_id IN (
                                      SELECT m.id FROM messages m JOIN messages q
                                          ON q.workspace_id = m.workspace_id AND q.id = m.reply_to_message_id
                                       WHERE q.workspace_id = j.workspace_id AND q.job_id = j.id)))
         LEFT JOIN conversations c ON c.workspace_id = i.workspace_id AND c.id = i.conversation_id
        WHERE r.id = ? AND r.workspace_id = ?
        ORDER BY i.created_at, i.id`,
    )
    .bind(command.runId, workspaceId)
    .all<{
      id: string;
      conversation_id: string | null;
      channel_id: string | null;
      actor_id: string;
    }>();
  const item = items[0];
  const scopeOf = (i: { channel_id: string | null } | undefined) =>
    i?.channel_id ? `channel:${i.channel_id}` : `workspace:${workspaceId}`;
  const itemScope = scopeOf(item);
  // Batch membership is fixed at seal, so the ids read here are the batch's.
  const inboxOutcome = db
    .prepare(
      `UPDATE inbox_items SET state = ?, updated_at = ?
        WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))`,
    )
    // ponytail: schema state `processed` is the design's `handled` (§7.1); renaming needs a table rebuild.
    .bind(
      state === "succeeded" ? "processed" : "failed",
      new Date().toISOString(),
      workspaceId,
      JSON.stringify(items.map((i) => i.id)),
    );
  // A Task Job's Execution gets an immutable Task Result for its scope revision. Task status is not touched:
  // Run success is not Task completion (AT-16). The Execution still goes `finished` / `failed`, not `submitted`.
  // A cancelled Run submits no Task Result.
  const execution = await db
    .prepare(
      "SELECT id FROM executions WHERE workspace_id = ? AND run_id = ? AND task_id IS NOT NULL",
    )
    .bind(workspaceId, command.runId)
    .first<{ id: string }>();
  const resultId = crypto.randomUUID();
  const taskResult =
    execution && state !== "cancelled"
      ? [
          db
            .prepare(
              `INSERT INTO task_results (id, workspace_id, task_id, execution_id, run_id, scope_revision, state, summary)
             SELECT ?, workspace_id, task_id, id, run_id, task_scope_revision, ?, ? FROM executions WHERE id = ?`,
            )
            .bind(resultId, state, command.summary, execution.id),
          appendChange(db, {
            workspaceId,
            entityKind: "task_result",
            entityId: resultId,
            scope: `workspace:${workspaceId}`,
          }),
        ]
      : [];
  // The Run's capability decides where the Bot may reply: only in its trigger item's Conversation (§8.1).
  const job = await db
    .prepare(
      "SELECT j.job_kind FROM jobs j JOIN runs r ON r.workspace_id = j.workspace_id AND r.job_id = j.id WHERE r.id = ? AND r.workspace_id = ?",
    )
    .bind(command.runId, workspaceId)
    .first<{ job_kind: string }>();
  if (command.reply && job?.job_kind !== "normal") {
    throw new HttpError("FORBIDDEN", "maintenance jobs cannot post replies");
  }
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
          indexLater(db, workspaceId, "message", messageId),
        ]
      : [];
  const result = await finishRun(db, {
    runId: command.runId,
    deviceId: device.deviceId,
    executionGeneration: command.executionGeneration,
    state,
    summary: command.summary,
    error: command.error,
    operationId: env.idempotencyKey,
    statements: [
      ...taskResult,
      ...replyMessage,
      inboxOutcome,
      revokeCapability(db, command.runId),
      ...items.map((i) =>
        appendChange(db, {
          workspaceId,
          entityKind: "inbox_item",
          entityId: i.id,
          scope: scopeOf(i),
        }),
      ),
    ],
  });
  if (!result.ok) throw staleGeneration();
  const response: RunResultAccepted = { ok: true };
  return {
    status: 200,
    response,
    scopes: [...new Set([`workspace:${workspaceId}`, ...items.map(scopeOf)])],
  };
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

// ponytail: placement is filtered after LIMIT, so a page can hold fewer than `limit` Jobs this device may take;
// page with a cursor if devices get ranked out of many Jobs.
/** Queued Jobs offered to this device now (placement.ts): none while it is at capacity. */
export const listQueuedJobs = async (db: D1Database, device: Device, limit: number) => {
  const workspaceId = device.workspaceIds[0]!;
  const { results } = await db
    .prepare(
      `SELECT ${jobColumns} FROM jobs WHERE workspace_id = ? AND state = 'queued'
        ORDER BY created_at, id LIMIT ?`,
    )
    .bind(workspaceId, limit)
    .all<JobRow>();
  const devices = await placementDevices(db, workspaceId);
  return {
    jobs: results
      .map(toQueuedJob)
      .filter((job) => refusalFor(job.placement, devices, device.deviceId) === null),
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

export const latestSummary = async (
  db: D1Database,
  workspaceId: string,
  conversationId: string,
  botId: string,
) => {
  const summary = await db
    .prepare(
      `SELECT id, conversation_id AS conversationId, bot_id AS botId, covers_from_seq AS coversFromSeq,
      covers_to_seq AS coversToSeq, text, pinned_facts AS pinnedFacts, revision,
      created_by_run_id AS createdByRunId, created_at AS createdAt
      FROM conversation_summaries WHERE workspace_id = ? AND conversation_id = ? AND (bot_id = ? OR bot_id IS NULL)
      ORDER BY covers_to_seq DESC, created_at DESC, id DESC LIMIT 1`,
    )
    .bind(workspaceId, conversationId, botId)
    .first<NonNullable<RunContext["summary"]>>();
  if (summary) summary.pinnedFacts = JSON.parse(summary.pinnedFacts as unknown as string);
  return summary;
};

export const activeSummaryJob = (db: D1Database, workspaceId: string, conversationId: string) =>
  db
    .prepare(
      `SELECT id FROM jobs WHERE workspace_id = ? AND conversation_id = ? AND job_kind = 'summarize'
    AND state IN ('queued', 'waiting_device', 'active', 'waiting_input', 'recovery_required')`,
    )
    .bind(workspaceId, conversationId)
    .first<{ id: string }>();

export const summaryRangeEnd = async (
  db: D1Database,
  workspaceId: string,
  conversationId: string,
  botId: string,
) => {
  const previous = await latestSummary(db, workspaceId, conversationId, botId);
  const range = await db
    .prepare(
      `SELECT MAX(seq) AS seq FROM (SELECT seq FROM messages WHERE workspace_id = ? AND conversation_id = ? AND seq > ?
      ORDER BY seq LIMIT 100)`,
    )
    .bind(workspaceId, conversationId, previous?.coversToSeq ?? 0)
    .first<{ seq: number | null }>();
  return range?.seq ?? null;
};

/** One active Job per conversation, shared by automatic and manual triggers; each retry is a new occurrence. */
export const enqueueSummary = async (
  db: D1Database,
  workspaceId: string,
  conversationId: string,
  botId: string,
) => {
  const existing = await activeSummaryJob(db, workspaceId, conversationId);
  if (existing) return existing.id;
  const end = await summaryRangeEnd(db, workspaceId, conversationId, botId);
  if (end === null) return null;
  const id = crypto.randomUUID();
  try {
    await db.batch([
      createJob(db, {
        id,
        workspaceId,
        botId,
        conversationId,
        jobKind: "summarize",
        triggerKey: `summary:${conversationId}:${id}:${end}`,
      }),
      appendChange(db, {
        workspaceId,
        entityKind: "job",
        entityId: id,
        revision: 1,
        scope: `workspace:${workspaceId}`,
      }),
    ]);
    return id;
  } catch (error) {
    const raced = await activeSummaryJob(db, workspaceId, conversationId);
    if (raced) return raced.id;
    throw error;
  }
};

export const contextAccess = async (
  db: D1Database,
  workspaceId: string,
  botId: string,
  jobKind: string,
  channelId: string | null,
  taskId: string | null,
  consolidationScopeKind: string | null,
  jobId: string,
): Promise<SearchAccess> => {
  if (jobKind === "consolidate" && consolidationScopeKind !== "channel")
    return botSearchAccess(db, workspaceId, botId);
  const { results: replies } = await db
    .prepare(
      `SELECT DISTINCT c.channel_id FROM messages q JOIN messages reply
      ON reply.workspace_id = q.workspace_id AND reply.reply_to_message_id = q.id
      JOIN conversations c ON c.workspace_id = reply.workspace_id AND c.id = reply.conversation_id
      WHERE q.workspace_id = ? AND q.job_id = ? AND q.kind = 'request'`,
    )
    .bind(workspaceId, jobId)
    .all<{ channel_id: string }>();
  return {
    workspaceId,
    botId,
    allBotsAndTasks: false,
    ...(jobKind === "normal" ? { jobId } : {}),
    scopes: [
      `workspace:${workspaceId}`,
      `bot:${botId}`,
      ...(channelId ? [`channel:${channelId}`] : []),
      ...(taskId ? [`task:${taskId}`] : []),
      ...replies.map((r) => `channel:${r.channel_id}`),
    ],
  };
};

const requireConversationAccess = async (db: D1Database, access: SearchAccess, ids: string[]) => {
  const row = await db
    .prepare(`SELECT ${sourcesReadableSql(access, ids)} AS allowed`)
    .first<{ allowed: number }>();
  if (!row?.allowed) throw new HttpError("FORBIDDEN", "source access is no longer permitted");
};

export const requireSnapshotAccess = async (
  db: D1Database,
  access: SearchAccess,
  snapshot: ContextSnapshot,
) => {
  const row = await db
    .prepare(
      `SELECT ${sourcesReadableSql(
        access,
        snapshot.sourceConversationIds,
        snapshot.memoryRevisions.map((m) => m.id),
      )} AS allowed`,
    )
    .first<{ allowed: number }>();
  if (!row?.allowed) throw new HttpError("FORBIDDEN", "source access is no longer permitted");
};

/**
 * Run context (SDK-01): Bot instructions, Task, recent Conversation and the trigger item's body (with its sender
 * Bot for a bot-to-bot message), or for a batch Job every member's body (its Conversation is the batch lane's), plus
 * the replies to requests the Job sent (§8.2), and the native session an earlier Run of the Job left (§13.3). A
 * delegated Job (§8.1) carries its Delegation; from a Bot, its Conversation is the two Bots' `bot_pair`.
 */
export const getRunContext = async (
  db: D1Database,
  device: Device,
  input: { jobId: string; runId: string; executionGeneration: number },
): Promise<RunContext> => {
  await fencedRun(db, device, input);
  const workspaceId = device.workspaceIds[0]!;
  const row = await db
    .prepare(
      `SELECT b.id AS bot_id, b.name, b.instructions, b.tool_policy, j.placement, j.job_kind, j.trigger_key, j.consolidation_scope_kind, j.consolidation_scope_id,
              b.config_revision, t.scope_revision, t.revision AS task_revision, w.auth_epoch, t.id AS task_id, t.key, t.title, t.description,
              j.inbox_batch_id, i.id AS item_id, c.id AS conversation_id, c.channel_id, c.kind AS conversation_kind,
              m.id AS message_id, m.kind AS message_kind, fb.id AS from_bot_id, fb.name AS from_bot_name,
              COALESCE(m.body, CASE e.source_kind WHEN 'routine' THEN json_extract(e.data, '$.inputText') END,
                       e.data) AS body,
              d.id AS delegation_id, d.mode, d.deadline, d.from_kind, d.from_id, d.instructions AS delegation_text,
              db.name AS delegator_name
         FROM jobs j
         JOIN bots b ON b.workspace_id = j.workspace_id AND b.id = j.bot_id
         JOIN workspaces w ON w.id = j.workspace_id
         LEFT JOIN tasks t ON t.workspace_id = j.workspace_id AND t.id = j.task_id
         LEFT JOIN inbox_items i ON i.workspace_id = j.workspace_id AND 'inbox:' || i.id = j.trigger_key
         LEFT JOIN delegations d ON d.workspace_id = j.workspace_id AND d.id = j.delegation_id
         LEFT JOIN bots db ON db.workspace_id = d.workspace_id AND d.from_kind = 'bot' AND db.id = d.from_id
         LEFT JOIN conversations c ON c.workspace_id = j.workspace_id
                                  AND c.id = COALESCE(j.conversation_id, i.conversation_id, d.conversation_id)
         LEFT JOIN events e ON e.workspace_id = i.workspace_id AND e.id = i.input_id
         LEFT JOIN messages m ON m.workspace_id = e.workspace_id AND e.subject_kind = 'message'
                             AND m.id = e.subject_id
         LEFT JOIN bots fb ON fb.workspace_id = e.workspace_id AND e.actor_kind = 'bot' AND fb.id = e.actor_id
        WHERE j.workspace_id = ? AND j.id = ?`,
    )
    .bind(workspaceId, input.jobId)
    .first<{
      bot_id: string;
      name: string;
      instructions: string;
      tool_policy: string;
      placement: string;
      job_kind: "normal" | "summarize" | "consolidate";
      trigger_key: string;
      consolidation_scope_kind: "bot" | "channel" | null;
      consolidation_scope_id: string | null;
      config_revision: number;
      scope_revision: number | null;
      task_revision: number | null;
      auth_epoch: number;
      task_id: string | null;
      key: string | null;
      title: string | null;
      description: string | null;
      inbox_batch_id: string | null;
      item_id: string | null;
      conversation_id: string | null;
      channel_id: string | null;
      conversation_kind: "channel" | "bot_pair" | "dm" | "thread" | null;
      message_id: string | null;
      message_kind: string | null;
      from_bot_id: string | null;
      from_bot_name: string | null;
      body: string | null;
      delegation_id: string | null;
      mode: "read" | "write" | null;
      deadline: string | null;
      from_kind: "user" | "bot" | null;
      from_id: string | null;
      delegation_text: string | null;
      delegator_name: string | null;
    }>();
  if (!row) throw new HttpError("NOT_FOUND", "job not found");
  const batchMessageIds: string[] = [];
  let batch: RunContext["batch"] = null;
  if (row.inbox_batch_id) {
    const { results } = await db
      .prepare(
        `SELECT i.id, m.id AS message_id, i.conversation_id, c.channel_id, c.kind, COALESCE(m.body, e.data) AS body
           FROM inbox_items i
           LEFT JOIN conversations c ON c.workspace_id = i.workspace_id AND c.id = i.conversation_id
           LEFT JOIN events e ON e.workspace_id = i.workspace_id AND e.id = i.input_id
           LEFT JOIN messages m ON m.workspace_id = e.workspace_id AND e.subject_kind = 'message'
                               AND m.id = e.subject_id
          WHERE i.workspace_id = ? AND i.batch_id = ? ORDER BY i.created_at, i.id`,
      )
      .bind(workspaceId, row.inbox_batch_id)
      .all<{
        id: string;
        message_id: string | null;
        conversation_id: string | null;
        channel_id: string | null;
        kind: "channel" | "bot_pair" | "dm" | "thread";
        body: string;
      }>();
    batchMessageIds.push(...results.flatMap((item) => (item.message_id ? [item.message_id] : [])));
    batch = { id: row.inbox_batch_id, items: results.map(({ id, body }) => ({ id, body })) };
    row.conversation_id = results[0]?.conversation_id ?? null;
    row.channel_id = results[0]?.channel_id ?? null;
    row.conversation_kind = results[0]?.kind ?? null;
  }
  const access = await contextAccess(
    db,
    workspaceId,
    row.bot_id,
    row.job_kind,
    row.channel_id,
    row.task_id,
    row.consolidation_scope_kind,
    input.jobId,
  );
  if (row.conversation_id) await requireConversationAccess(db, access, [row.conversation_id]);
  const stored = await db
    .prepare("SELECT context_snapshot FROM runs WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, input.runId)
    .first<{ context_snapshot: string | null }>();
  if (stored?.context_snapshot) {
    const snapshot = JSON.parse(stored.context_snapshot) as ContextSnapshot;
    await requireSnapshotAccess(db, access, snapshot);
    return snapshot.context;
  }
  const summary =
    row.conversation_id && row.job_kind !== "consolidate"
      ? await latestSummary(db, workspaceId, row.conversation_id, row.bot_id)
      : null;
  const messageIds = [
    ...batchMessageIds,
    ...(row.message_id ? [row.message_id] : []),
    ...(summary?.pinnedFacts.flatMap((f) => f.sourceMessageIds) ?? []),
  ];
  let truncated = false;
  let conversation: RunContext["conversation"] = null;
  let parentMessages: RunContext["parentMessages"] = [];
  if (row.conversation_id && row.channel_id) {
    // The last 20 messages of `conversation`, oldest first, optionally only those before message `before`.
    const lastMessages = async (conversationId: string, before: string | null) =>
      (
        await db
          .prepare(
            `SELECT id, seq, actorKind, actorId, body, createdAt FROM (
               SELECT m.id, a.kind AS actorKind, a.id AS actorId, m.body, m.created_at AS createdAt, m.seq
                 FROM messages m JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
                WHERE m.workspace_id = ?1 AND m.conversation_id = ?2
                  AND (?3 IS NULL OR m.seq < (SELECT seq FROM messages WHERE id = ?3))
                  AND (?4 IS NULL OR m.seq > ?4)
                ORDER BY m.seq DESC LIMIT 20
             ) ORDER BY seq`,
          )
          .bind(
            workspaceId,
            conversationId,
            before,
            conversationId === row.conversation_id ? (summary?.coversToSeq ?? 0) : null,
          )
          .all<RunContext["parentMessages"][number] & { id: string; seq: number }>()
      ).results;
    const results = row.job_kind === "normal" ? await lastMessages(row.conversation_id, null) : [];
    messageIds.push(...results.map((m) => m.id));
    const count =
      row.job_kind === "normal"
        ? await db
            .prepare(
              "SELECT COUNT(*) AS n FROM messages WHERE workspace_id = ? AND conversation_id = ? AND seq > ?",
            )
            .bind(workspaceId, row.conversation_id, summary?.coversToSeq ?? 0)
            .first<{ n: number }>()
        : null;
    truncated = (count?.n ?? 0) > results.length;
    // A thread: its root message first, and the parent's messages before the root as read-only context.
    const thread =
      row.job_kind === "normal" && row.conversation_kind === "thread"
        ? await db
            .prepare(
              `SELECT c.parent_conversation_id, c.root_message_id, m.id, m.seq, a.kind AS actorKind, a.id AS actorId, m.body, m.created_at AS createdAt
                 FROM conversations c
                 JOIN messages m ON m.workspace_id = c.workspace_id AND m.id = c.root_message_id
                 JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
                WHERE c.workspace_id = ? AND c.id = ?`,
            )
            .bind(workspaceId, row.conversation_id)
            .first<
              RunContext["parentMessages"][number] & {
                parent_conversation_id: string;
                root_message_id: string;
                id: string;
                seq: number;
              }
            >()
        : null;
    if (thread) {
      const { parent_conversation_id: parentId, root_message_id: rootId, ...root } = thread;
      results.unshift(root);
      messageIds.push(rootId);
      await requireConversationAccess(db, access, [parentId]);
      const parent = await lastMessages(parentId, rootId);
      const parentCount = await db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE workspace_id = ? AND conversation_id = ?
        AND seq < (SELECT seq FROM messages WHERE workspace_id = ? AND id = ?)`)
        .bind(workspaceId, parentId, workspaceId, rootId)
        .first<{ n: number }>();
      if (parentCount!.n > parent.length) truncated = true;
      messageIds.push(...parent.map((m) => m.id));
      parentMessages = parent.map(({ id: _id, seq: _seq, ...m }) => m);
    }
    // A DM's counterpart: its user's actor.
    const counterpart =
      row.conversation_kind === "dm"
        ? await db
            .prepare(
              `SELECT a.id AS actorId, a.display_name AS name FROM conversations c
                 JOIN actors a ON a.workspace_id = c.workspace_id AND a.user_id = c.dm_user_id
                WHERE c.workspace_id = ? AND c.id = ?`,
            )
            .bind(workspaceId, row.conversation_id)
            .first<{ actorId: string; name: string }>()
        : null;
    conversation = {
      id: row.conversation_id,
      channelId: row.channel_id,
      kind: row.conversation_kind ?? "channel",
      counterpart,
      recent: results.map(({ id: _id, seq: _seq, ...m }) => m),
    };
  }
  const { results: replies } = await db
    .prepare(
      `SELECT m.id, m.reply_to_message_id, b.id AS bot_id, b.name, m.body, m.created_at
         FROM messages q
         JOIN messages m ON m.workspace_id = q.workspace_id AND m.reply_to_message_id = q.id
         JOIN bots b ON b.workspace_id = m.workspace_id AND b.actor_id = m.actor_id
        WHERE q.workspace_id = ? AND q.job_id = ? AND q.kind = 'request'
        ORDER BY m.created_at, m.id`,
    )
    .bind(workspaceId, input.jobId)
    .all<{
      id: string;
      reply_to_message_id: string;
      bot_id: string;
      name: string;
      body: string;
      created_at: string;
    }>();
  // Memory (§13.5): the Bot's, the Task's and the Channel's, newest first, within 8 KiB.
  const { results: memoryRows } =
    row.job_kind === "normal"
      ? await db
          .prepare(
            `SELECT id, scope_kind AS scopeKind, content, revision, created_at AS createdAt FROM memories m
        WHERE workspace_id = ? AND deleted_at IS NULL
          AND ((scope_kind = 'bot' AND scope_id = ?) OR (scope_kind = 'task' AND scope_id = ?)
               OR (scope_kind = 'channel' AND scope_id = ?))
        AND ${memoryReadableSql(access)} ORDER BY created_at DESC, id DESC LIMIT 21`,
          )
          .bind(workspaceId, row.bot_id, row.task_id, row.channel_id)
          .all<RunContext["memories"][number]>()
      : { results: [] };
  const memories: RunContext["memories"] = [];
  let bytes = 0;
  for (const memory of memoryRows) {
    bytes += new TextEncoder().encode(memory.content).length;
    if (bytes > memoryContextBytes || memories.length === 20) {
      truncated = true;
      break;
    }
    memories.push(memory);
  }
  // Related history: search hits for the trigger body within what this Run may read, never the trigger itself.
  const match =
    row.job_kind === "normal" && row.item_id && row.body ? relatedQuery(row.body) : null;
  const relatedHits = match
    ? await searchDocuments(db, access, {
        q: "",
        match,
        kinds: ["message", "task", "memory"],
        limit: 5,
        excludeMessageId: row.message_id,
      })
    : [];
  const related = relatedHits.map(({ sourceKind, sourceId, title, snippet }) => ({
    sourceKind,
    sourceId,
    title,
    snippet,
  }));
  // The native session to resume (§13.3): the latest earlier root Run of this Job that reported one.
  const previous = await db
    .prepare(
      `SELECT provider_session_id FROM runs
        WHERE workspace_id = ? AND job_id = ? AND kind = 'root' AND execution_generation < ?
          AND provider_session_id IS NOT NULL
        ORDER BY execution_generation DESC LIMIT 1`,
    )
    .bind(workspaceId, input.jobId, input.executionGeneration)
    .first<{ provider_session_id: string }>();
  // Runs read `@name`, never `<@bot:ID>` tokens (MENTION-01).
  const { results: botNames } = await db
    .prepare("SELECT id, name FROM bots WHERE workspace_id = ?")
    .bind(workspaceId)
    .all<{ id: string; name: string }>();
  const names = new Map(botNames.map((b) => [b.id, b.name]));
  const named = (text: string) => renderMentions(text, names);
  if (conversation) {
    conversation.recent = conversation.recent.map((m) => ({ ...m, body: named(m.body) }));
  }
  parentMessages = parentMessages.map((m) => ({ ...m, body: named(m.body) }));
  if (batch) batch.items = batch.items.map((i) => ({ ...i, body: named(i.body) }));
  const selectedMessages =
    row.job_kind === "summarize" && row.conversation_id
      ? (
          await db
            .prepare(
              `SELECT m.id, m.seq, a.kind AS actorKind, a.id AS actorId, m.body, m.created_at AS createdAt
          FROM messages m JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
          WHERE m.workspace_id = ? AND m.conversation_id = ? AND m.seq > ? AND m.seq <= ?
          ORDER BY m.seq LIMIT 100`,
            )
            .bind(
              workspaceId,
              row.conversation_id,
              summary?.coversToSeq ?? 0,
              Number(row.trigger_key.slice(row.trigger_key.lastIndexOf(":") + 1)),
            )
            .all<NonNullable<RunContext["summarization"]>["messages"][number]>()
        ).results
      : null;
  if (selectedMessages && selectedMessages.length === 0) {
    throw new HttpError("INVALID_INPUT", "conversation has no unsummarized messages");
  }
  if (selectedMessages) messageIds.push(...selectedMessages.map((m) => m.id));
  const consolidation =
    row.job_kind === "consolidate"
      ? await (async () => {
          const scopeKind = row.consolidation_scope_kind ?? "bot";
          const scopeId = row.consolidation_scope_id ?? row.bot_id;
          const { results: scopeRows } = await db
            .prepare(
              `SELECT id, scope_kind AS scopeKind, scope_id AS scopeId, content, source_kind AS sourceKind,
             source_id AS sourceId, source, merged_from_ids AS mergedFromIds,
             source_conversation_ids AS sourceConversationIds, proposed_scope AS proposedScope, revision,
             supersedes_id AS supersedesId, created_at AS createdAt FROM memories m
             WHERE workspace_id = ? AND scope_kind = ? AND scope_id = ? AND deleted_at IS NULL
               AND ${memoryReadableSql(access)} ORDER BY created_at DESC, id DESC LIMIT 201`,
            )
            .bind(workspaceId, scopeKind, scopeId)
            .all<NonNullable<RunContext["consolidation"]>["memories"][number]>();
          const scopeMemories = scopeRows.slice(0, 200);
          if (scopeRows.length > 200) truncated = true;
          await Promise.all(
            scopeMemories.map(async (memory) => {
              memory.mergedFromIds = JSON.parse(memory.mergedFromIds as unknown as string);
              memory.sourceConversationIds = await memoryProvenance(db, workspaceId, memory.id);
            }),
          );
          const { results: summaryRows } = await db
            .prepare(
              `SELECT s.id, s.conversation_id AS conversationId, s.bot_id AS botId, s.covers_from_seq AS coversFromSeq,
             s.covers_to_seq AS coversToSeq, s.text, s.pinned_facts AS pinnedFacts, s.revision,
             created_by_run_id AS createdByRunId, s.created_at AS createdAt FROM conversation_summaries s
             JOIN conversations c ON c.workspace_id = s.workspace_id AND c.id = s.conversation_id
             WHERE s.workspace_id = ? AND (s.bot_id = ? OR s.bot_id IS NULL)
               AND ${conversationReadableSql(access)}
               AND (? = 'bot' OR c.channel_id = ?)
               AND NOT EXISTS (SELECT 1 FROM conversation_summaries newer
                 WHERE newer.workspace_id = s.workspace_id AND newer.conversation_id = s.conversation_id
                   AND (newer.bot_id = ? OR newer.bot_id IS NULL)
                   AND (newer.covers_to_seq > s.covers_to_seq OR (newer.covers_to_seq = s.covers_to_seq
                     AND (newer.created_at > s.created_at OR (newer.created_at = s.created_at AND newer.id > s.id)))))
             ORDER BY s.created_at DESC, s.id DESC LIMIT 21`,
            )
            .bind(workspaceId, row.bot_id, scopeKind, scopeId, row.bot_id)
            .all<NonNullable<RunContext["consolidation"]>["summaries"][number]>();
          const summaries = summaryRows.slice(0, 20);
          if (summaryRows.length > 20) truncated = true;
          for (const item of summaries)
            item.pinnedFacts = JSON.parse(item.pinnedFacts as unknown as string);
          return { scopeKind, scopeId, memories: scopeMemories, summaries };
        })()
      : null;
  const context: RunContext = {
    jobKind: row.job_kind,
    previousProviderSessionId: previous?.provider_session_id ?? null,
    bot: {
      id: row.bot_id,
      name: row.name,
      instructions: row.instructions,
      toolPolicy: JSON.parse(row.tool_policy) as ToolPolicy,
    },
    environment: (JSON.parse(row.placement) as PlacementPolicy).environmentId ?? null,
    task:
      row.task_id === null
        ? null
        : {
            id: row.task_id,
            key: row.key ?? "",
            title: row.title ?? "",
            description: row.description ?? "",
          },
    conversation,
    parentMessages,
    inboxItem: row.item_id
      ? {
          id: row.item_id,
          body: named(row.body ?? ""),
          messageId: row.message_id,
          kind: row.message_kind,
          fromBot: row.from_bot_id ? { id: row.from_bot_id, name: row.from_bot_name ?? "" } : null,
        }
      : null,
    batch,
    replies: replies.map((r) => ({
      messageId: r.id,
      requestMessageId: r.reply_to_message_id,
      fromBot: { id: r.bot_id, name: r.name },
      body: named(r.body),
      createdAt: r.created_at,
    })),
    memories,
    related,
    summary,
    summarization: selectedMessages
      ? {
          conversationId: row.conversation_id!,
          botId: row.bot_id,
          coversFromSeq: selectedMessages[0]!.seq,
          coversToSeq: selectedMessages.at(-1)!.seq,
          messages: selectedMessages,
          previousSummary: summary,
        }
      : null,
    consolidation,
    delegation: row.delegation_id
      ? {
          id: row.delegation_id,
          mode: row.mode!,
          deadline: row.deadline,
          fromBot:
            row.from_kind === "bot" ? { id: row.from_id!, name: row.delegator_name ?? "" } : null,
          fromUser: row.from_kind === "user" ? { id: row.from_id! } : null,
          instructions: row.delegation_text ?? "",
        }
      : null,
  };
  messageIds.push(...replies.map((r) => r.id));
  const memoryRevisions = [...memories, ...(consolidation?.memories ?? [])].map(
    ({ id, revision }) => ({ id, revision }),
  );
  const sources = new Set<string>([
    ...(row.conversation_id ? [row.conversation_id] : []),
    ...(consolidation?.summaries.map((s) => s.conversationId) ?? []),
  ]);
  for (const hit of relatedHits) {
    if (hit.sourceKind === "memory") {
      memoryRevisions.push({ id: hit.sourceId, revision: hit.sourceRevision });
    } else if (hit.sourceKind === "message") messageIds.push(hit.sourceId);
  }
  const provenances = await Promise.all(
    memoryRevisions.map((memory) => memoryProvenance(db, workspaceId, memory.id)),
  );
  for (const provenance of provenances) {
    for (const id of provenance) sources.add(id);
  }
  if (messageIds.length) {
    const { results } = await db
      .prepare(
        "SELECT DISTINCT conversation_id FROM messages WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?))",
      )
      .bind(workspaceId, JSON.stringify(messageIds))
      .all<{ conversation_id: string }>();
    for (const m of results) sources.add(m.conversation_id);
  }
  const snapshot: ContextSnapshot = {
    context,
    summaryId: summary?.id ?? null,
    truncated,
    selectedMessageIds: selectedMessages?.map((m) => m.id) ?? [],
    messageIds: [...new Set(messageIds)],
    selectedRange: context.summarization
      ? {
          conversationId: context.summarization.conversationId,
          coversFromSeq: context.summarization.coversFromSeq,
          coversToSeq: context.summarization.coversToSeq,
        }
      : null,
    memoryRevisions: [
      ...new Map(memoryRevisions.map((m) => [`${m.id}:${m.revision}`, m])).values(),
    ],
    botRevision: row.config_revision,
    taskScopeRevision: row.scope_revision,
    taskRevision: row.task_revision,
    sourceAclEpoch: row.auth_epoch,
    sourceConversationIds: [...sources],
    tokenEstimate: Math.ceil(new TextEncoder().encode(JSON.stringify(context)).length / 4),
  };
  await requireSnapshotAccess(db, access, snapshot);
  const [setGuard, clearGuard] = guard(db);
  await db.batch([
    db
      .prepare(`UPDATE runs SET context_snapshot = COALESCE(context_snapshot, ?)
      WHERE workspace_id = ? AND id = ? AND execution_generation = ? AND state IN ('starting', 'running', 'waiting_approval')
      AND ${sourcesReadableSql(
        access,
        snapshot.sourceConversationIds,
        snapshot.memoryRevisions.map((m) => m.id),
      )}`)
      .bind(JSON.stringify(snapshot), workspaceId, input.runId, input.executionGeneration),
    setGuard,
    clearGuard,
  ]);
  const frozen = (await db
    .prepare("SELECT context_snapshot FROM runs WHERE workspace_id = ? AND id = ?")
    .bind(workspaceId, input.runId)
    .first<{ context_snapshot: string }>())!;
  const saved = JSON.parse(frozen.context_snapshot) as ContextSnapshot;
  await requireSnapshotAccess(db, access, saved);
  if (saved.truncated && saved.context.jobKind === "normal" && row.conversation_id) {
    await enqueueSummary(db, workspaceId, row.conversation_id, row.bot_id);
  }
  return saved.context;
};

/**
 * Executor observations (§9.2 step 7), fenced like a renew. `runtime.run.started` stores the provider session and
 * marks the launch confirmed; `runtime.run.stopped` confirms an `unknown` Run's stop (§10.4); `git.collected` stores the
 * Run's commits and PRs once (GIT-01).
 */
export const recordObservation = async (db: D1Database, device: Device, input: RunObservation) => {
  const providerSessionId = input.payload?.providerSessionId;
  if (input.kind === "runtime.run.stopped") {
    if (input.payload?.confirmed !== true) {
      throw new HttpError("INVALID_INPUT", "payload.confirmed must be true");
    }
    const result = await confirmRunStopped(db, {
      runId: input.runId,
      deviceId: device.deviceId,
      executionGeneration: input.executionGeneration,
      workspaceId: device.workspaceIds[0]!,
    });
    if (!result.ok && result.reason === "not_found")
      throw new HttpError("NOT_FOUND", "run not found");
    if (!result.ok) {
      throw new HttpError("REVISION_CONFLICT", "run is still active", false, "not_unknown");
    }
    return { status: 200 as const, body: { ok: true } };
  }
  if (input.kind === "git.collected") {
    const git = parse(GitCollected, input.payload);
    if (!git.ok) throw new HttpError("INVALID_INPUT", git.issues.join("; "));
    await fencedRun(db, device, input);
    const g = git.value;
    // The first stored wins: a repeat (retry, resumed attempt) changes nothing.
    await db
      .prepare(
        `INSERT INTO run_git (run_id, workspace_id, repository, branch, before, after, commits, partial, prs, pr_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (run_id) DO NOTHING`,
      )
      .bind(
        input.runId,
        device.workspaceIds[0],
        g.repository,
        g.branch,
        g.before,
        g.after,
        JSON.stringify(g.commits),
        g.partial ? 1 : 0,
        JSON.stringify(g.prs),
        g.prError ?? null,
      )
      .run();
    return { status: 200 as const, body: { ok: true } };
  }
  if (input.kind !== "runtime.run.started") return { status: 202 as const, body: { ok: true } };
  if (typeof providerSessionId !== "string" || providerSessionId === "") {
    throw new HttpError("INVALID_INPUT", "payload.providerSessionId is required");
  }
  const { meta } = await db
    .prepare(
      `UPDATE runs SET provider_session_id = ?, updated_at = ?, started_at = COALESCE(started_at, ?),
              state = CASE state WHEN 'starting' THEN 'running' ELSE state END
        WHERE id = ? AND workspace_id = ? AND device_id = ? AND execution_generation = ?
          AND state IN ${activeRunStatesSql}`,
    )
    .bind(
      providerSessionId,
      new Date().toISOString(),
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

/**
 * Stores the reported capabilities / capacity (an omitted field keeps its value) and returns the `waiting_device` Jobs
 * this device meets the constraints of to `queued` (AT-12), before the executor lists them.
 */
export const heartbeat = async (db: D1Database, device: Device, body: ExecutorHeartbeat) => {
  const now = new Date().toISOString();
  const workspaceId = device.workspaceIds[0]!;
  await db
    .prepare(
      `UPDATE devices SET last_heartbeat_at = ?, updated_at = ?,
         capabilities = COALESCE(?, capabilities), capacity_background = COALESCE(?, capacity_background)
        WHERE id = ?`,
    )
    .bind(
      now,
      now,
      body.capabilities ? JSON.stringify(body.capabilities) : null,
      body.capacity?.background ?? null,
      device.deviceId,
    )
    .run();
  const { results } = await db
    .prepare(
      "SELECT id, placement FROM jobs WHERE workspace_id = ? AND state = 'waiting_device' LIMIT 200",
    )
    .bind(workspaceId)
    .all<{ id: string; placement: string }>();
  if (results.length > 0) {
    const self = (await placementDevices(db, workspaceId)).find((d) => d.id === device.deviceId);
    const jobIds = results
      .filter(
        (j) =>
          self && constraintReasons(JSON.parse(j.placement) as PlacementPolicy, self).length === 0,
      )
      .map((j) => j.id);
    await setJobsWaitingDevice(db, { workspaceId, jobIds, waiting: false });
  }
  return { lastHeartbeatAt: now };
};

/**
 * Pump side (§10.4, AT-30, AT-22): queued Jobs that no online device can run (placement.ts `shouldWait`) go
 * `waiting_device`. Returns the Workspaces that changed.
 */
// ponytail: at most 200 queued Jobs per sweep; page through them if queues get deep.
export const parkWaitingJobs = async (db: D1Database) => {
  const { results } = await db
    .prepare(
      "SELECT workspace_id, id, placement FROM jobs WHERE state = 'queued' ORDER BY created_at LIMIT 200",
    )
    .all<{ workspace_id: string; id: string; placement: string }>();
  const byWorkspace = Map.groupBy(results, (j) => j.workspace_id);
  const changed: string[] = [];
  const now = Date.now();
  for (const [workspaceId, jobs] of byWorkspace) {
    // oxlint-disable-next-line no-await-in-loop -- one small query per Workspace with queued Jobs
    const devices = await placementDevices(db, workspaceId);
    const jobIds = jobs
      .filter((j) => shouldWait(JSON.parse(j.placement) as PlacementPolicy, devices, now))
      .map((j) => j.id);
    // oxlint-disable-next-line no-await-in-loop
    if (await setJobsWaitingDevice(db, { workspaceId, jobIds, waiting: true }))
      changed.push(workspaceId);
  }
  return changed;
};
