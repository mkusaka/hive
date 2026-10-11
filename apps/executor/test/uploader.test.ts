import { describe, expect, it } from "vitest";
import { fakeAdapter } from "../src/adapters/fake.ts";
import { runOnce } from "../src/runner.ts";
import { splitParts, transcriptUploader } from "../src/uploader.ts";
import { fakeCloud, memoryJournal } from "./helpers.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const decode = (parts: Uint8Array[]) => parts.map((p) => new TextDecoder().decode(p));

describe("splitParts", () => {
  it("splits after a newline within the limit and keeps an oversized line whole", () => {
    expect(decode(splitParts(bytes("aa\nbb\ncc\n"), 6))).toEqual(["aa\nbb\n", "cc\n"]);
    expect(decode(splitParts(bytes("a\nbbbbbbbb\nc\n"), 4))).toEqual(["a\n", "bbbbbbbb\n", "c\n"]);
    // A torn last line (no newline) is the tail of the last part.
    expect(decode(splitParts(bytes("aa\nbbbbbbb"), 4))).toEqual(["aa\n", "bbbbbbb"]);
    expect(splitParts(new Uint8Array())).toEqual([]);
  });
});

const noSleep = async () => {};

describe("transcriptUploader", () => {
  it("uploads every part, completes, then journals `uploaded`; a committed part is not re-sent", async () => {
    const { cloud, calls } = fakeCloud({
      uploadInit: async (input) => {
        calls.push(`init:${input.partSeq}`);
        return { uploadId: `up-${input.partSeq}`, partId: "", committed: input.partSeq === 0 };
      },
    });
    const journal = memoryJournal();
    const uploader = transcriptUploader({
      cloud,
      journal,
      read: async () => bytes(`${"a".repeat(700_000)}\n${"b".repeat(700_000)}\n`),
      provider: "claude",
    });
    expect(await uploader.upload("run-1")).toBe(true);
    expect(calls).toEqual(["init:0", "init:1", "put:up-1", "complete:1"]);
    expect(journal.entries).toEqual([{ kind: "uploaded", runId: "run-1", lastPartSeq: 1 }]);
  });

  it("never journals `uploaded` without the complete ACK, retries with backoff, then leaves it pending", async () => {
    const { cloud } = fakeCloud({
      uploadComplete: async () => {
        throw new Error("gap");
      },
    });
    const journal = memoryJournal([{ kind: "result", runId: "run-1", state: "succeeded" }]);
    const sleeps: number[] = [];
    const uploader = transcriptUploader({
      cloud,
      journal,
      read: async () => bytes("x\n"),
      provider: "claude",
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(await uploader.upload("run-1")).toBe(false);
    expect(sleeps).toEqual([1000, 2000]);
    expect(journal.entries.map((e) => e.kind)).toEqual(["result"]);
  });

  it("succeeds on a retry and `pending` uploads only finished Runs without a marker", async () => {
    let failures = 1;
    const { cloud, calls } = fakeCloud({
      uploadInit: async (input) => {
        if (failures-- > 0) throw new Error("network");
        calls.push(`init:${input.runId}`);
        return { uploadId: "u", partId: "", committed: false };
      },
    });
    const journal = memoryJournal([
      { kind: "result", runId: "run-1", state: "succeeded" },
      { kind: "result", runId: "run-2", state: "failed" },
      { kind: "uploaded", runId: "run-2", lastPartSeq: 0 },
      { kind: "result", runId: "run-3", state: "missing" },
    ]);
    const uploader = transcriptUploader({
      cloud,
      journal,
      read: async () => bytes("x\n"),
      provider: "claude",
      sleep: noSleep,
    });
    await uploader.pending();
    expect(calls.filter((c) => c.startsWith("init:"))).toEqual(["init:run-1"]);
    expect(journal.entries.at(-1)).toEqual({ kind: "uploaded", runId: "run-1", lastPartSeq: 0 });
  });

  it("completes an empty transcript with -1 when the Run wrote none", async () => {
    const { cloud, calls } = fakeCloud();
    const journal = memoryJournal();
    const uploader = transcriptUploader({
      cloud,
      journal,
      read: async () => null,
      provider: "fake",
    });
    expect(await uploader.upload("run-1")).toBe(true);
    expect(calls).toEqual(["complete:-1"]);
  });

  it("runs after the result in runOnce", async () => {
    const { cloud, calls } = fakeCloud();
    const journal = memoryJournal();
    const uploader = transcriptUploader({
      cloud,
      journal,
      read: async () => bytes("x\n"),
      provider: "fake",
    });
    await runOnce({ cloud, journal, adapter: fakeAdapter({ delayMs: 10 }), uploader });
    expect(journal.entries.map((e) => e.kind)).toEqual(["claim", "intent", "result", "uploaded"]);
    expect(calls.indexOf("submit")).toBeLessThan(calls.indexOf("init:0"));
  });
});
