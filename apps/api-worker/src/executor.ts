// Executor routes (docs/architecture.md §9.2, §10.3, §22.3): device principal only.
import {
  commandEnvelope,
  ExecutorCommand,
  type ExecutorHeartbeat,
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
  type ToolPolicy,
} from "@hive/contracts";
import {
  appendChange,
  claimJob,
  confirmRunStopped,
  finishRun,
  insertMessage,
  renewLease,
  setJobsWaitingDevice,
} from "@hive/db";
import type * as v from "valibot";
import { hashSecret, newDeviceSecret } from "./auth/device.ts";
import type { Principal } from "./auth/principal.ts";
import { capabilityExpiresAt, insertCapability } from "./auth/run.ts";
import { HttpError } from "./errors.ts";
import { constraintReasons, type PlacementDevice, refusal, shouldWait } from "./placement.ts";
import { indexLater, relatedQuery, searchDocuments } from "./search.ts";

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
  placement: string;
  task_id: string | null;
  created_at: string;
};
const jobColumns = "id, bot_id, state, revision, trigger_key, placement, task_id, created_at";

const toQueuedJob = (row: JobRow): QueuedJob => ({
  id: row.id,
  botId: row.bot_id,
  revision: row.revision,
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
  const scopes = [
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

/**
 * Run context (SDK-01): Bot instructions, Task, recent Conversation and the trigger item's body (with its sender
 * Bot for a bot-to-bot message), or for a batch Job every member's body (its Conversation is the batch lane's), plus
 * the replies to requests the Job sent (§8.2), and the native session an earlier Run of the Job left (§13.3).
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
      `SELECT b.id AS bot_id, b.name, b.instructions, b.tool_policy, j.placement, t.id AS task_id, t.key, t.title, t.description,
              j.inbox_batch_id, i.id AS item_id, i.conversation_id, c.channel_id, c.kind AS conversation_kind,
              m.id AS message_id, m.kind AS message_kind, fb.id AS from_bot_id, fb.name AS from_bot_name,
              COALESCE(m.body, CASE e.source_kind WHEN 'routine' THEN json_extract(e.data, '$.inputText') END,
                       e.data) AS body
         FROM jobs j
         JOIN bots b ON b.workspace_id = j.workspace_id AND b.id = j.bot_id
         LEFT JOIN tasks t ON t.workspace_id = j.workspace_id AND t.id = j.task_id
         LEFT JOIN inbox_items i ON i.workspace_id = j.workspace_id AND 'inbox:' || i.id = j.trigger_key
         LEFT JOIN conversations c ON c.workspace_id = i.workspace_id AND c.id = i.conversation_id
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
      task_id: string | null;
      key: string | null;
      title: string | null;
      description: string | null;
      inbox_batch_id: string | null;
      item_id: string | null;
      conversation_id: string | null;
      channel_id: string | null;
      conversation_kind: "channel" | "bot_pair" | null;
      message_id: string | null;
      message_kind: string | null;
      from_bot_id: string | null;
      from_bot_name: string | null;
      body: string | null;
    }>();
  if (!row) throw new HttpError("NOT_FOUND", "job not found");
  let batch: RunContext["batch"] = null;
  if (row.inbox_batch_id) {
    const { results } = await db
      .prepare(
        `SELECT i.id, i.conversation_id, c.channel_id, c.kind, COALESCE(m.body, e.data) AS body
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
        conversation_id: string | null;
        channel_id: string | null;
        kind: "channel" | "bot_pair";
        body: string;
      }>();
    batch = { id: row.inbox_batch_id, items: results.map(({ id, body }) => ({ id, body })) };
    row.conversation_id = results[0]?.conversation_id ?? null;
    row.channel_id = results[0]?.channel_id ?? null;
    row.conversation_kind = results[0]?.kind ?? null;
  }
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
      kind: row.conversation_kind ?? "channel",
      recent: results,
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
  const { results: memoryRows } = await db
    .prepare(
      `SELECT id, scope_kind AS scopeKind, content, created_at AS createdAt FROM memories
        WHERE workspace_id = ? AND deleted_at IS NULL
          AND ((scope_kind = 'bot' AND scope_id = ?) OR (scope_kind = 'task' AND scope_id = ?)
               OR (scope_kind = 'channel' AND scope_id = ?))
        ORDER BY created_at DESC, id DESC LIMIT 20`,
    )
    .bind(workspaceId, row.bot_id, row.task_id, row.channel_id)
    .all<RunContext["memories"][number]>();
  const memories: RunContext["memories"] = [];
  let bytes = 0;
  for (const memory of memoryRows) {
    bytes += new TextEncoder().encode(memory.content).length;
    if (bytes > memoryContextBytes) break;
    memories.push(memory);
  }
  // Related history: search hits for the trigger body within what this Run may read, never the trigger itself.
  const match = row.item_id && row.body ? relatedQuery(row.body) : null;
  const related = match
    ? (
        await searchDocuments(
          db,
          {
            workspaceId,
            scopes: [
              `workspace:${workspaceId}`,
              `bot:${row.bot_id}`,
              ...(row.channel_id ? [`channel:${row.channel_id}`] : []),
              ...(row.task_id ? [`task:${row.task_id}`] : []),
            ],
            allBotsAndTasks: false,
          },
          {
            q: "",
            match,
            kinds: ["message", "task", "memory"],
            limit: 5,
            excludeMessageId: row.message_id,
          },
        )
      ).map(({ sourceKind, sourceId, title, snippet }) => ({
        sourceKind,
        sourceId,
        title,
        snippet,
      }))
    : [];
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
  return {
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
    inboxItem: row.item_id
      ? {
          id: row.item_id,
          body: row.body ?? "",
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
      body: r.body,
      createdAt: r.created_at,
    })),
    memories,
    related,
  };
};

/**
 * Executor observations (§9.2 step 7), fenced like a renew. `runtime.run.started` stores the provider session and
 * marks the launch confirmed; `runtime.run.stopped` confirms an `unknown` Run's stop (§10.4).
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
