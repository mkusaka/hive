import { env } from "cloudflare:test";
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
  setup,
} from "./helpers.ts";

const db = env.DB;
const past = () => new Date(Date.now() - 1_000).toISOString();

const heartbeat = (token: string) =>
  call("/v1/executor/heartbeat", { Authorization: `Bearer ${token}` }, {});

/** A claimed Job of the setup Bot. */
const claimed = async () => {
  const s = await setup();
  const job = await queuedJob(s);
  const device = executor(s.deviceToken, s.workspaceId);
  const run = await (await device.command(claim(job.jobId))).json<Claimed>();
  const fence = { runId: run.runId, executionGeneration: run.executionGeneration };
  const getJob = async () => (await s.user.get(`/v1/jobs/${job.jobId}`)).json<Json>();
  const control = (command: Json) => s.user.command(envelope(s.workspaceId, command));
  return { s, device, fence, getJob, control, ...job };
};

const expireLease = (runId: string) =>
  db.prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ?").bind(past(), runId).run();

const stopped = (token: string, fence: { runId: string; executionGeneration: number }) =>
  call(
    "/v1/executor/observations",
    { Authorization: `Bearer ${token}` },
    { ...fence, kind: "runtime.run.stopped", payload: { confirmed: true } },
  );

describe("job.cancel", () => {
  it("cancels a queued Job at once; it is never claimed", async () => {
    const s = await setup();
    await heartbeat(s.deviceToken);
    const { jobId } = await queuedJob(s);
    const res = await s.user.command(envelope(s.workspaceId, { type: "job.cancel", jobId }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ jobId, state: "cancelled", cancelRequested: true });
    expect(await (await s.user.get(`/v1/jobs/${jobId}`)).json()).toMatchObject({
      state: "cancelled",
      cancelRequestedAt: expect.any(String),
      runs: [],
    });
    const device = executor(s.deviceToken, s.workspaceId);
    expect((await device.command(claim(jobId, 2))).status).toBe(409);
  });

  it("asks an active Run to stop: renewal reports it and a failed result finishes the Job cancelled", async () => {
    const { s, device, fence, getJob, control, jobId } = await claimed();
    const renew = { type: "run.lease.renew", ...fence };
    expect(await (await device.command(renew)).json()).toMatchObject({ cancelRequested: false });

    const res = await control({ type: "job.cancel", jobId });
    expect(await res.json()).toMatchObject({ state: "active", cancelRequested: true });
    expect(await getJob()).toMatchObject({
      state: "active",
      cancelRequestedAt: expect.any(String),
    });
    expect(await (await device.command(renew)).json()).toMatchObject({ cancelRequested: true });

    const submit = { type: "run.result.submit", ...fence, state: "failed", summary: "stopped" };
    expect((await device.command({ ...submit, error: "cancelled" })).status).toBe(200);
    expect(await getJob()).toMatchObject({
      state: "cancelled",
      runs: [expect.objectContaining({ id: fence.runId, state: "cancelled" })],
    });
    expect(await count("executions WHERE run_id = ? AND state = 'interrupted'", fence.runId)).toBe(
      1,
    );
    expect(
      await count("resource_reservations WHERE run_id = ? AND released_at IS NULL", fence.runId),
    ).toBe(0);
    const inbox = await (await s.user.get(`/v1/inbox?botId=${s.botId}`)).json<{ items: Json[] }>();
    expect(inbox.items).toEqual([expect.objectContaining({ state: "failed" })]);
    // Terminal: cancelling again is a conflict.
    expect((await control({ type: "job.cancel", jobId })).status).toBe(409);
  });
});

describe("lease expiry (AT-13, AT-14)", () => {
  it("moves a Run whose launch was never confirmed to unknown; the Job needs recovery and keeps its reservation", async () => {
    const { s, device, fence, getJob, jobId } = await claimed();
    await expireLease(fence.runId);
    await s.pump();

    expect(await getJob()).toMatchObject({
      state: "recovery_required",
      runs: [
        expect.objectContaining({
          id: fence.runId,
          state: "unknown",
          generation: 1,
          deviceId: s.deviceId,
          startedAt: null,
          error: "lease_expired_before_start",
        }),
      ],
    });
    expect(
      await count("resource_reservations WHERE run_id = ? AND released_at IS NULL", fence.runId),
    ).toBe(1);
    // The old executor's control changes are fenced out.
    const renew = await device.command({ type: "run.lease.renew", ...fence });
    expect(await renew.json()).toMatchObject({ code: "STALE_GENERATION" });
    const listed = await (
      await s.user.get(`/v1/jobs?workspaceId=${s.workspaceId}&state=recovery_required`)
    ).json<{ jobs: Json[] }>();
    expect(listed.jobs.map((j) => j.id)).toEqual([jobId]);
    // A cancel goes through job.resolve.
    const cancel = await s.user.command(envelope(s.workspaceId, { type: "job.cancel", jobId }));
    expect(await cancel.json()).toMatchObject({ reason: "job_recovery_required" });
  });

  it("does the same for a started Run (no automatic re-run)", async () => {
    const { s, fence, getJob } = await claimed();
    const observe = await call(
      "/v1/executor/observations",
      { Authorization: `Bearer ${s.deviceToken}` },
      { ...fence, kind: "runtime.run.started", payload: { providerSessionId: "session-1" } },
    );
    expect(observe.status).toBe(200);
    expect((await getJob()).runs).toEqual([
      expect.objectContaining({ state: "running", startedAt: expect.any(String) }),
    ]);
    await expireLease(fence.runId);
    await s.pump();
    await s.pump();
    const job = await getJob();
    expect(job).toMatchObject({ state: "recovery_required" });
    expect(job.runs).toEqual([
      expect.objectContaining({ state: "unknown", error: "lease_expired" }),
    ]);
  });
});

describe("job.resolve", () => {
  it("retries only after the old Run's stop is confirmed; another device claims generation 2 (AT-12, AT-15)", async () => {
    const { s, device, fence, getJob, control, jobId } = await claimed();
    await expireLease(fence.runId);
    await s.pump();

    const early = await control({ type: "job.resolve", jobId, action: "retry" });
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ code: "RESOURCE_BUSY", reason: "unconfirmed_stop" });

    // The old executor reconciles: its agent is gone.
    expect((await stopped(s.deviceToken, fence)).status).toBe(200);
    expect((await stopped(s.deviceToken, fence)).status).toBe(200);
    expect(
      await count("resource_reservations WHERE run_id = ? AND released_at IS NULL", fence.runId),
    ).toBe(0);
    expect(await count("executions WHERE run_id = ? AND state = 'interrupted'", fence.runId)).toBe(
      1,
    );

    const retry = await control({ type: "job.resolve", jobId, action: "retry" });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ state: "queued" });

    const pc2 = await s.ok(register);
    await heartbeat(pc2.deviceToken as string);
    const second = executor(pc2.deviceToken as string, s.workspaceId);
    const { jobs } = await (
      await second.get("/v1/executor/jobs?state=queued")
    ).json<{
      jobs: { id: string; revision: number }[];
    }>();
    const queued = jobs.find((j) => j.id === jobId)!;
    const res = await second.command(claim(jobId, queued.revision));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ executionGeneration: 2 });

    // The old generation's result is rejected.
    const late = await device.command({
      type: "run.result.submit",
      ...fence,
      state: "succeeded",
      summary: "late",
    });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ code: "STALE_GENERATION" });
    expect(await getJob()).toMatchObject({
      state: "active",
      runs: [
        expect.objectContaining({ generation: 1, state: "interrupted" }),
        expect.objectContaining({ generation: 2, state: "starting", deviceId: pc2.deviceId }),
      ],
    });
  });

  it.each([
    ["cancel", "cancelled"],
    ["mark_failed", "failed"],
  ])("%s ends the Job; the unknown Run keeps its reservation", async (action, state) => {
    const { s, fence, getJob, control, jobId } = await claimed();
    expect((await control({ type: "job.resolve", jobId, action })).status).toBe(409);
    await expireLease(fence.runId);
    await s.pump();
    const res = await control({ type: "job.resolve", jobId, action });
    expect(res.status).toBe(200);
    expect(await getJob()).toMatchObject({
      state,
      runs: [expect.objectContaining({ state: "unknown" })],
    });
    expect(
      await count("resource_reservations WHERE run_id = ? AND released_at IS NULL", fence.runId),
    ).toBe(1);
  });

  it("rejects a stop confirmation for a Run that is still active", async () => {
    const { s, fence } = await claimed();
    const res = await stopped(s.deviceToken, fence);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "not_unknown" });
    const bad = await call(
      "/v1/executor/observations",
      { Authorization: `Bearer ${s.deviceToken}` },
      { ...fence, kind: "runtime.run.stopped", payload: {} },
    );
    expect(bad.status).toBe(422);
  });
});

describe("waiting_device (AT-12, AT-30)", () => {
  it("parks a Job whose allowed devices are all offline and requeues it on their heartbeat", async () => {
    const s = await setup();
    const pc2 = await s.ok(register);
    const { botId } = await s.ok({
      type: "bot.create",
      name: "pinned",
      placementPolicy: {
        mode: "pinned",
        allowedDeviceIds: [pc2.deviceId],
        preferredDeviceIds: [pc2.deviceId],
      },
    });
    const { jobId } = await queuedJob(s, botId as string);
    const job = async () => (await s.user.get(`/v1/jobs/${jobId}`)).json<Json>();
    expect(await job()).toMatchObject({ state: "waiting_device", revision: 2 });
    const waiting = await (
      await s.user.get(`/v1/jobs?workspaceId=${s.workspaceId}&state=waiting_device`)
    ).json<{ jobs: Json[] }>();
    expect(waiting.jobs.map((j) => j.id)).toEqual([jobId]);

    // Another device's heartbeat changes nothing.
    await heartbeat(s.deviceToken);
    expect(await job()).toMatchObject({ state: "waiting_device" });
    await heartbeat(pc2.deviceToken as string);
    expect(await job()).toMatchObject({ state: "queued", revision: 3 });
    expect(await count("change_log WHERE entity_kind = 'job' AND entity_id = ?", jobId)).toBe(3);
    // Online now: the pump leaves it queued.
    await s.pump();
    expect(await job()).toMatchObject({ state: "queued", revision: 3 });

    // Cancelling a waiting Job is immediate too.
    await db
      .prepare("UPDATE devices SET last_heartbeat_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 60_000).toISOString(), pc2.deviceId)
      .run();
    await s.pump();
    expect(await job()).toMatchObject({ state: "waiting_device" });
    const cancel = await s.user.command(envelope(s.workspaceId, { type: "job.cancel", jobId }));
    expect(await cancel.json()).toMatchObject({ state: "cancelled" });
  });

  it("rejects an unknown state filter", async () => {
    const s = await setup();
    expect((await s.user.get(`/v1/jobs?workspaceId=${s.workspaceId}&state=nope`)).status).toBe(422);
  });
});
