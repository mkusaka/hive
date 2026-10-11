// Command bodies and watch loops (docs/architecture.md §22.3, §23). Web-standard APIs only: the api-worker
// end-to-end test calls these inside workerd.
/* oxlint-disable no-await-in-loop */
import { mentionToken } from "@hive/contracts";
import { type Client, CliError, invalid } from "./client.ts";

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
/** An empty topic clears it. */
export const channelUpdate = (c: Client, e: Envelope, channelId: string, topic: string) =>
  c.command(e, { type: "channel.update", channelId, topic });
type MemberTarget = { userId: string } | { botId: string };

export const channelMember = (
  c: Client,
  e: Envelope,
  type: "channel.member.add" | "channel.member.update" | "channel.member.remove",
  channelId: string,
  target: MemberTarget,
  role?: string,
) =>
  c.command(e, {
    type,
    channelId,
    ...target,
    ...(role === undefined ? {} : { role }),
  });
export const dmOpen = (c: Client, e: Envelope, botId: string) =>
  c.command(e, { type: "dm.open", botId });

/** `toolPolicy` / `placementPolicy`: @hive/contracts ToolPolicy / PlacementPolicy (§10.2). */
export const botCreate = (
  c: Client,
  e: Envelope,
  name: string,
  instructions?: string,
  extra: { toolPolicy?: Json; placementPolicy?: Json } = {},
) =>
  c.command(e, {
    type: "bot.create",
    name,
    ...(extra.placementPolicy ? { placementPolicy: extra.placementPolicy } : {}),
    ...(instructions === undefined ? {} : { instructions }),
    ...(extra.toolPolicy ? { toolPolicy: extra.toolPolicy } : {}),
  });

export type Bot = Json & {
  id: string;
  revision: number;
  toolPolicy?: Json;
  placementPolicy?: Json;
  skills?: unknown[];
};
type BotChange = {
  instructions?: string;
  toolPolicy?: Json;
  placementPolicy?: Json;
  skills?: unknown[];
};

/** Reads a Bot immediately before a revision-checked update. */
export const getBot = async (c: Client, workspaceId: string, botId: string): Promise<Bot> => {
  const { bots } = (await listBots(c, workspaceId)) as { bots: Bot[] };
  const bot = bots.find((candidate) => candidate.id === botId);
  if (!bot) throw new CliError("NOT_FOUND", 7, `bot not found: ${botId}`);
  return bot;
};

/** Replaces the given fields at the Bot's current revision (read from the Bot list). */
export const botUpdate = async (
  c: Client,
  e: Envelope,
  botId: string,
  change: BotChange,
  current?: Bot,
) => {
  const bot = current ?? (await getBot(c, e.workspaceId, botId));
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

// ------------------------------------------------- External effects (§19)

export const listEffects = (
  c: Client,
  workspaceId: string,
  filter: { state?: string; runId?: string },
) =>
  c.get(
    inWorkspace("effects", workspaceId, {
      ...(filter.state ? { state: filter.state } : {}),
      ...(filter.runId ? { runId: filter.runId } : {}),
    }),
  );

/** Manual recovery of an `unknown` (or a performed `failed`) effect. */
export const effectResolve = (
  c: Client,
  e: Envelope,
  effectId: string,
  resolution: {
    action: "mark_succeeded" | "mark_failed" | "retry";
    externalId?: string;
    externalUrl?: string;
  },
) => c.command(e, { type: "effect.resolve", effectId, ...resolution });

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

/** With `resolveNames`, every `@name` of a Workspace Bot (longest names first) becomes its `<@bot:ID>` token. */
export const messagePost = async (
  c: Client,
  e: Envelope,
  input: {
    target: ({ channelId: string } | { conversationId: string }) & { threadOf?: string };
    text: string;
    resolveNames: boolean;
  },
) => {
  let text = input.text;
  if (input.resolveNames) {
    const { bots } = (await listBots(c, e.workspaceId)) as { bots: { id: string; name: string }[] };
    for (const bot of bots.toSorted((a, b) => b.name.length - a.name.length))
      text = text.replaceAll(`@${bot.name}`, mentionToken(bot.id));
  }
  return c.command(e, { type: "message.post", ...input.target, text });
};

export const eventEmit = (
  c: Client,
  e: Envelope,
  event: { type: string; data: unknown; subject?: { kind: string; id: string } },
) => c.command(e, { type: "event.emit", event });

const path = (prefix: string, id: string) => `${prefix}/${encodeURIComponent(id)}`;
export const getOperation = (c: Client, id: string) => c.get(path("/v1/operations", id));
export const getJob = (c: Client, id: string) => c.get(path("/v1/jobs", id));
export const getRun = (c: Client, id: string) => c.get(path("/v1/runs", id));
export const getTask = (c: Client, id: string) => c.get(path("/v1/tasks", id));
/** Every confirmed part of the normalized transcript, one page (part) per request. */
export const runTranscript = async (c: Client, id: string) => {
  const entries: Json[] = [];
  let cursor: string | null = "0";
  while (cursor !== null) {
    const page = await c.get(`${path("/v1/runs", id)}/transcript?cursor=${cursor}`);
    entries.push(...(page.entries as Json[]));
    cursor = page.nextCursor as string | null;
  }
  return entries;
};
export const rawTranscript = (c: Client, id: string) =>
  c.getText(`${path("/v1/transcripts", id)}/raw`);
export const listInbox = (c: Client, botId: string) =>
  c.get(`/v1/inbox?botId=${encodeURIComponent(botId)}`);

const inWorkspace = (resource: string, workspaceId: string, query: Record<string, string> = {}) =>
  `/v1/${resource}?${new URLSearchParams({ workspaceId, ...query })}`;
export const listChannels = (c: Client, workspaceId: string) =>
  c.get(inWorkspace("channels", workspaceId));
export const listBots = (c: Client, workspaceId: string) => c.get(inWorkspace("bots", workspaceId));
export const listDms = (c: Client, workspaceId: string) => c.get(inWorkspace("dms", workspaceId));
/** Threads the user replied in or started, newest reply first. */
export const listThreads = (c: Client, workspaceId: string) =>
  c.get(inWorkspace("threads", workspaceId, { participant: "me" }));
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

export const taskDelegate = (
  c: Client,
  e: Envelope,
  task: TaskRef,
  input: { toBotId: string; mode: string; instructions: string; deadline?: string },
) =>
  c.command(e, {
    type: "task.delegate",
    taskId: task.id,
    ...input,
    expectedRevision: task.revision,
  });

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
/** `routine.run` / `routine.pause` / `routine.resume` / `routine.delete`. */
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

// --------------------------------------------------- Search and Memory (§13.6, §14)

export const search = (c: Client, workspaceId: string, q: string, kinds?: string) =>
  c.get(inWorkspace("search", workspaceId, { q, ...(kinds ? { kinds } : {}) }));

/** `workspace`, or `<kind>:<id>` for channel / project / bot / task. */
export const parseScope = (scope: string, workspaceId: string) => {
  if (scope === "workspace") return { scopeKind: "workspace", scopeId: workspaceId };
  const colon = scope.indexOf(":");
  if (colon <= 0 || colon === scope.length - 1) {
    throw invalid("--scope must be workspace or <channel|project|bot|task>:<id>");
  }
  return { scopeKind: scope.slice(0, colon), scopeId: scope.slice(colon + 1) };
};

export const memoryWrite = (
  c: Client,
  e: Envelope,
  scope: { scopeKind: string; scopeId: string },
  content: string,
) => c.command(e, { type: "memory.write", ...scope, content });

export const listMemories = (
  c: Client,
  workspaceId: string,
  scope: { scopeKind: string; scopeId: string },
) => c.get(inWorkspace("memories", workspaceId, scope));

export const memoryDelete = (c: Client, e: Envelope, memoryId: string, expectedRevision: number) =>
  c.command(e, { type: "memory.delete", memoryId, expectedRevision });
