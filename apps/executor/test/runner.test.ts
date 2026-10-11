import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeAdapter } from "../src/adapters/fake.ts";
import { fileJournal } from "../src/journal.ts";
import { type AgentAdapter, type JournalEntry, reconcile, runOnce } from "../src/runner.ts";
import { fakeCloud, memoryJournal, stale } from "./helpers.ts";

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

  it("stops the agent on a stale generation and submits nothing", async () => {
    const { cloud, calls } = fakeCloud({
      renewLease: async () => {
        throw stale();
      },
    });
    const journal = memoryJournal();
    const started = Date.now();
    const result = await runOnce({ cloud, journal, adapter: fakeAdapter({ delayMs: 5_000 }) });
    expect(result?.state).toBe("stale_generation");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).not.toContain("submit");
    expect(journal.entries.at(-1)).toEqual({
      kind: "result",
      runId: "run-1",
      state: "stale_generation",
    });
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
