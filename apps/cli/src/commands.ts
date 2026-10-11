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

export const botCreate = (c: Client, e: Envelope, name: string, allowedDeviceIds: string[] = []) =>
  c.command(e, {
    type: "bot.create",
    name,
    ...(allowedDeviceIds.length > 0 ? { placementPolicy: { allowedDeviceIds } } : {}),
  });

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
export const listDevices = (c: Client, workspaceId: string) =>
  c.get(inWorkspace("devices", workspaceId));
/** No cursor: the bootstrap cursor (§12.3). */
export const syncChanges = (c: Client, workspaceId: string, cursor?: string) =>
  c.get(inWorkspace("sync/changes", workspaceId, cursor ? { cursor } : {}));

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
