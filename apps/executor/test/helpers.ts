import type { ApprovalStatus, RunContext } from "@hive/contracts";
import { CloudError, type CloudClient, type RunApi } from "../src/cloudClient.ts";
import type { JournalEntry } from "../src/runner.ts";

export const memoryJournal = (entries: JournalEntry[] = []) => ({
  entries,
  append: async (entry: JournalEntry) => void entries.push(entry),
  readAll: async () => [...entries],
});

export const context: RunContext = {
  bot: {
    id: "bot-1",
    name: "coder",
    instructions: "Reply in one short sentence.",
    toolPolicy: { tools: {}, cwdMode: "run_scratch" },
  },
  environment: null,
  task: null,
  conversation: {
    id: "conv-1",
    channelId: "chan-1",
    kind: "channel",
    recent: [{ actorKind: "user", actorId: "actor-1", body: "Say hello.", createdAt: "" }],
  },
  inboxItem: {
    id: "inbox-1",
    body: "Say hello.",
    messageId: "msg-1",
    kind: "request",
    fromBot: null,
  },
  batch: null,
  replies: [],
};

/**
 * Records `/v1/run/*` calls; `fail` makes every call throw that error. Approval polls answer `approvalStates` in order
 * (then `pending`), with the hash of the last `approval.request`.
 */
export const fakeRunApi = (fail?: Error, approvalStates: ApprovalStatus["state"][] = []) => {
  const calls: unknown[] = [];
  let argsHash = "";
  const api: RunApi = {
    command: async (body) => {
      calls.push(body);
      if (fail) throw fail;
      if (body.type === "approval.request") {
        argsHash = body.argsHash;
        return { status: "accepted", approvalId: "approval-1" };
      }
      return { status: "accepted", messageId: "msg-sent" };
    },
    getApproval: async (id) => {
      calls.push({ getApproval: id });
      if (fail) throw fail;
      const state = approvalStates.shift() ?? "pending";
      return {
        id,
        state,
        argsHash,
        expiresAt: "",
        decisionReason: state === "expired" ? "timeout" : null,
      };
    },
    getTask: async (taskId) => {
      calls.push({ getTask: taskId });
      if (fail) throw fail;
      return { id: taskId, revision: 3 };
    },
  };
  return { api, calls };
};

const lease = () => new Date(Date.now() + 40).toISOString();
export const stale = () => new CloudError(409, "STALE_GENERATION", "stale", "stale_generation");

// In-memory cloud: one queued Job, a short lease so renewals happen within the fake's delay.
export const fakeCloud = (overrides: Partial<CloudClient> = {}) => {
  const calls: string[] = [];
  const submitted: unknown[] = [];
  const observed: unknown[] = [];
  const cloud: CloudClient = {
    heartbeat: async () => void calls.push("heartbeat"),
    listQueuedJobs: async () => [
      {
        id: "job-1",
        botId: "bot-1",
        revision: 1,
        inboxItemId: "inbox-1",
        placement: {} as never,
        createdAt: "",
      },
    ],
    claim: async () => {
      calls.push("claim");
      return {
        runId: "run-1",
        executionId: "exec-1",
        executionGeneration: 1,
        leaseExpiresAt: lease(),
        capability: null,
        job: { id: "job-1", botId: "bot-1", inboxItemId: "inbox-1", placement: {} as never },
      };
    },
    renewLease: async () => {
      calls.push("renew");
      return { leaseExpiresAt: lease(), cancelRequested: false };
    },
    submitResult: async (input) => {
      calls.push("submit");
      submitted.push(input);
    },
    getRun: async (runId) => ({
      id: runId,
      jobId: "job-1",
      state: "running",
      executionGeneration: 1,
      active: true,
    }),
    getRunContext: async () => {
      calls.push("context");
      return context;
    },
    observe: async (input) => {
      calls.push("observe");
      observed.push(input);
    },
    forRun: () => fakeRunApi().api,
    ...overrides,
  };
  return { cloud, calls, submitted, observed };
};
