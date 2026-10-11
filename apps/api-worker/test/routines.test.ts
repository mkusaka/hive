import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { claim, type Claimed, count, envelope, executor, type Json, setup } from "./helpers.ts";

const db = env.DB;
const minute = 60_000;
const floorMinute = (ms: number) => Math.floor(ms / minute) * minute;

const withRoutine = async (spec: Json = {}) => {
  const s = await setup();
  const channels = await (
    await s.user.get(`/v1/channels?workspaceId=${s.workspaceId}`)
  ).json<{
    channels: { id: string; conversationId: string }[];
  }>();
  const conversationId = channels.channels.find((c) => c.id === s.channelId)!.conversationId;
  const created = await s.ok({
    type: "routine.create",
    botId: s.botId,
    name: "standup",
    schedule: { kind: "cron", expr: "* * * * *", timezone: "UTC" },
    inputText: "Post the standup summary.",
    conversationId,
    ...spec,
  });
  const routineId = created.routineId as string;
  const setNextFire = (at: number | string) =>
    db
      .prepare("UPDATE routines SET next_fire_at = ? WHERE id = ?")
      .bind(typeof at === "string" ? at : new Date(at).toISOString(), routineId)
      .run();
  const occurrences = async () =>
    (
      await db
        .prepare(
          "SELECT state, job_id, scheduled_at FROM routine_occurrences WHERE routine_id = ? ORDER BY scheduled_at",
        )
        .bind(routineId)
        .all<{ state: string; job_id: string | null; scheduled_at: string }>()
    ).results;
  return { s, created, routineId, conversationId, setNextFire, occurrences };
};

describe("routines", () => {
  it("creates one Job per occurrence for duplicate ticks (AT-31); the run context carries the input", async () => {
    const { s, created, routineId, conversationId, setNextFire, occurrences } = await withRoutine();
    expect(Date.parse(created.nextFireAt as string) % minute).toBe(0);
    const due = floorMinute(Date.now());
    await setNextFire(due);

    await Promise.all([s.pump(), s.pump(), s.pump()]);
    await s.pump();

    // One created occurrence (a minute boundary crossed meanwhile adds a skipped one before it).
    const fired = (await occurrences()).filter((r) => r.state === "created");
    expect(fired).toEqual([
      { state: "created", job_id: expect.any(String), scheduled_at: expect.any(String) },
    ]);
    expect(Date.parse(fired[0]!.scheduled_at)).toBeGreaterThanOrEqual(due);
    expect(
      await count(
        "jobs WHERE id IN (SELECT job_id FROM routine_occurrences WHERE routine_id = ?)",
        routineId,
      ),
    ).toBe(1);
    const jobId = fired[0]!.job_id!;
    expect(await (await s.user.get(`/v1/jobs/${jobId}`)).json()).toMatchObject({
      state: "queued",
      botId: s.botId,
    });
    const inbox = await (await s.user.get(`/v1/inbox?botId=${s.botId}`)).json<{ items: Json[] }>();
    expect(inbox.items).toEqual([
      expect.objectContaining({ purpose: "routine", lane: conversationId, conversationId }),
    ]);
    const routine = (
      await (
        await s.user.get(`/v1/routines?workspaceId=${s.workspaceId}`)
      ).json<{
        routines: Json[];
      }>()
    ).routines.find((row) => row.id === routineId);
    expect(routine).toMatchObject({
      id: routineId,
      enabled: true,
      scheduleRevision: 1,
      schedule: { kind: "cron", expr: "* * * * *", timezone: "UTC" },
    });
    expect(Date.parse(routine!.nextFireAt as string)).toBeGreaterThan(due);

    const device = executor(s.deviceToken, s.workspaceId);
    const run = await (await device.command(claim(jobId))).json<Claimed>();
    const context = await (
      await device.get(
        `/v1/executor/jobs/${jobId}/context?runId=${run.runId}&executionGeneration=1`,
      )
    ).json<Json>();
    expect(context).toMatchObject({
      inboxItem: { body: "Post the standup summary." },
      conversation: { id: conversationId, channelId: s.channelId },
    });
  });

  it("coalesce runs only the latest missed occurrence and records the rest as skipped", async () => {
    const { s, setNextFire, occurrences } = await withRoutine();
    const latest = floorMinute(Date.now());
    await setNextFire(latest - 10 * minute);
    await s.pump();
    const rows = await occurrences();
    const created = rows.filter((r) => r.state === "created");
    expect(created).toHaveLength(1);
    expect(Date.parse(created[0]!.scheduled_at)).toBeGreaterThanOrEqual(latest);
    expect(rows.filter((r) => r.state === "skipped").length).toBeGreaterThanOrEqual(10);
  });

  it("skip drops an occurrence more than 5 minutes late and runs a recent one", async () => {
    const late = await withRoutine({
      misfire: "skip",
      schedule: { kind: "once", at: new Date(Date.now() - 10 * minute).toISOString() },
    });
    const recent = await withRoutine({
      misfire: "skip",
      schedule: { kind: "once", at: new Date(Date.now() - minute).toISOString() },
    });
    await late.s.pump();
    expect(await late.occurrences()).toEqual([expect.objectContaining({ state: "skipped" })]);
    expect(await recent.occurrences()).toEqual([expect.objectContaining({ state: "created" })]);
    // A fired `once` has no next occurrence.
    expect(
      await count(
        "routines WHERE id IN (?, ?) AND next_fire_at IS NULL",
        late.routineId,
        recent.routineId,
      ),
    ).toBe(2);
  });

  it("pause stops new occurrences; resume restarts from now without catch-up", async () => {
    const { s, routineId, setNextFire, occurrences } = await withRoutine();
    const pause = (type: string) => s.ok({ type, routineId });
    await pause("routine.pause");
    await setNextFire(floorMinute(Date.now()) - 5 * minute);
    await s.pump();
    expect(await occurrences()).toEqual([]);

    const before = Date.now();
    const resumed = await pause("routine.resume");
    expect(Date.parse(resumed.nextFireAt as string)).toBeGreaterThan(before);
    await s.pump();
    expect(await occurrences()).toEqual([]);
  });

  it("lists routines filtered by botId", async () => {
    const { s, routineId } = await withRoutine();
    const list = async (botId: string) =>
      (
        await (
          await s.user.get(`/v1/routines?workspaceId=${s.workspaceId}&botId=${botId}`)
        ).json<{ routines: { id: string }[] }>()
      ).routines.map((r) => r.id);
    expect(await list(s.botId)).toContain(routineId);
    expect(await list("other-bot")).toEqual([]);
  });

  it("lists routines filtered by conversationId", async () => {
    const { s, routineId, conversationId } = await withRoutine();
    const list = async (id: string) =>
      (
        await (
          await s.user.get(`/v1/routines?workspaceId=${s.workspaceId}&conversationId=${id}`)
        ).json<{ routines: { id: string }[] }>()
      ).routines.map((r) => r.id);
    expect(await list(conversationId)).toEqual([routineId]);
    expect(await list("other-conversation")).toEqual([]);
  });

  it("routine.delete removes the Routine and its occurrences, keeps its Jobs; a missing one is a 404", async () => {
    const { s, routineId, occurrences } = await withRoutine();
    const ran = await s.ok({ type: "routine.run", routineId });
    expect(await occurrences()).toHaveLength(1);
    await s.ok({ type: "routine.delete", routineId });
    expect(await occurrences()).toEqual([]);
    expect(await count("routines WHERE id = ?", routineId)).toBe(0);
    expect(await (await s.user.get(`/v1/jobs/${ran.jobId as string}`)).json()).toMatchObject({
      state: "queued",
    });
    const missing = await s.user.command(
      envelope(s.workspaceId, { type: "routine.delete", routineId }),
    );
    expect(missing.status).toBe(404);
  });

  it("routine.run creates an occurrence and Job at now through the same path; a replay creates nothing", async () => {
    const { s, routineId, occurrences } = await withRoutine();
    const request = envelope(s.workspaceId, { type: "routine.run", routineId });
    const res = await s.user.command(request);
    expect(res.status).toBe(200);
    const body = await res.json<Json>();
    expect(body).toMatchObject({
      routineId,
      jobId: expect.any(String),
      scheduledAt: expect.any(String),
    });
    expect(await (await s.user.command(request)).json()).toEqual(body);
    expect(await occurrences()).toEqual([
      { state: "created", job_id: body.jobId, scheduled_at: body.scheduledAt },
    ]);
    expect(await (await s.user.get(`/v1/jobs/${body.jobId as string}`)).json()).toMatchObject({
      state: "queued",
    });
  });

  it("routine.update bumps schedule_revision on a schedule change and checks the revision", async () => {
    const { s, routineId } = await withRoutine();
    const update = (command: Json) =>
      s.user.command(envelope(s.workspaceId, { type: "routine.update", routineId, ...command }));
    const renamed = await update({ expectedRevision: 1, name: "daily" });
    expect(renamed.status).toBe(200);
    const rescheduled = await update({
      expectedRevision: 2,
      schedule: { kind: "cron", expr: "0 9 * * 1-5", timezone: "Asia/Tokyo" },
    });
    expect(await rescheduled.json()).toMatchObject({ revision: 3 });
    const row = await db
      .prepare("SELECT name, schedule_revision, next_fire_at FROM routines WHERE id = ?")
      .bind(routineId)
      .first<{ name: string; schedule_revision: number; next_fire_at: string }>();
    expect(row).toMatchObject({ name: "daily", schedule_revision: 2 });
    // 09:00 JST is 00:00 UTC.
    expect(row!.next_fire_at).toMatch(/T00:00:00\.000Z$/);
    const stale = await update({ expectedRevision: 1, name: "x" });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("rejects an invalid cron expression or timezone", async () => {
    const s = await setup();
    const statuses = await Promise.all(
      [
        { kind: "cron", expr: "61 * * * *", timezone: "UTC" },
        { kind: "cron", expr: "0 9 * * *", timezone: "Mars/Base" },
      ].map(async (schedule) => {
        const res = await s.user.command(
          envelope(s.workspaceId, {
            type: "routine.create",
            botId: s.botId,
            name: "bad",
            schedule,
            inputText: "x",
          }),
        );
        return res.status;
      }),
    );
    expect(statuses).toEqual([422, 422]);
  });
});
