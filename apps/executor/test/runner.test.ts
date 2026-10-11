import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeAdapter } from "../src/adapters/fake.ts";
import { fileJournal } from "../src/journal.ts";
import { type AgentAdapter, type JournalEntry, reconcile, runOnce } from "../src/runner.ts";
import { context, fakeCloud, fakeRunApi, memoryJournal, stale } from "./helpers.ts";

describe("runOnce", () => {
  it("claims, journals the intent before starting, renews the lease and submits the result", async () => {
    const { cloud, calls, submitted } = fakeCloud();
    const journal = memoryJournal();
    const inner = fakeAdapter({ delayMs: 60 });
    const adapter: AgentAdapter = {
      start: async (ctx) => {
        expect(journal.entries.map((e) => e.kind)).toEqual(["claim", "intent"]);
        return inner.start(ctx);
      },
    };

    const result = await runOnce({ cloud, journal, adapter });

    expect(result).toEqual({ runId: "run-1", jobId: "job-1", state: "succeeded" });
    expect(calls.slice(0, 3)).toEqual(["heartbeat", "claim", "context"]);
    expect(calls).toContain("renew");
    expect(calls.at(-1)).toBe("submit");
    expect(submitted).toEqual([
      {
        runId: "run-1",
        executionGeneration: 1,
        state: "succeeded",
        summary: "fake: handled inbox item inbox-1",
      },
    ]);
    expect(journal.entries.map((e) => e.kind)).toEqual(["claim", "intent", "result"]);
  });

  it("submits failed with the reason when the agent exits non-zero", async () => {
    const { cloud, submitted } = fakeCloud();
    const result = await runOnce({
      cloud,
      journal: memoryJournal(),
      adapter: fakeAdapter({ fail: true }),
    });
    expect(result?.state).toBe("failed");
    expect(submitted).toEqual([expect.objectContaining({ state: "failed", error: "FAKE_FAIL" })]);
  });

  it("stops the agent on a stale generation, submits nothing and confirms the stop", async () => {
    const { cloud, calls, observed } = fakeCloud({
      renewLease: async () => {
        throw stale();
      },
    });
    const journal = memoryJournal();
    const started = Date.now();
    const result = await runOnce({ cloud, journal, adapter: fakeAdapter({ delayMs: 5_000 }) });
    expect(result?.state).toBe("stopped");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).not.toContain("submit");
    expect(observed).toEqual([
      {
        runId: "run-1",
        executionGeneration: 1,
        kind: "runtime.run.stopped",
        payload: { confirmed: true },
      },
    ]);
    expect(journal.entries.at(-1)).toEqual({ kind: "result", runId: "run-1", state: "stopped" });
  });

  it("stops the agent when renewal reports cancelRequested and submits failed / cancelled", async () => {
    const stops: string[] = [];
    const { cloud, submitted } = fakeCloud({
      renewLease: async () => ({
        leaseExpiresAt: new Date(Date.now() + 40).toISOString(),
        cancelRequested: true,
      }),
    });
    const inner = fakeAdapter({ delayMs: 5_000 });
    const adapter: AgentAdapter = {
      start: async (ctx) => {
        const agent = await inner.start(ctx);
        return {
          ...agent,
          requestStop: async (reason) => (stops.push(reason), agent.requestStop(reason)),
        };
      },
    };
    const started = Date.now();
    const result = await runOnce({ cloud, journal: memoryJournal(), adapter });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(stops).toEqual(["cancelled"]);
    expect(result?.state).toBe("failed");
    expect(submitted).toEqual([expect.objectContaining({ state: "failed", error: "cancelled" })]);
  });

  it("writes a validated summary without posting a conversation reply", async () => {
    const { api, calls } = fakeRunApi();
    const summaryContext = {
      ...context,
      jobKind: "summarize" as const,
      summarization: {
        conversationId: "conv-1",
        botId: "bot-1",
        coversFromSeq: 1,
        coversToSeq: 2,
        messages: [],
        previousSummary: null,
      },
    };
    const { cloud, submitted } = fakeCloud({
      claim: async () => ({
        runId: "run-1",
        executionId: "exec-1",
        executionGeneration: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        capability: { token: "cap-1", expiresAt: "" },
        job: { id: "job-1", botId: "bot-1", inboxItemId: "inbox-1", placement: {} as never },
      }),
      getRunContext: async () => summaryContext,
      forRun: () => api,
    });
    const adapter: AgentAdapter = {
      start: async () => ({
        requestStop: async () => {},
        waitForExit: async () => ({
          code: 0,
          reason: "exited",
          summary: "claude: summary ready",
          replyText: "must not be posted",
          summaryOutput: {
            text: "The deploy window is Friday.",
            pinnedFacts: [
              { kind: "decision", text: "Deploy Friday.", sourceMessageIds: ["msg-1"] },
            ],
          },
        }),
      }),
    };

    expect(await runOnce({ cloud, journal: memoryJournal(), adapter })).toMatchObject({
      state: "succeeded",
    });
    expect(calls).toEqual([
      {
        type: "summary.write",
        conversationId: "conv-1",
        coversFromSeq: 1,
        coversToSeq: 2,
        text: "The deploy window is Friday.",
        pinnedFacts: [{ kind: "decision", text: "Deploy Friday.", sourceMessageIds: ["msg-1"] }],
      },
    ]);
    expect(submitted).toEqual([
      expect.objectContaining({ state: "succeeded", summary: "claude: summary ready" }),
    ]);
    expect(submitted[0]).not.toHaveProperty("reply");
  });

  it("applies a validated consolidation plan through only guarded memory commands", async () => {
    const { api, calls } = fakeRunApi();
    const consolidationContext = {
      ...context,
      jobKind: "consolidate" as const,
      consolidation: {
        scopeKind: "bot" as const,
        scopeId: "bot-1",
        memories: [
          {
            id: "memory-1",
            scopeKind: "bot" as const,
            scopeId: "bot-1",
            content: "Friday deploy.",
            sourceKind: "bot" as const,
            sourceId: "run-old",
            source: "explicit" as const,
            mergedFromIds: [],
            sourceConversationIds: ["conv-1"],
            proposedScope: null,
            revision: 1,
            supersedesId: null,
            createdAt: "",
          },
        ],
        summaries: [],
      },
    };
    const { cloud } = fakeCloud({
      claim: async () => ({
        runId: "run-1",
        executionId: "exec-1",
        executionGeneration: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        capability: { token: "cap-1", expiresAt: "" },
        job: { id: "job-1", botId: "bot-1", inboxItemId: null, placement: {} as never },
      }),
      getRunContext: async () => consolidationContext,
      forRun: () => api,
    });
    const adapter: AgentAdapter = {
      start: async () => ({
        requestStop: async () => {},
        waitForExit: async () => ({
          code: 0,
          reason: "exited",
          summary: "claude: consolidation ready",
          consolidationPlan: {
            writes: [
              {
                content: "Deploy Friday at 15:00.",
                mergedFrom: [{ id: "memory-1", revision: 1 }],
                sourceConversationIds: ["conv-1"],
                proposedScope: "workspace",
              },
            ],
            deletes: [{ id: "memory-1", revision: 1 }],
          },
        }),
      }),
    };

    expect(await runOnce({ cloud, journal: memoryJournal(), adapter })).toMatchObject({
      state: "succeeded",
    });
    expect(calls).toEqual([
      {
        type: "memory.write",
        scopeKind: "bot",
        scopeId: "bot-1",
        content: "Deploy Friday at 15:00.",
        source: "consolidation",
        mergedFrom: [{ id: "memory-1", revision: 1 }],
        sourceConversationIds: ["conv-1"],
        proposedScope: "workspace",
      },
      { type: "memory.delete", memoryId: "memory-1", expectedRevision: 1 },
    ]);
  });
});

describe("reconcile", () => {
  const claimed: JournalEntry = {
    kind: "claim",
    runId: "run-1",
    jobId: "job-1",
    executionGeneration: 1,
    inboxItemId: "inbox-1",
  };

  it("resumes an active Run of the same generation instead of claiming again", async () => {
    const { cloud, calls } = fakeCloud();
    const journal = memoryJournal([claimed, { kind: "intent", runId: "run-1" }]);
    const resumed = await reconcile({ cloud, journal, adapter: fakeAdapter() });
    expect(resumed).toEqual([{ runId: "run-1", jobId: "job-1", state: "succeeded" }]);
    expect(calls).not.toContain("claim");
    expect(calls).toContain("submit");
    // Already settled: a second reconcile does nothing.
    expect(await reconcile({ cloud, journal, adapter: fakeAdapter() })).toEqual([]);
  });

  it("writes a result marker for a Run that is already terminal", async () => {
    const { cloud, calls } = fakeCloud({
      getRun: async (id) => ({
        id,
        jobId: "job-1",
        state: "succeeded",
        executionGeneration: 1,
        active: false,
      }),
    });
    const journal = memoryJournal([claimed]);
    expect(await reconcile({ cloud, journal, adapter: fakeAdapter() })).toEqual([]);
    expect(calls).toEqual([]);
    expect(journal.entries.at(-1)).toEqual({ kind: "result", runId: "run-1", state: "succeeded" });
  });
});

const unknownRun = async (id: string) => ({
  id,
  jobId: "job-1",
  state: "unknown",
  executionGeneration: 1,
  active: false,
});

describe("reconcile of unknown Runs", () => {
  const claimed: JournalEntry = {
    kind: "claim",
    runId: "run-1",
    jobId: "job-1",
    executionGeneration: 1,
    inboxItemId: "inbox-1",
  };

  it.each([
    ["a claim without a result", [claimed, { kind: "intent", runId: "run-1" }] as JournalEntry[]],
    [
      "an unconfirmed stale result",
      [claimed, { kind: "result", runId: "run-1", state: "stale_generation" }] as JournalEntry[],
    ],
  ])("confirms the stop of %s, never restarting the agent", async (_, entries) => {
    const { cloud, calls, observed } = fakeCloud({ getRun: unknownRun });
    const journal = memoryJournal(entries);
    expect(await reconcile({ cloud, journal, adapter: fakeAdapter() })).toEqual([]);
    expect(calls).toEqual(["observe"]);
    expect(observed).toEqual([
      {
        runId: "run-1",
        executionGeneration: 1,
        kind: "runtime.run.stopped",
        payload: { confirmed: true },
      },
    ]);
    expect(journal.entries.at(-1)).toEqual({ kind: "result", runId: "run-1", state: "stopped" });
    // Settled: a second reconcile asks nothing.
    calls.length = 0;
    expect(await reconcile({ cloud, journal, adapter: fakeAdapter() })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("retries the confirmation on the next start when the cloud could not be told", async () => {
    const { cloud } = fakeCloud({
      getRun: unknownRun,
      observe: async () => {
        throw new Error("offline");
      },
    });
    const journal = memoryJournal([claimed]);
    await reconcile({ cloud, journal, adapter: fakeAdapter() });
    expect(journal.entries).toEqual([claimed]);
  });
});

describe("fileJournal", () => {
  it("appends and reads back entries, skipping a torn last line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hive-journal-"));
    const journal = await fileJournal(dir);
    expect(await journal.readAll()).toEqual([]);
    await journal.append({ kind: "intent", runId: "run-1" });
    await appendFile(join(dir, "journal.jsonl"), '{"kind":"res');
    expect(await journal.readAll()).toEqual([
      expect.objectContaining({ kind: "intent", runId: "run-1" }),
    ]);
  });
});
