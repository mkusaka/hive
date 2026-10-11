// Command bodies and watch loops (docs/architecture.md §22.3, §23). Web-standard APIs only: the api-worker
// end-to-end test calls these inside workerd.
/* oxlint-disable no-await-in-loop */
import { type Client, CliError } from "./client.ts";

export type Envelope = { operationId: string; idempotencyKey: string; workspaceId: string };
export type Json = Record<string, unknown>;

export const workspaceCreate = (c: Client, e: Envelope, name: string) =>
  c.command(e, { type: "workspace.create", name });

export const deviceRegister = (
  c: Client,
  e: Envelope,
  input: { name: string; os: string; agentVersion: string },
) => c.command(e, { type: "device.register", ...input });

export const channelCreate = (c: Client, e: Envelope, name: string) =>
  c.command(e, { type: "channel.create", name });

/** `toolPolicy`: @hive/contracts ToolPolicy; `environment`: the placement's environment name (§10.1). */
export const botCreate = (
  c: Client,
  e: Envelope,
  name: string,
  allowedDeviceIds: string[] = [],
  instructions?: string,
  extra: { toolPolicy?: Json; environment?: string } = {},
) =>
  c.command(e, {
    type: "bot.create",
    name,
    ...(allowedDeviceIds.length > 0 || extra.environment
      ? {
          placementPolicy: {
            allowedDeviceIds,
            ...(extra.environment ? { environmentId: extra.environment } : {}),
          },
        }
      : {}),
    ...(instructions === undefined ? {} : { instructions }),
    ...(extra.toolPolicy ? { toolPolicy: extra.toolPolicy } : {}),
  });

/** Replaces the given fields at the Bot's current revision (read from the Bot list). */
export const botUpdate = async (
  c: Client,
  e: Envelope,
  botId: string,
  change: { instructions?: string; toolPolicy?: Json },
) => {
  const { bots } = (await listBots(c, e.workspaceId)) as {
    bots: { id: string; revision: number }[];
  };
  const bot = bots.find((b) => b.id === botId);
  if (!bot) throw new CliError("NOT_FOUND", 7, `bot not found: ${botId}`);
  return c.command(e, { type: "bot.update", botId, expectedRevision: bot.revision, ...change });
};

export const deviceEnvironmentRegister = (
  c: Client,
  e: Envelope,
  input: { deviceId: string; name: string; repository: string },
) => c.command(e, { type: "device.environment.register", ...input });

// ------------------------------------------------- Approvals (§19)

export const listApprovals = (c: Client, workspaceId: string, state?: string) =>
  c.get(inWorkspace("approvals", workspaceId, state ? { state } : {}));

export const approvalResolve = (
  c: Client,
  e: Envelope,
  approvalId: string,
  decision: "allow" | "deny",
  reason?: string,
) =>
  c.command(e, {
    type: "approval.resolve",
    approvalId,
    decision,
    ...(reason === undefined ? {} : { reason }),
  });

/** Polls pending approvals until `deadline`, calling `onApproval` once per new one. */
export const watchApprovals = async (
  c: Client,
  workspaceId: string,
  opts: WaitOptions & { onApproval(approval: Json): void },
) => {
  const seen = new Set<string>();
  for (;;) {
    const { approvals } = (await listApprovals(c, workspaceId, "pending")) as {
      approvals: (Json & { id: string })[];
    };
    for (const approval of approvals.toReversed()) {
      if (!seen.has(approval.id)) opts.onApproval(approval);
      seen.add(approval.id);
    }
    const left = opts.deadline - Date.now();
    if (left <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(opts.pollMs, left)));
  }
};

export const agentSend = (
  c: Client,
  e: Envelope,
  input: { botId: string; channelId: string; text: string; notify: boolean },
) =>
  c.command(e, {
    type: "agent.send",
    recipientBotId: input.botId,
    channelId: input.channelId,
    message: { kind: input.notify ? "notification" : "request", text: input.text },
    delivery: input.notify ? "notify" : "wake",
  });

export const eventEmit = (
  c: Client,
  e: Envelope,
  event: { type: string; data: unknown; subject?: { kind: string; id: string } },
) => c.command(e, { type: "event.emit", event });

const path = (prefix: string, id: string) => `${prefix}/${encodeURIComponent(id)}`;
export const getOperation = (c: Client, id: string) => c.get(path("/v1/operations", id));
export const getJob = (c: Client, id: string) => c.get(path("/v1/jobs", id));
export const listInbox = (c: Client, botId: string) =>
  c.get(`/v1/inbox?botId=${encodeURIComponent(botId)}`);

const inWorkspace = (resource: string, workspaceId: string, query: Record<string, string> = {}) =>
  `/v1/${resource}?${new URLSearchParams({ workspaceId, ...query })}`;
export const listChannels = (c: Client, workspaceId: string) =>
  c.get(inWorkspace("channels", workspaceId));
export const listBots = (c: Client, workspaceId: string) => c.get(inWorkspace("bots", workspaceId));
/** Newest first (`limit` default 50). */
export const listMessages = (c: Client, workspaceId: string, channelId: string) =>
  c.get(inWorkspace(`channels/${encodeURIComponent(channelId)}/messages`, workspaceId));
/** Private bot-to-bot conversations with their last messages. */
export const listBotConversations = (c: Client, workspaceId: string) =>
  c.get(inWorkspace("bot-conversations", workspaceId));
export const listDevices = (c: Client, workspaceId: string) =>
  c.get(inWorkspace("devices", workspaceId));
/** No cursor: the bootstrap cursor (§12.3). */
export const syncChanges = (c: Client, workspaceId: string, cursor?: string) =>
  c.get(inWorkspace("sync/changes", workspaceId, cursor ? { cursor } : {}));

// ------------------------------------------------- Projects and Tasks (§4)

export const projectCreate = (c: Client, e: Envelope, input: { key: string; name: string }) =>
  c.command(e, { type: "project.create", ...input });

export const taskCreate = (
  c: Client,
  e: Envelope,
  input: { projectKey?: string; parentTaskId?: string; title: string; priority?: number },
) => c.command(e, { type: "task.create", ...input });

export const listTasks = (
  c: Client,
  workspaceId: string,
  filter: { projectKey?: string; status?: string } = {},
) =>
  c.get(
    inWorkspace(
      "tasks",
      workspaceId,
      Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== undefined)) as Record<
        string,
        string
      >,
    ),
  );

export type TaskRef = { id: string; key: string; revision: number };

/** A Task by key (`APP-123`) or id, with its current revision for `expectedRevision`. */
export const findTask = async (c: Client, workspaceId: string, ref: string) => {
  const { tasks } = (await listTasks(c, workspaceId)) as { tasks: TaskRef[] };
  const task = tasks.find((t) => t.key === ref || t.id === ref);
  if (!task) throw new CliError("NOT_FOUND", 7, `task not found: ${ref}`);
  return task;
};

export const taskPlan = (c: Client, e: Envelope, task: TaskRef, addPrerequisites: string[]) =>
  c.command(e, {
    type: "task.plan",
    taskId: task.id,
    addPrerequisites,
    expectedRevision: task.revision,
  });

export const taskAssign = (
  c: Client,
  e: Envelope,
  task: TaskRef,
  assignee: { kind: "user" | "bot"; id: string } | null,
) =>
  c.command(e, { type: "task.assign", taskId: task.id, assignee, expectedRevision: task.revision });

export const taskComplete = (c: Client, e: Envelope, task: TaskRef) =>
  c.command(e, { type: "task.complete", taskId: task.id, expectedRevision: task.revision });

export const jobStart = (
  c: Client,
  e: Envelope,
  input: { taskId: string; botId: string; deviceId?: string },
) => c.command(e, { type: "job.start", ...input });

// --------------------------------------------- Subscriptions and integrations (§17)

/** `spec` is the `subscription.create` command without `type` (botId, eventTypes, filter, destination, ...). */
export const subscriptionCreate = (c: Client, e: Envelope, spec: Json) =>
  c.command(e, { ...spec, type: "subscription.create" });
export const listSubscriptions = (c: Client, workspaceId: string) =>
  c.get(inWorkspace("subscriptions", workspaceId));
export const subscriptionPause = (c: Client, e: Envelope, subscriptionId: string) =>
  c.command(e, { type: "subscription.pause", subscriptionId });
export const subscriptionTest = (c: Client, e: Envelope, subscriptionId: string, limit?: number) =>
  c.command(e, { type: "subscription.test", subscriptionId, limit });
export const integrationCreate = (
  c: Client,
  e: Envelope,
  input: { kind: string; externalAccountId?: string },
) => c.command(e, { type: "integration.create", ...input });

// ------------------------------------------------ Job control and Routines (§9.3, §10.4, §17.2)

export const jobCancel = (c: Client, e: Envelope, jobId: string) =>
  c.command(e, { type: "job.cancel", jobId });
export const jobResolve = (
  c: Client,
  e: Envelope,
  jobId: string,
  action: "retry" | "cancel" | "mark_failed",
) => c.command(e, { type: "job.resolve", jobId, action });

/** The main Conversation of a Channel the user can see. */
export const findConversation = async (c: Client, workspaceId: string, channelId: string) => {
  const { channels } = (await listChannels(c, workspaceId)) as {
    channels: { id: string; conversationId: string | null }[];
  };
  const conversationId = channels.find((ch) => ch.id === channelId)?.conversationId;
  if (!conversationId) throw new CliError("NOT_FOUND", 7, `channel not found: ${channelId}`);
  return conversationId;
};

export const routineCreate = (
  c: Client,
  e: Envelope,
  input: {
    botId: string;
    name: string;
    cron: string;
    timezone: string;
    inputText: string;
    conversationId?: string;
    misfire?: string;
  },
) =>
  c.command(e, {
    type: "routine.create",
    botId: input.botId,
    name: input.name,
    schedule: { kind: "cron", expr: input.cron, timezone: input.timezone },
    inputText: input.inputText,
    conversationId: input.conversationId,
    misfire: input.misfire,
  });
export const listRoutines = (c: Client, workspaceId: string) =>
  c.get(inWorkspace("routines", workspaceId));
/** `routine.run` / `routine.pause` / `routine.resume`. */
export const routineAction = (c: Client, e: Envelope, type: string, routineId: string) =>
  c.command(e, { type, routineId });

/** `failed` / `cancelled` exit 5. `recovery_required` is not terminal here: it needs a human (§10). */
export const terminalJobStates = ["succeeded", "failed", "cancelled"];

export type WaitOptions = { deadline: number; pollMs: number; onState?: (state: string) => void };

const poll = async <T>(check: () => Promise<T | undefined>, { deadline, pollMs }: WaitOptions) => {
  for (;;) {
    const done = await check();
    if (done !== undefined) return done;
    const left = deadline - Date.now();
    // A watch timeout never cancels the Job (§23).
    if (left <= 0) throw new CliError("TIMEOUT", 6, "wait timed out; the Job is not cancelled");
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, left)));
  }
};

/** Polls `GET /v1/jobs/:id` until the Job is terminal and returns it. */
export const watchJob = (c: Client, jobId: string, opts: WaitOptions) => {
  let last: unknown;
  return poll(async () => {
    const job = await getJob(c, jobId);
    if (job.state !== last) opts.onState?.(String(job.state));
    last = job.state;
    return terminalJobStates.includes(String(job.state)) ? job : undefined;
  }, opts);
};

/** `--wait`: the Job id appears on the operation once routing created it (§22.4); then watch it. */
export const waitForOperationJob = async (c: Client, operationId: string, opts: WaitOptions) => {
  const jobId = await poll(async () => {
    const op = await getOperation(c, operationId);
    return typeof op.jobId === "string" ? op.jobId : undefined;
  }, opts);
  return watchJob(c, jobId, opts);
};
