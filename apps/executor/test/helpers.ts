import type { RunContext } from "@hive/contracts";
import { CloudError, type CloudClient } from "../src/cloudClient.ts";
import type { JournalEntry } from "../src/runner.ts";

export const memoryJournal = (entries: JournalEntry[] = []) => ({
  entries,
  append: async (entry: JournalEntry) => void entries.push(entry),
  readAll: async () => [...entries],
});

export const context: RunContext = {
  bot: { id: "bot-1", name: "coder", instructions: "Reply in one short sentence." },
  task: null,
  conversation: {
    id: "conv-1",
    channelId: "chan-1",
    recent: [{ actorKind: "user", actorId: "actor-1", body: "Say hello.", createdAt: "" }],
  },
  inboxItem: { id: "inbox-1", body: "Say hello." },
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
        job: { id: "job-1", botId: "bot-1", inboxItemId: "inbox-1", placement: {} as never },
      };
    },
    renewLease: async () => {
      calls.push("renew");
      return { leaseExpiresAt: lease() };
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
    ...overrides,
  };
  return { cloud, calls, submitted, observed };
};
