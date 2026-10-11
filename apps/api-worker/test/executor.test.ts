import { env } from "cloudflare:test";
import { fakeAdapter } from "@hive/executor/adapters/fake";
import { createCloudClient } from "@hive/executor/cloudClient";
import { type JournalEntry, runOnce } from "@hive/executor/runner";
import { describe, expect, it } from "vitest";
import {
  call,
  envelope,
  type Json,
  register,
  request as fetchApp,
  setup,
  withWorkspace,
} from "./helpers.ts";

const db = env.DB;
const count = async (from: string, ...params: unknown[]) =>
  (await db
    .prepare(`SELECT COUNT(*) AS n FROM ${from}`)
    .bind(...params)
    .first<{ n: number }>())!.n;

const executor = (token: string, workspaceId: string) => {
  const auth = { Authorization: `Bearer ${token}` };
  return {
    get: (path: string) => call(path, auth),
    command: (command: unknown, idempotencyKey?: string) =>
      call("/v1/executor/commands", auth, envelope(workspaceId, command, idempotencyKey)),
  };
};

type Claimed = { runId: string; executionGeneration: number; leaseExpiresAt: string };

/** agent.send → pump → a queued Job for `botId` (default: the setup Bot). */
const queuedJob = async (s: Awaited<ReturnType<typeof setup>>, botId = s.botId) => {
  const request = s.send();
  (request.command as Json).recipientBotId = botId;
  const { inboxItemId } = await (await s.user.command(request)).json<{ inboxItemId: string }>();
  await s.pump();
  const op = await (await s.user.get(`/v1/operations/${request.operationId}`)).json<Json>();
  return { jobId: op.jobId as string, inboxItemId };
};

const claim = (jobId: string, expectedRevision = 1) => ({
  type: "job.claim",
  jobId,
  expectedRevision,
});

describe("executor job.claim", () => {
  it("claims a queued Job: Run, generation and lease; the Job goes active", async () => {
    const s = await setup();
    const { jobId, inboxItemId } = await queuedJob(s);
    const device = executor(s.deviceToken, s.workspaceId);

    const listed = await (await device.get("/v1/executor/jobs?state=queued")).json<Json>();
    expect(listed.jobs).toEqual([
      expect.objectContaining({ id: jobId, botId: s.botId, revision: 1, inboxItemId }),
    ]);

    const res = await device.command(claim(jobId), "claim-1");
    expect(res.status).toBe(200);
    const body = await res.json<Claimed & Json>();
    expect(body).toMatchObject({
      executionGeneration: 1,
      job: { id: jobId, botId: s.botId, inboxItemId, placement: { mode: "any" } },
    });
    expect(Date.parse(body.leaseExpiresAt) - Date.now()).toBeGreaterThan(80_000);
    expect(await (await s.user.get(`/v1/jobs/${jobId}`)).json()).toMatchObject({ state: "active" });
    expect(
      await count(
        "resource_reservations WHERE run_id = ? AND resource_key = ?",
        body.runId,
        `bot:${s.botId}`,
      ),
    ).toBe(1);
    expect(await (await device.get("/v1/executor/jobs?state=queued")).json()).toEqual({ jobs: [] });

    // A replay with the same key returns the stored claim even though the Job is no longer queued.
    const replay = await device.command(claim(jobId), "claim-1");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);
  });

  it("lets only one device hold the active root Run (AT-11)", async () => {
    const s = await setup();
    const { jobId } = await queuedJob(s);
    const second = await s.ok(register);
    expect((await executor(s.deviceToken, s.workspaceId).command(claim(jobId))).status).toBe(200);

    const res = await executor(second.deviceToken as string, s.workspaceId).command(claim(jobId));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "REVISION_CONFLICT",
      reason: "already_claimed",
    });
    expect(await count("runs WHERE job_id = ?", jobId)).toBe(1);
  });

  it("forbids a device the placement does not allow (not_eligible)", async () => {
    const s = await setup();
    const other = await s.ok(register);
    const { botId } = await s.ok({
      type: "bot.create",
      name: "pinned",
      placementPolicy: { mode: "pinned", allowedDeviceIds: [other.deviceId] },
    });
    const { jobId } = await queuedJob(s, botId as string);
    const device = executor(s.deviceToken, s.workspaceId);

    const res = await device.command(claim(jobId));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FORBIDDEN", reason: "not_eligible" });
    expect(await (await device.get("/v1/executor/jobs?state=queued")).json()).toEqual({ jobs: [] });
    const pinned = executor(other.deviceToken as string, s.workspaceId);
    expect((await pinned.command(claim(jobId))).status).toBe(200);
  });

  it("hides a Job from a device of another Workspace (404)", async () => {
    const s = await setup();
    const { jobId } = await queuedJob(s);
    const { user, workspaceId } = await withWorkspace();
    const { deviceToken } = await (
      await user.command(envelope(workspaceId, register))
    ).json<Json>();
    const outsider = executor(deviceToken as string, workspaceId);

    const res = await outsider.command(claim(jobId));
    expect(res.status).toBe(404);
    expect(await (await outsider.get("/v1/executor/jobs?state=queued")).json()).toEqual({
      jobs: [],
    });
    // Naming the other Workspace in the envelope is rejected before any lookup.
    const foreign = executor(deviceToken as string, s.workspaceId);
    expect((await foreign.command(claim(jobId))).status).toBe(403);
  });

  it("rejects a user principal and a missing state filter", async () => {
    const s = await setup();
    expect((await s.user.get("/v1/executor/jobs?state=queued")).status).toBe(401);
    const device = executor(s.deviceToken, s.workspaceId);
    expect((await device.get("/v1/executor/jobs")).status).toBe(422);
  });
});

describe("executor lease and result", () => {
  const claimed = async () => {
    const s = await setup();
    const job = await queuedJob(s);
    const device = executor(s.deviceToken, s.workspaceId);
    const run = await (await device.command(claim(job.jobId))).json<Claimed>();
    const fence = { runId: run.runId, executionGeneration: run.executionGeneration };
    return { s, device, fence, ...job };
  };

  it("renews the current generation and rejects a stale one (AT-15)", async () => {
    const { device, fence } = await claimed();
    const ok = await device.command({ type: "run.lease.renew", ...fence });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ leaseExpiresAt: expect.any(String) });

    const res = await device.command({ type: "run.lease.renew", ...fence, executionGeneration: 2 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "STALE_GENERATION",
      reason: "stale_generation",
    });
    const result = await device.command({
      type: "run.result.submit",
      ...fence,
      executionGeneration: 2,
      state: "succeeded",
      summary: "late",
    });
    expect(result.status).toBe(409);
  });

  it("finishes the Run: Job succeeded, inbox item processed, run.finished outbox; replay is stable", async () => {
    const { s, device, fence, jobId, inboxItemId } = await claimed();
    const submit = { type: "run.result.submit", ...fence, state: "succeeded", summary: "done" };
    const res = await device.command(submit, "result-1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    expect(await (await s.user.get(`/v1/jobs/${jobId}`)).json()).toMatchObject({
      state: "succeeded",
    });
    const inbox = await (await s.user.get(`/v1/inbox?botId=${s.botId}`)).json<{ items: Json[] }>();
    expect(inbox.items).toEqual([expect.objectContaining({ id: inboxItemId, state: "processed" })]);
    expect(
      await count(
        "runs WHERE id = ? AND state = 'succeeded' AND result_summary = 'done'",
        fence.runId,
      ),
    ).toBe(1);
    expect(
      await count(
        "outbox WHERE topic = 'run.finished' AND json_extract(payload, '$.runId') = ?",
        fence.runId,
      ),
    ).toBe(1);
    expect(await (await device.get(`/v1/executor/runs/${fence.runId}`)).json()).toMatchObject({
      state: "succeeded",
      active: false,
    });

    const replay = await device.command(submit, "result-1");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);
    const conflict = await device.command({ ...submit, summary: "other" }, "result-1");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("records the heartbeat", async () => {
    const s = await setup();
    const ok = await call(
      "/v1/executor/heartbeat",
      { Authorization: `Bearer ${s.deviceToken}` },
      {},
    );
    expect(ok.status).toBe(200);
    expect(await count("devices WHERE id = ? AND last_heartbeat_at IS NOT NULL", s.deviceId)).toBe(
      1,
    );
  });
});

describe("end to end", () => {
  it("agent.send → pump → executor runner claims, runs the fake and finishes the Job", async () => {
    const s = await setup();
    const { jobId, inboxItemId } = await queuedJob(s);
    const entries: JournalEntry[] = [];
    const cloud = createCloudClient({
      apiUrl: "https://hive.test",
      token: s.deviceToken,
      fetch: fetchApp,
    });

    const result = await runOnce({
      cloud,
      journal: { append: async (e) => void entries.push(e), readAll: async () => entries },
      adapter: fakeAdapter({ delayMs: 10 }),
    });

    expect(result).toMatchObject({ jobId, state: "succeeded" });
    expect(entries.map((e) => e.kind)).toEqual(["claim", "intent", "result"]);
    expect(await (await s.user.get(`/v1/jobs/${jobId}`)).json()).toMatchObject({
      state: "succeeded",
    });
    const inbox = await (await s.user.get(`/v1/inbox?botId=${s.botId}`)).json<{ items: Json[] }>();
    expect(inbox.items).toEqual([expect.objectContaining({ id: inboxItemId, state: "processed" })]);
    expect(
      await count(
        "runs WHERE job_id = ? AND result_summary = ?",
        jobId,
        `fake: handled inbox item ${inboxItemId}`,
      ),
    ).toBe(1);
    expect(
      await count("outbox WHERE topic = 'run.finished' AND workspace_id = ?", s.workspaceId),
    ).toBe(1);
  });
});
