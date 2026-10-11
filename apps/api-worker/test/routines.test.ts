import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { receiveRoutineWebhook } from "../src/routineWebhook.ts";
import {
  claim,
  type Claimed,
  count,
  envelope,
  executor,
  type Json,
  request,
  setup,
} from "./helpers.ts";

const db = env.DB;
const minute = 60_000;
const floorMinute = (ms: number) => Math.floor(ms / minute) * minute;

const webhookSignature = async (secret: string, body: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
};

const postWebhook = async (
  routineId: string,
  secret: string,
  payload: Json,
  deliveryId?: string,
) => {
  const body = JSON.stringify(payload);
  return request(`/v1/hooks/routines/${routineId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Hive-Signature": await webhookSignature(secret, body),
      ...(deliveryId === undefined ? {} : { "X-Hive-Delivery": deliveryId }),
    },
    body,
  });
};

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
    const runRequest = envelope(s.workspaceId, { type: "routine.run", routineId });
    const res = await s.user.command(runRequest);
    expect(res.status).toBe(200);
    const body = await res.json<Json>();
    expect(body).toMatchObject({
      routineId,
      jobId: expect.any(String),
      scheduledAt: expect.any(String),
    });
    expect(await (await s.user.command(runRequest)).json()).toEqual(body);
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

  it("accepts a displayed webhook secret once, verifies its original HMAC, deduplicates delivery ids, and fences payload JSON", async () => {
    const s = await setup();
    const create = envelope(
      s.workspaceId,
      {
        type: "routine.create",
        botId: s.botId,
        name: "hook",
        schedule: { kind: "webhook" },
        inputText: "Inspect this payload.",
      },
      "webhook-create",
    );
    const created = await s.user.command(create);
    expect(created.status).toBe(200);
    const first = await created.json<Json>();
    const secret = first.secret as string;
    const routineId = first.routineId as string;
    expect(secret).toMatch(/^hive_routine_[0-9a-f]{64}$/);
    expect(await (await s.user.command(create)).json()).toMatchObject({ secret: null });
    const stored = await db
      .prepare("SELECT webhook_secret_hash, next_fire_at FROM routines WHERE id = ?")
      .bind(routineId)
      .first<{ webhook_secret_hash: string; next_fire_at: string | null }>();
    expect(stored).toEqual({
      webhook_secret_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      next_fire_at: null,
    });
    expect(stored!.webhook_secret_hash).not.toBe(secret);
    const listed = await (
      await s.user.get(`/v1/routines?workspaceId=${s.workspaceId}&botId=${s.botId}`)
    ).json<{ routines: Json[] }>();
    expect(listed.routines).toContainEqual(
      expect.objectContaining({ id: routineId, hookPath: `/v1/hooks/routines/${routineId}` }),
    );

    const accepted = await postWebhook(routineId, secret, { ticket: 42 }, "delivery-1");
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json<Json>();
    expect(acceptedBody).toMatchObject({ routineId, jobId: expect.any(String) });
    const duplicate = await postWebhook(routineId, secret, { ticket: 42 }, "delivery-1");
    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true });
    expect(await count("routine_occurrences WHERE routine_id = ?", routineId)).toBe(1);
    await db
      .prepare("UPDATE routine_webhook_deliveries SET received_at = ? WHERE routine_id = ?")
      .bind(new Date(Date.now() - 8 * 24 * 60 * minute).toISOString(), routineId)
      .run();
    const reused = await postWebhook(routineId, secret, { ticket: 43 }, "delivery-1");
    expect(reused.status).toBe(200);
    expect(await reused.json()).toMatchObject({ routineId, jobId: expect.any(String) });
    expect(await count("routine_occurrences WHERE routine_id = ?", routineId)).toBe(2);

    const device = executor(s.deviceToken, s.workspaceId);
    const claimed = await (
      await device.command(claim(acceptedBody.jobId as string))
    ).json<Claimed>();
    const context = await (
      await device.get(
        `/v1/executor/jobs/${acceptedBody.jobId as string}/context?runId=${claimed.runId}&executionGeneration=1`,
      )
    ).json<{ inboxItem: { body: string } }>();
    expect(context.inboxItem.body).toBe(
      'Inspect this payload.\n\n```json\n{\n  "ticket": 42\n}\n```',
    );

    const receipt = await db
      .prepare(
        "SELECT response FROM operation_receipts WHERE json_extract(response, '$.operationId') = ?",
      )
      .bind(first.operationId)
      .first<{ response: string }>();
    expect(receipt!.response).not.toContain(secret);
    const fired = await db
      .prepare("SELECT data FROM events WHERE type = 'routine.fired' AND subject_id = ?")
      .bind(routineId)
      .first<{ data: string }>();
    expect(fired!.data).not.toContain(secret);

    const bad = await request(`/v1/hooks/routines/${routineId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hive-Signature": "sha256=bad" },
      body: '{"ticket":42}',
    });
    expect(bad.status).toBe(401);
    const malformedBody = "{";
    const malformed = await request(`/v1/hooks/routines/${routineId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hive-Signature": await webhookSignature(secret, malformedBody),
      },
      body: malformedBody,
    });
    expect(malformed.status).toBe(422);
    const tooLarge = await request(`/v1/hooks/routines/${routineId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(64 * 1024) }),
    });
    expect(tooLarge.status).toBe(413);

    await s.ok({ type: "routine.pause", routineId });
    expect((await postWebhook(routineId, secret, { ticket: 43 })).status).toBe(409);
  });

  it("fences a verified webhook when its Routine is paused before the acceptance batch", async () => {
    const { routineId, created } = await withRoutine({ schedule: { kind: "webhook" } });
    const secret = created.secret as string;
    const body = JSON.stringify({ race: true });
    const racedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await target
              .prepare("UPDATE routines SET enabled = 0 WHERE id = ?")
              .bind(routineId)
              .run();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    await expect(
      receiveRoutineWebhook(racedDb, {
        routineId,
        signature: await webhookSignature(secret, body),
        deliveryId: null,
        body: new TextEncoder().encode(body),
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT", reason: "routine_disabled" });
    expect(await count("routine_occurrences WHERE routine_id = ?", routineId)).toBe(0);
  });

  it("creates secrets for trigger cutover and rotation without replaying them", async () => {
    const { s, routineId } = await withRoutine();
    const update = envelope(
      s.workspaceId,
      {
        type: "routine.update",
        routineId,
        expectedRevision: 1,
        schedule: { kind: "webhook" },
      },
      "routine-to-webhook",
    );
    const updated = await s.user.command(update);
    const updateBody = await updated.json<Json>();
    const firstSecret = updateBody.secret as string;
    expect(updateBody).toMatchObject({
      revision: 2,
      nextFireAt: null,
      hookPath: `/v1/hooks/routines/${routineId}`,
      secret: expect.stringMatching(/^hive_routine_[0-9a-f]{64}$/),
    });
    expect(await (await s.user.command(update)).json()).toMatchObject({ secret: null });
    const row = await db
      .prepare("SELECT schedule_revision, next_fire_at FROM routines WHERE id = ?")
      .bind(routineId)
      .first<{ schedule_revision: number; next_fire_at: string | null }>();
    expect(row).toEqual({ schedule_revision: 2, next_fire_at: null });

    const rotate = envelope(
      s.workspaceId,
      { type: "routine.rotate_secret", routineId },
      "routine-rotate-secret",
    );
    const rotated = await s.user.command(rotate);
    const rotatedBody = await rotated.json<Json>();
    const rotatedSecret = rotatedBody.secret as string;
    expect(rotatedBody).toMatchObject({
      hookPath: `/v1/hooks/routines/${routineId}`,
      secret: expect.stringMatching(/^hive_routine_[0-9a-f]{64}$/),
    });
    expect(await (await s.user.command(rotate)).json()).toMatchObject({ secret: null });
    expect((await postWebhook(routineId, firstSecret, { old: true })).status).toBe(401);
    expect((await postWebhook(routineId, rotatedSecret, { current: true })).status).toBe(200);
  });

  it("limits webhooks durably to 60 requests per routine and minute", async () => {
    const { routineId, created } = await withRoutine({ schedule: { kind: "webhook" } });
    const secret = created.secret as string;
    const responses = await Promise.all(
      Array.from({ length: 61 }, (_, index) => postWebhook(routineId, secret, { index })),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(60);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
  });

  it("routes matching internal events to Routine occurrences with event identity and misfire policy", async () => {
    const { s, routineId, conversationId } = await withRoutine();
    const filter = { op: "eq", field: "type", value: "custom.demo.ping" };
    await s.ok({
      type: "routine.update",
      routineId,
      expectedRevision: 1,
      schedule: { kind: "event", filter },
    });
    const skipped = await s.ok({
      type: "routine.create",
      botId: s.botId,
      name: "skip old events",
      schedule: { kind: "event", filter },
      inputText: "Only timely events.",
      conversationId,
      misfire: "skip",
    });
    const skippedRoutineId = skipped.routineId as string;
    await s.ok({ type: "event.emit", event: { type: "custom.demo.ping", data: { value: 1 } } });
    await s.pump();
    expect(
      await count("routine_occurrences WHERE routine_id = ? AND state = 'created'", routineId),
    ).toBe(1);
    expect(
      await count(
        "routine_occurrences WHERE routine_id = ? AND state = 'created'",
        skippedRoutineId,
      ),
    ).toBe(1);

    const sameA = await s.ok({
      type: "event.emit",
      event: { type: "custom.demo.ping", data: { value: "same-a" } },
    });
    const sameB = await s.ok({
      type: "event.emit",
      event: { type: "custom.demo.ping", data: { value: "same-b" } },
    });
    const sameReceivedAt = new Date().toISOString();
    await db
      .prepare("UPDATE events SET received_at = ? WHERE id IN (?, ?)")
      .bind(sameReceivedAt, sameA.eventId as string, sameB.eventId as string)
      .run();
    await s.pump();
    expect(
      await count("routine_occurrences WHERE routine_id = ? AND state = 'created'", routineId),
    ).toBe(3);
    expect(
      await count(
        "routine_occurrences WHERE routine_id = ? AND state = 'created'",
        skippedRoutineId,
      ),
    ).toBe(3);

    await s.ok({ type: "event.emit", event: { type: "custom.demo.miss", data: { value: 2 } } });
    await s.pump();
    expect(
      await count("routine_occurrences WHERE routine_id IN (?, ?)", routineId, skippedRoutineId),
    ).toBe(6);

    const late = await s.ok({
      type: "event.emit",
      event: { type: "custom.demo.ping", data: { value: 3 } },
    });
    const lateEventId = late.eventId as string;
    await db
      .prepare("UPDATE events SET received_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 6 * minute).toISOString(), lateEventId)
      .run();
    await s.pump();
    expect(
      await count("routine_occurrences WHERE routine_id = ? AND state = 'created'", routineId),
    ).toBe(4);
    expect(
      await count(
        "routine_occurrences WHERE routine_id = ? AND state = 'skipped'",
        skippedRoutineId,
      ),
    ).toBe(1);
    const eventKey = await db
      .prepare(
        "SELECT occurrence_key, payload FROM routine_occurrences WHERE routine_id = ? AND occurrence_key = ?",
      )
      .bind(routineId, `event:${lateEventId}`)
      .first<{ occurrence_key: string; payload: string }>();
    expect(eventKey!.occurrence_key).toBe(`event:${lateEventId}`);
    expect(JSON.parse(eventKey!.payload)).toMatchObject({
      eventId: lateEventId,
      type: "custom.demo.ping",
      data: { value: 3 },
    });
    await s.ok({ type: "routine.pause", routineId });
    await s.ok({ type: "event.emit", event: { type: "custom.demo.ping", data: { value: 4 } } });
    await s.pump();
    expect(await count("routine_occurrences WHERE routine_id = ?", routineId)).toBe(4);
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
