import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { sessionJournals, sessionStore } from "../src/sessionStore.ts";
import { transcriptUploader } from "../src/uploader.ts";
import { fakeCloud, memoryJournal } from "./helpers.ts";

const sessionId = "33333333-3333-4333-8333-333333333333";
const key = { projectKey: "-tmp-run-1", sessionId };
const stateDir = () => mkdtemp(join(tmpdir(), "hive-session-"));
const noCloud = { getSessionSnapshot: async () => null };
const entry = (
  uuid: string | undefined,
  extra: Record<string, unknown> = {},
): SessionStoreEntry => ({
  type: "user",
  ...(uuid ? { uuid } : {}),
  message: { content: [{ type: "text", text: uuid ?? "none" }], nested: { n: 1, list: [1, null] } },
  ...extra,
});

describe("sessionStore", () => {
  it("round-trips entries deep-equal through the fsynced journal", async () => {
    const dir = await stateDir();
    const entries = [entry("u1"), entry("u2", { timestamp: "2026-10-11T00:00:00.000Z" })];
    await sessionStore({ stateDir: dir, cloud: noCloud }).append(key, entries);
    // A fresh store (another process) reads the journal back.
    expect(await sessionStore({ stateDir: dir, cloud: noCloud }).load(key)).toEqual(entries);
    expect(await readFile(join(dir, "sessions", `${sessionId}.jsonl`), "utf8")).toBe(
      entries.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
  });

  it("keeps the first of each uuid in order, never dedupes entries without one, and keys by sessionId + subpath", async () => {
    const dir = await stateDir();
    const store = sessionStore({ stateDir: dir, cloud: noCloud });
    await store.append(key, [entry("u1"), entry(undefined), entry("u1", { late: true })]);
    await store.append(key, [entry("u2"), entry(undefined), entry("u1")]);
    expect(await store.load(key)).toEqual([
      entry("u1"),
      entry(undefined),
      entry("u2"),
      entry(undefined),
    ]);
    // A different projectKey is the same stream; a subpath is another one.
    expect(await store.load({ ...key, projectKey: "-other-cwd" })).toHaveLength(4);
    const sub = { ...key, subpath: "subagents/agent-a.b" };
    await store.append(sub, [entry("u1")]);
    expect(await store.load(sub)).toEqual([entry("u1")]);
    // Dedupe survives a restart: the journal seeds the uuid set.
    await sessionStore({ stateDir: dir, cloud: noCloud }).append(key, [entry("u2"), entry("u3")]);
    expect((await store.load(key))?.map((e) => e.uuid)).toEqual([
      "u1",
      undefined,
      "u2",
      undefined,
      "u3",
    ]);
  });

  it("serializes appends per stream", async () => {
    const dir = await stateDir();
    const store = sessionStore({ stateDir: dir, cloud: noCloud });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.append(key, [entry(`u${i}`), entry(`u${i}`)])),
    );
    expect((await store.load(key))?.map((e) => e.uuid)).toEqual(
      Array.from({ length: 20 }, (_, i) => `u${i}`),
    );
  });

  it("loads from the cloud snapshot when there is no local journal, then keeps it locally; null when unknown", async () => {
    const dir = await stateDir();
    const entries = [entry("u1"), entry(undefined)];
    const calls: unknown[] = [];
    const cloud = {
      getSessionSnapshot: async (provider: string, s: { sessionId: string }) => {
        calls.push([provider, s]);
        return s.sessionId === sessionId
          ? new TextEncoder().encode(entries.map((e) => `${JSON.stringify(e)}\n`).join(""))
          : null;
      },
    };
    const store = sessionStore({ stateDir: dir, cloud });
    expect(await store.load(key)).toEqual(entries);
    expect(await store.load(key)).toEqual(entries);
    expect(calls).toEqual([["claude", { sessionId }]]);
    // Appends after the load extend the journal and dedupe against it.
    await store.append(key, [entry("u1"), entry("u2")]);
    expect((await store.load(key))?.map((e) => e.uuid)).toEqual(["u1", undefined, "u2"]);

    const unknown = { ...key, sessionId: "44444444-4444-4444-8444-444444444444" };
    expect(await store.load(unknown)).toBeNull();
  });
});

describe("session journal upload", () => {
  it("uploads every session journal the Run's transcript names, after the transcript, before `uploaded`", async () => {
    const dir = await stateDir();
    await mkdir(join(dir, "transcripts"), { recursive: true });
    await writeFile(
      join(dir, "transcripts", "run-1.jsonl"),
      `${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`,
    );
    const store = sessionStore({ stateDir: dir, cloud: noCloud });
    await store.append(key, [entry("u1")]);
    await store.append({ ...key, subpath: "subagents/agent-1" }, [entry("s1")]);
    await store.append({ ...key, sessionId: "55555555-5555-4555-8555-555555555555" }, [entry("x")]);

    const sessions: unknown[] = [];
    const { cloud, calls } = fakeCloud({
      uploadComplete: async (input) => {
        calls.push(`complete:${input.lastPartSeq}`);
        sessions.push(input.session);
      },
    });
    const journal = memoryJournal();
    const uploader = transcriptUploader({
      cloud,
      journal,
      read: async () => new TextEncoder().encode("x\n"),
      sessions: sessionJournals(dir),
      provider: "claude",
    });
    expect(await uploader.upload("run-1")).toBe(true);
    expect(sessions).toEqual([
      undefined,
      { sessionId },
      { sessionId, subpath: "subagents/agent-1" },
    ]);
    expect(journal.entries).toEqual([{ kind: "uploaded", runId: "run-1", lastPartSeq: 0 }]);
  });
});
