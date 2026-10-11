// Transcript upload to R2 + D1 manifest, persistence and the read API (docs/architecture.md §3.3, §9.1, §13.2).
import { env } from "cloudflare:test";
import { createClient } from "@hive/cli/client";
import * as hive from "@hive/cli/commands";
import { fakeAdapter } from "@hive/executor/adapters/fake";
import { createCloudClient } from "@hive/executor/cloudClient";
import { type JournalEntry, runOnce } from "@hive/executor/runner";
import { transcriptUploader } from "@hive/executor/uploader";
import { describe, expect, it } from "vitest";
import { normalizeCodex } from "../src/transcripts.ts";
import {
  claim,
  type Claimed,
  count,
  executor,
  type Json,
  login,
  queuedJob,
  request,
  setup,
} from "./helpers.ts";

const db = env.DB;
const encoder = new TextEncoder();
const sha256 = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const jsonl = (...messages: unknown[]) =>
  encoder.encode(messages.map((m) => `${JSON.stringify(m)}\n`).join(""));

/** A claimed Run on the setup device, plus upload helpers authenticated with `token` (default: the device). */
const claimedRun = async () => {
  const s = await setup();
  const { jobId } = await queuedJob(s);
  const device = executor(s.deviceToken, s.workspaceId);
  const claimed = await (
    await device.command(claim(jobId))
  ).json<Claimed & { capability: { token: string } }>();
  const fence = { runId: claimed.runId, executionGeneration: claimed.executionGeneration };
  const uploads = (token = s.deviceToken) => {
    const auth = { Authorization: `Bearer ${token}` };
    const post = (path: string, body: unknown) =>
      request(path, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const init = async (partSeq: number, bytes: Uint8Array, sha?: string) =>
      post("/v1/executor/uploads/init", {
        runId: claimed.runId,
        partSeq,
        byteSize: bytes.length,
        sha256: sha ?? (await sha256(bytes)),
        provider: "claude",
      });
    const put = (uploadId: string, bytes: Uint8Array) =>
      request(`/v1/executor/uploads/${uploadId}`, { method: "PUT", headers: auth, body: bytes });
    /** init + PUT; returns the PUT response. */
    const upload = async (partSeq: number, bytes: Uint8Array) => {
      const res = await init(partSeq, bytes);
      expect(res.status).toBe(200);
      return put((await res.json<{ uploadId: string }>()).uploadId, bytes);
    };
    const complete = (lastPartSeq: number) =>
      post("/v1/executor/uploads/complete", { runId: claimed.runId, lastPartSeq });
    return { init, put, upload, complete };
  };
  const finish = () =>
    device.command({ type: "run.result.submit", ...fence, state: "succeeded", summary: "done" });
  const runInfo = async () =>
    (await s.user.get(`/v1/runs/${claimed.runId}`)).json<Json & { transcript: Json }>();
  return { s, jobId, claimed, uploads, finish, runInfo };
};

const part0 = jsonl(
  { type: "system", subtype: "init", session_id: "sess-1" },
  {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Using key sk-ant-abc123 and ghp_XYZ now" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ],
    },
  },
);
const part1 = jsonl(
  {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] },
  },
  { type: "result", subtype: "success", is_error: false, result: "x".repeat(5000) },
);

describe("transcript upload", () => {
  it("stores parts in R2 and the manifest, advances the watermark and completes persistence", async () => {
    const { claimed, uploads, finish, runInfo, s } = await claimedRun();
    const up = uploads();
    expect(await runInfo()).toMatchObject({ persistence: "pending", hasProviderSession: false });

    // Out of order: part 1 first leaves a gap at 0, so the watermark stays unset and complete is refused.
    const second = await up.upload(1, part1);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ committed: true, confirmedThroughSeq: null });
    const gap = await up.complete(1);
    expect(gap.status).toBe(409);
    expect(await gap.json()).toMatchObject({ code: "REVISION_CONFLICT", reason: "gap" });
    expect(await runInfo()).toMatchObject({ persistence: "pending" });

    const first = await up.upload(0, part0);
    expect(await first.json()).toMatchObject({ confirmedThroughSeq: 1 });
    const { results } = await db
      .prepare(
        `SELECT p.part_seq, p.r2_key, p.entry_count, p.byte_size, s.id AS stream_id
           FROM transcript_parts p JOIN transcript_streams s ON s.id = p.stream_id
          WHERE s.run_id = ? ORDER BY p.part_seq`,
      )
      .bind(claimed.runId)
      .all<{ part_seq: number; r2_key: string; entry_count: number; stream_id: string }>();
    expect(results.map((r) => [r.part_seq, r.entry_count])).toEqual([
      [0, 2],
      [1, 2],
    ]);
    expect(results[0]!.r2_key).toBe(
      `workspace/${s.workspaceId}/transcript/${results[0]!.stream_id}/0`,
    );
    const object = await env.R2.get(results[0]!.r2_key);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(part0);

    // The model succeeded; persistence completes separately (§9.1).
    expect((await finish()).status).toBe(200);
    expect(await runInfo()).toMatchObject({ state: "succeeded", persistence: "pending" });
    const done = await up.complete(1);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ runId: claimed.runId, persistence: "complete" });
    expect(await runInfo()).toMatchObject({
      persistence: "complete",
      finishedAt: expect.any(String),
      transcript: { parts: 2, confirmedThroughSeq: 1 },
    });
    // Complete is idempotent; the change row is written once so the UI refetches the Run.
    expect((await up.complete(1)).status).toBe(200);
    expect(
      await count(
        "change_log WHERE entity_kind = 'run' AND entity_id = ? AND workspace_id = ?",
        claimed.runId,
        s.workspaceId,
      ),
    ).toBe(3); // claim, result, persistence
  });

  it("rejects a body that does not match its sha256 and commits nothing", async () => {
    const { claimed, uploads } = await claimedRun();
    const up = uploads();
    const forged = await up.init(0, part0, await sha256(part1.slice(0, part0.length)));
    const res = await up.put((await forged.json<{ uploadId: string }>()).uploadId, part0);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "INVALID_INPUT", reason: "sha256_mismatch" });
    expect(
      await count(
        "transcript_parts p JOIN transcript_streams s ON s.id = p.stream_id WHERE s.run_id = ?",
        claimed.runId,
      ),
    ).toBe(0);
  });

  it("is idempotent for the same part and refuses a different hash for a committed seq", async () => {
    const { claimed, uploads } = await claimedRun();
    const up = uploads();
    expect((await up.upload(0, part0)).status).toBe(200);
    const again = await up.init(0, part0);
    expect(await again.json()).toMatchObject({ committed: true });
    expect((await up.upload(0, part0)).status).toBe(200);
    expect(
      await count(
        "transcript_parts p JOIN transcript_streams s ON s.id = p.stream_id WHERE s.run_id = ?",
        claimed.runId,
      ),
    ).toBe(1);

    const other = await up.init(0, part1);
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("accepts the Run capability while active and the device token after the Run is terminal", async () => {
    const { claimed, uploads, finish, runInfo, s } = await claimedRun();
    expect((await uploads(claimed.capability.token).upload(0, part0)).status).toBe(200);
    expect((await finish()).status).toBe(200);
    // The capability was revoked with the result; late parts come with the device token as history.
    expect((await uploads(claimed.capability.token).init(1, part1)).status).toBe(401);
    expect((await uploads().upload(1, part1)).status).toBe(200);
    expect((await uploads().complete(1)).status).toBe(200);
    expect(await runInfo()).toMatchObject({ state: "succeeded", persistence: "complete" });

    // Another device of the Workspace cannot upload for this Run.
    const second = await s.ok({
      type: "device.register",
      name: "pc2",
      os: "darwin",
      agentVersion: "0.0.0",
    });
    expect((await uploads(second.deviceToken as string).init(2, part0)).status).toBe(404);
  });

  it("completes an empty transcript with lastPartSeq -1", async () => {
    const { uploads, runInfo } = await claimedRun();
    expect((await uploads().complete(-1)).status).toBe(200);
    expect(await runInfo()).toMatchObject({ persistence: "complete", transcript: { parts: 0 } });
  });
});

describe("transcript read", () => {
  const uploaded = async () => {
    const r = await claimedRun();
    const up = r.uploads();
    await up.upload(0, part0);
    await up.upload(1, part1);
    await up.complete(1);
    return r;
  };

  it("pages the normalized, redacted view one part at a time", async () => {
    const { s, claimed } = await uploaded();
    const page0 = await (await s.user.get(`/v1/runs/${claimed.runId}/transcript`)).json<Json>();
    expect(page0).toEqual({
      entries: [
        { seq: 0, kind: "system", text: "init" },
        { seq: 1, kind: "assistant", text: "Using key [redacted] and [redacted] now" },
        { seq: 1, kind: "tool_use", text: '{"command":"ls"}', toolName: "Bash" },
      ],
      nextCursor: "1",
      confirmedThroughSeq: 1,
    });
    const page1 = await (
      await s.user.get(`/v1/runs/${claimed.runId}/transcript?cursor=1`)
    ).json<{ entries: { seq: number; kind: string; text: string }[]; nextCursor: null }>();
    expect(page1.nextCursor).toBeNull();
    expect(page1.entries.map((e) => [e.seq, e.kind])).toEqual([
      [2, "tool_result"],
      [3, "result"],
    ]);
    expect(page1.entries[1]!.text).toHaveLength(4096);
  });

  it("hides the transcript from non-members, bot-pair runs from members, and raw from non-owners", async () => {
    const { s, claimed } = await uploaded();
    const other = await login();
    const { userId } = await (await other.me()).json<{ userId: string }>();
    const actorId = crypto.randomUUID();
    await db.batch([
      db
        .prepare(
          "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')",
        )
        .bind(s.workspaceId, userId),
      db
        .prepare(
          "INSERT INTO actors (id, workspace_id, kind, user_id, display_name) VALUES (?, ?, 'user', ?, 'other')",
        )
        .bind(actorId, s.workspaceId, userId),
    ]);
    const transcript = `/v1/runs/${claimed.runId}/transcript`;
    // A Workspace member sees the Run, but not the transcript of a channel they are not in.
    expect((await other.get(`/v1/runs/${claimed.runId}`)).status).toBe(200);
    expect((await other.get(transcript)).status).toBe(404);

    await db
      .prepare(
        "INSERT INTO channel_members (workspace_id, channel_id, actor_id, role) VALUES (?, ?, ?, 'member')",
      )
      .bind(s.workspaceId, s.channelId, actorId)
      .run();
    expect((await other.get(transcript)).status).toBe(200);
    expect((await other.get(`/v1/transcripts/${claimed.runId}/raw`)).status).toBe(404);

    const raw = await s.user.get(`/v1/transcripts/${claimed.runId}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("Content-Type")).toBe("application/x-ndjson; charset=utf-8");
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(new Uint8Array([...part0, ...part1]));

    // A bot-pair conversation is owner-only.
    await db
      .prepare(
        `UPDATE conversations SET kind = 'bot_pair' WHERE id = (
           SELECT i.conversation_id FROM inbox_items i JOIN jobs j ON j.trigger_key = 'inbox:' || i.id
            JOIN runs r ON r.job_id = j.id WHERE r.id = ?)`,
      )
      .bind(claimed.runId)
      .run();
    expect((await other.get(transcript)).status).toBe(404);
    expect((await s.user.get(transcript)).status).toBe(200);
    // Raw content is never indexed.
    expect(await count("search_documents WHERE body LIKE '%sk-ant%'")).toBe(0);
  });
});

describe("executor uploader end to end", () => {
  it("fake run → transcript → uploader → the Run reports persistence complete", async () => {
    const s = await setup();
    const { jobId } = await queuedJob(s);
    const entries: JournalEntry[] = [];
    const journal = {
      append: async (e: JournalEntry) => void entries.push(e),
      readAll: async () => entries,
    };
    const cloud = createCloudClient({
      apiUrl: "https://hive.test",
      token: s.deviceToken,
      fetch: request,
    });
    const read = async () => new Uint8Array([...part0, ...part1]);
    const uploader = transcriptUploader({ cloud, journal, read, provider: "fake" });

    const result = await runOnce({
      cloud,
      journal,
      adapter: fakeAdapter({ delayMs: 10 }),
      uploader,
    });

    expect(result).toMatchObject({ jobId, state: "succeeded" });
    expect(entries.at(-1)).toEqual({ kind: "uploaded", runId: result!.runId, lastPartSeq: 0 });
    expect(await (await s.user.get(`/v1/runs/${result!.runId}`)).json()).toMatchObject({
      state: "succeeded",
      persistence: "complete",
      transcript: { parts: 1, confirmedThroughSeq: 0 },
    });
    const page = await (
      await s.user.get(`/v1/runs/${result!.runId}/transcript`)
    ).json<{ entries: unknown[] }>();
    expect(page.entries).toHaveLength(5);

    // The CLI's `run get` / `run transcript [--raw]`.
    const client = createClient({
      apiUrl: "https://hive.test",
      accessJwt: s.user.headers["Cf-Access-Jwt-Assertion"],
      fetch: request,
    });
    expect(await hive.getRun(client, result!.runId)).toMatchObject({ persistence: "complete" });
    expect((await hive.runTranscript(client, result!.runId)).map((e) => e.kind)).toEqual([
      "system",
      "assistant",
      "tool_use",
      "tool_result",
      "result",
    ]);
    expect(await hive.rawTranscript(client, result!.runId)).toBe(
      new TextDecoder().decode(new Uint8Array([...part0, ...part1])),
    );
  });
});

describe("Codex transcript view", () => {
  const lines: unknown[] = [
    { dir: "local", event: "spawn", pid: 1 },
    {
      dir: "out",
      msg: { id: 4, method: "turn/start", params: { input: [{ type: "text", text: "Say hi" }] } },
    },
    { dir: "in", msg: { method: "item/agentMessage/delta", params: { delta: "H" } } },
    {
      dir: "in",
      msg: { id: "s1", method: "item/commandExecution/requestApproval", params: { command: "ls" } },
    },
    { dir: "out", msg: { id: "s1", result: { decision: "accept" } } },
    {
      dir: "in",
      msg: {
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            command: "ls",
            status: "completed",
            exitCode: 0,
            aggregatedOutput: "a.txt",
          },
        },
      },
    },
    {
      dir: "in",
      msg: {
        method: "item/completed",
        params: { item: { type: "agentMessage", text: "Hi ghp_secret" } },
      },
    },
    {
      dir: "in",
      msg: {
        method: "item/completed",
        params: { item: { type: "subAgentActivity", agentThreadId: "thr-2" } },
      },
    },
    {
      dir: "in",
      msg: { method: "item/completed", params: { item: { type: "subAgentActivity" } } },
    },
    { dir: "in", msg: { method: "item/completed", params: { item: { type: "imageView" } } } },
    {
      dir: "in",
      msg: {
        method: "turn/completed",
        params: { turn: { status: "failed", items: [], error: { message: "boom" } } },
      },
    },
  ];

  it("maps protocol messages to normalized kinds and names sub-agents only by explicit id", () => {
    expect(lines.flatMap((l, i) => normalizeCodex(JSON.stringify(l), i))).toEqual([
      { seq: 0, kind: "system", text: "spawn" },
      { seq: 1, kind: "user", text: "Say hi" },
      { seq: 3, kind: "system", text: "approval requested: Bash ls" },
      { seq: 4, kind: "system", text: "approval: accept" },
      { seq: 5, kind: "tool_use", text: '{"command":"ls"}', toolName: "Bash" },
      { seq: 5, kind: "tool_result", text: "completed (exit 0)\na.txt" },
      { seq: 6, kind: "assistant", text: "Hi [redacted]" },
      { seq: 7, kind: "system", text: "sub-agent thread thr-2" },
      { seq: 9, kind: "system", text: "item imageView" },
      { seq: 10, kind: "result", text: "failed: boom" },
    ]);
  });
});
