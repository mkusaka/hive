// Native session snapshot streams (docs/architecture.md §13.3): uploaded as `kind = 'session'` parts, read back by
// another device of the Workspace for a cross-PC resume, never by users and never indexed.
import { env } from "cloudflare:test";
import { createCloudClient } from "@hive/executor/cloudClient";
import { uploadTranscript } from "@hive/executor/uploader";
import { describe, expect, it } from "vitest";
import {
  call,
  claim,
  type Claimed,
  count,
  envelope,
  executor,
  type Json,
  queuedJob,
  register,
  request,
  setup,
} from "./helpers.ts";

const db = env.DB;
const encoder = new TextEncoder();
const jsonl = (...entries: unknown[]) =>
  new Uint8Array(encoder.encode(entries.map((e) => `${JSON.stringify(e)}\n`).join("")));
const sha256 = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const sessionId = "22222222-2222-4222-8222-222222222222";
const session = { sessionId };
const part0 = jsonl({ type: "user", uuid: "u1", message: { content: "session-marker-zq" } });
const part1 = jsonl({ type: "assistant", uuid: "a1", message: { content: [] } });

const cloudFor = (token: string) =>
  createCloudClient({ apiUrl: "https://hive.test", token, fetch: request });
type Cloud = ReturnType<typeof cloudFor>;

const uploadPart = async (cloud: Cloud, runId: string, partSeq: number, bytes: Uint8Array) => {
  const init = await cloud.uploadInit({
    runId,
    partSeq,
    byteSize: bytes.length,
    sha256: await sha256(bytes),
    provider: "claude",
    session,
  });
  if (!init.committed) await cloud.uploadPart(init.uploadId, bytes);
  return init;
};

const claimedRun = async () => {
  const s = await setup();
  const { jobId } = await queuedJob(s);
  const device = executor(s.deviceToken, s.workspaceId);
  const run = await (await device.command(claim(jobId))).json<Claimed>();
  return { s, jobId, device, run, cloud: cloudFor(s.deviceToken) };
};

const initUpload = (token: string, body: Json) =>
  call("/v1/executor/uploads/init", { Authorization: `Bearer ${token}` }, body);

describe("native session streams", () => {
  it("serves only a complete snapshot; a duplicate part is ignored; the Run's transcript is untouched", async () => {
    const { s, run, cloud } = await claimedRun();
    expect(await cloud.getSessionSnapshot("claude", session)).toBeNull();

    // Part 1 alone leaves a gap: complete is refused and nothing is served.
    await uploadPart(cloud, run.runId, 1, part1);
    await expect(
      cloud.uploadComplete({ runId: run.runId, lastPartSeq: 1, session }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT", reason: "gap" });
    expect(await cloud.getSessionSnapshot("claude", session)).toBeNull();

    expect(await uploadPart(cloud, run.runId, 0, part0)).toMatchObject({ committed: false });
    // Not complete until `complete` is ACKed, even with every part confirmed.
    expect(await cloud.getSessionSnapshot("claude", session)).toBeNull();
    // A replayed part is already committed.
    expect(await uploadPart(cloud, run.runId, 0, part0)).toMatchObject({ committed: true });
    await cloud.uploadComplete({ runId: run.runId, lastPartSeq: 1, session });
    expect(await cloud.getSessionSnapshot("claude", session)).toEqual(
      new Uint8Array([...part0, ...part1]),
    );
    expect(
      await count(
        "transcript_parts p JOIN transcript_streams t ON t.id = p.stream_id WHERE t.run_id = ?",
        run.runId,
      ),
    ).toBe(2);
    // Other keys are other streams.
    expect(
      await cloud.getSessionSnapshot("claude", { sessionId, subpath: "subagents/agent-1" }),
    ).toBeNull();
    expect(await cloud.getSessionSnapshot("codex", session)).toBeNull();

    // The Run's own transcript stream and persistence are separate.
    expect(await (await s.user.get(`/v1/runs/${run.runId}`)).json()).toMatchObject({
      persistence: "pending",
      transcript: { parts: 0, confirmedThroughSeq: null },
    });
    await uploadTranscript(cloud, run.runId, jsonl({ type: "result" }), "claude");
    expect(await (await s.user.get(`/v1/runs/${run.runId}`)).json()).toMatchObject({
      persistence: "complete",
      transcript: { parts: 1, confirmedThroughSeq: 0 },
    });

    // Raw native data: not in the owner's raw or normalized transcript, not on a user route, never indexed.
    const raw = await s.user.get(`/v1/transcripts/${run.runId}/raw`);
    expect(new TextDecoder().decode(await raw.arrayBuffer())).toBe('{"type":"result"}\n');
    const page = await (await s.user.get(`/v1/runs/${run.runId}/transcript`)).text();
    expect(page).not.toContain("session-marker-zq");
    const asUser = await call(`/v1/executor/sessions/claude/${sessionId}`, s.user.headers);
    expect(asUser.status).toBe(401);
    await s.pump();
    expect(await count("search_documents WHERE body LIKE '%session-marker-zq%'")).toBe(0);
  });

  it("requires the provider for a session stream and a device's own Run to upload", async () => {
    const { s, run } = await claimedRun();
    const body = {
      runId: run.runId,
      partSeq: 0,
      byteSize: part0.length,
      sha256: await sha256(part0),
      session,
    };
    expect(await (await initUpload(s.deviceToken, body)).json()).toMatchObject({
      code: "INVALID_INPUT",
    });
    const pc2 = await s.ok(register);
    expect(
      (await initUpload(pc2.deviceToken as string, { ...body, provider: "claude" })).status,
    ).toBe(404);
  });

  it("a successor Run on another device gets the earlier session id and its newest complete snapshot", async () => {
    const { s, jobId, device, run, cloud } = await claimedRun();
    const fence = { runId: run.runId, executionGeneration: run.executionGeneration };
    const context = async (token: string, f: typeof fence) =>
      (
        await call(
          `/v1/executor/jobs/${jobId}/context?runId=${f.runId}&executionGeneration=${f.executionGeneration}`,
          { Authorization: `Bearer ${token}` },
        )
      ).json<{ previousProviderSessionId: string | null }>();
    expect(await context(s.deviceToken, fence)).toMatchObject({ previousProviderSessionId: null });
    await device.post("/v1/executor/observations", {
      ...fence,
      kind: "runtime.run.started",
      payload: { providerSessionId: sessionId },
    });
    await uploadTranscript(cloud, run.runId, part0, "claude", session);

    // PC1's lease expires; its stop is confirmed; the Job is retried on PC2 (generation 2).
    await db
      .prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), run.runId)
      .run();
    await s.pump();
    await device.post("/v1/executor/observations", {
      ...fence,
      kind: "runtime.run.stopped",
      payload: { confirmed: true },
    });
    const control = await s.user.command(
      envelope(s.workspaceId, { type: "job.resolve", jobId, action: "retry" }),
    );
    expect(control.status).toBe(200);
    const pc2 = await s.ok(register);
    const pc2Token = pc2.deviceToken as string;
    await call("/v1/executor/heartbeat", { Authorization: `Bearer ${pc2Token}` }, {});
    const { jobs } = await (
      await executor(pc2Token, s.workspaceId).get("/v1/executor/jobs?state=queued")
    ).json<{ jobs: { id: string; revision: number }[] }>();
    const second = await (
      await executor(pc2Token, s.workspaceId).command(
        claim(jobId, jobs.find((j) => j.id === jobId)!.revision),
      )
    ).json<Claimed>();
    expect(second.executionGeneration).toBe(2);
    const fence2 = { runId: second.runId, executionGeneration: 2 };

    expect(await context(pc2Token, fence2)).toMatchObject({ previousProviderSessionId: sessionId });
    const pc2Cloud = cloudFor(pc2Token);
    expect(await pc2Cloud.getSessionSnapshot("claude", session)).toEqual(part0);

    // PC2 resumes and uploads its longer snapshot; a late re-upload from PC1 stays history.
    await uploadTranscript(
      pc2Cloud,
      second.runId,
      new Uint8Array([...part0, ...part1]),
      "claude",
      session,
    );
    await uploadTranscript(cloud, run.runId, part0, "claude", session);
    expect(await pc2Cloud.getSessionSnapshot("claude", session)).toEqual(
      new Uint8Array([...part0, ...part1]),
    );
  });
});
