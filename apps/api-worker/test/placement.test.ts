// Placement (docs/architecture.md §9.2, §10.1, §10.2; AT-02, AT-12, AT-22): the pure rules and the executor routes.
import { env } from "cloudflare:test";
import { PlacementPolicy, parse } from "@hive/contracts";
import { describe, expect, it } from "vitest";
import { type PlacementDevice, deviceReasons, refusal, shouldWait } from "../src/placement.ts";
import { call, claim, executor, type Json, queuedJob, register, setup } from "./helpers.ts";

const policy = (p: object) => {
  const parsed = parse(PlacementPolicy, p);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.value;
};
const now = Date.parse("2026-10-11T00:00:00Z");
const ago = (s: number) => new Date(now - s * 1000).toISOString();
const dev = (id: string, d: Partial<PlacementDevice> = {}): PlacementDevice => ({
  id,
  lastHeartbeatAt: ago(1),
  capabilities: ["bash"],
  environments: [],
  capacity: 1,
  active: 0,
  ...d,
});

describe("placement rules", () => {
  const preferred = policy({ mode: "preferred", preferredDeviceIds: ["pc1", "pc2"] });

  it("offers a preferred Job to the first-ranked device that is online with a free slot", () => {
    const pc1 = dev("pc1");
    const pc2 = dev("pc2");
    expect(refusal(preferred, [pc1, pc2], pc1, now)).toBeNull();
    expect(refusal(preferred, [pc1, pc2], pc2, now)).toBe("higher_ranked_online");
    // A device outside the preferred list ranks after both.
    expect(refusal(preferred, [pc1, pc2, dev("pc3")], dev("pc3"), now)).toBe(
      "higher_ranked_online",
    );
    expect(refusal(policy({}), [pc1, pc2], pc2, now)).toBeNull(); // mode any
  });

  it("falls back past an offline device only with fallbackOnUnavailable", () => {
    const pc1 = dev("pc1", { lastHeartbeatAt: ago(46) });
    const pc2 = dev("pc2");
    expect(refusal(preferred, [pc1, pc2], pc2, now)).toBeNull();
    const noFallback = { ...preferred, fallbackOnUnavailable: false };
    expect(refusal(noFallback, [pc1, pc2], pc2, now)).toBe("fallback_disabled");
  });

  it("overflows past a busy device only with overflowToFallback; the busy device itself is at capacity", () => {
    const pc1 = dev("pc1", { active: 1 });
    const pc2 = dev("pc2");
    expect(refusal(preferred, [pc1, pc2], pc2, now)).toBe("higher_ranked_online");
    expect(refusal({ ...preferred, overflowToFallback: true }, [pc1, pc2], pc2, now)).toBeNull();
    expect(refusal(preferred, [pc1, pc2], pc1, now)).toBe("at_capacity");
  });

  it("checks every higher-ranked device: an offline first and a busy second still keep the Job without overflow", () => {
    const three = policy({ mode: "preferred", preferredDeviceIds: ["pc1", "pc2", "pc3"] });
    const devices = [dev("pc1", { lastHeartbeatAt: null }), dev("pc2", { active: 1 }), dev("pc3")];
    expect(refusal(three, devices, devices[2]!, now)).toBe("higher_ranked_online");
    expect(refusal({ ...three, overflowToFallback: true }, devices, devices[2]!, now)).toBeNull();
  });

  it("ignores higher-ranked devices that miss a constraint, and names the constraint a device misses", () => {
    const needs = policy({
      mode: "preferred",
      preferredDeviceIds: ["pc1", "pc2"],
      requiredCapabilities: ["codex"],
      environmentId: "backend",
    });
    const pc1 = dev("pc1", { capabilities: ["bash"], environments: ["backend"] });
    const pc2 = dev("pc2", { capabilities: ["bash", "codex"], environments: ["backend"] });
    expect(refusal(needs, [pc1, pc2], pc1, now)).toBe("capability_missing");
    expect(refusal(needs, [pc1, pc2], pc2, now)).toBeNull();
    expect(refusal(needs, [pc1, pc2], dev("pc2", { capabilities: ["codex"] }), now)).toBe(
      "environment_missing",
    );
  });

  it("runs a pinned Job only on its device", () => {
    const pinned = policy({ mode: "pinned", preferredDeviceIds: ["pc2"] });
    expect(refusal(pinned, [dev("pc1"), dev("pc2")], dev("pc1"), now)).toBe("not_allowed");
    expect(refusal(pinned, [dev("pc1"), dev("pc2")], dev("pc2"), now)).toBeNull();
  });

  it("parks only constrained Jobs with no online device meeting them, and lists every device's reasons", () => {
    const pc1 = dev("pc1", { lastHeartbeatAt: ago(46) });
    const pc2 = dev("pc2", { active: 1 });
    const allowed = policy({ allowedDeviceIds: ["pc1"] });
    expect(shouldWait(allowed, [pc1, pc2], now)).toBe(true);
    expect(shouldWait(policy({}), [pc1], now)).toBe(false);
    // Busy is not unavailable: an online device at capacity keeps the Job queued.
    expect(shouldWait(policy({ allowedDeviceIds: ["pc2"] }), [pc1, pc2], now)).toBe(false);
    expect(deviceReasons(allowed, pc2, now)).toEqual(["not_allowed", "at_capacity"]);
    expect(deviceReasons(allowed, pc1, now)).toEqual(["offline"]);
  });
});

// ------------------------------------------------------------ over HTTP

const db = env.DB;

/** setup() (its device is pc1) plus pc2, both heartbeating with `capabilities`, and a Bot with `placementPolicy`. */
const twoDevices = async (placement: (pc1: string, pc2: string) => Json, pc2Caps = ["bash"]) => {
  const s = await setup();
  const pc2 = await s.ok({ ...register, name: "pc2" });
  const ids = { pc1: s.deviceId, pc2: pc2.deviceId as string };
  const tokens = { pc1: s.deviceToken, pc2: pc2.deviceToken as string };
  const device = (name: "pc1" | "pc2") => executor(tokens[name], s.workspaceId);
  const beat = (name: "pc1" | "pc2", body: Json = {}) =>
    call("/v1/executor/heartbeat", { Authorization: `Bearer ${tokens[name]}` }, body);
  await beat("pc1", { capabilities: ["bash", "claude", "codex"] });
  await beat("pc2", { capabilities: pc2Caps });
  const { botId } = await s.ok({
    type: "bot.create",
    name: "placed",
    placementPolicy: placement(ids.pc1, ids.pc2),
  });
  const listed = async (name: "pc1" | "pc2") =>
    (
      (await (await device(name).get("/v1/executor/jobs?state=queued")).json<Json>()).jobs as Json[]
    ).map((j) => j.id);
  const offline = (name: "pc1" | "pc2") =>
    db
      .prepare("UPDATE devices SET last_heartbeat_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 46_000).toISOString(), ids[name])
      .run();
  const getJob = async (jobId: string) => (await s.user.get(`/v1/jobs/${jobId}`)).json<Json>();
  return {
    s,
    ids,
    device,
    beat,
    listed,
    offline,
    getJob,
    job: () => queuedJob(s, botId as string),
    /** A Job of the setup Bot (any device): another Bot, so it does not share the `bot:` reservation. */
    otherJob: () => queuedJob(s),
  };
};

const preferred =
  (fields: Json = {}) =>
  (pc1: string, pc2: string) => ({
    mode: "preferred",
    allowedDeviceIds: [pc1, pc2],
    preferredDeviceIds: [pc1, pc2],
    ...fields,
  });

describe("placement over the executor routes", () => {
  it("offers a preferred Job to online pc1 only; pc2's claim is refused (AT-02)", async () => {
    const t = await twoDevices(preferred());
    const { jobId } = await t.job();
    expect(await t.listed("pc1")).toEqual([jobId]);
    expect(await t.listed("pc2")).toEqual([]);
    const refused = await t.device("pc2").command(claim(jobId));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      code: "FORBIDDEN",
      reason: "not_eligible",
      message: expect.stringContaining("higher_ranked_online"),
    });
    expect((await t.device("pc1").command(claim(jobId))).status).toBe(200);
  });

  it("lets pc2 take the Job when pc1 is offline and fallback is on (AT-12)", async () => {
    const t = await twoDevices(preferred());
    await t.offline("pc1");
    const { jobId } = await t.job();
    expect(await t.listed("pc2")).toEqual([jobId]);
    expect((await t.device("pc2").command(claim(jobId))).status).toBe(200);
  });

  it("keeps the Job for a busy pc1 without overflowToFallback; enforces pc1's capacity at claim", async () => {
    const t = await twoDevices(preferred());
    const first = await t.otherJob();
    expect((await t.device("pc1").command(claim(first.jobId))).status).toBe(200);
    const { jobId } = await t.job();
    expect(await t.listed("pc1")).toEqual([]); // at capacity: nothing offered
    expect(await t.listed("pc2")).toEqual([]);
    const busy = await t.device("pc1").command(claim(jobId));
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({
      code: "RESOURCE_BUSY",
      reason: "at_capacity",
      retryable: true,
    });
    expect((await t.device("pc2").command(claim(jobId))).status).toBe(403);
    expect(await t.getJob(jobId)).toMatchObject({ state: "queued", waitingReason: null });
  });

  it("lets pc2 take the overflow with overflowToFallback", async () => {
    const t = await twoDevices(preferred({ overflowToFallback: true }));
    const first = await t.otherJob();
    expect((await t.device("pc1").command(claim(first.jobId))).status).toBe(200);
    const { jobId } = await t.job();
    expect(await t.listed("pc2")).toEqual([jobId]);
    expect((await t.device("pc2").command(claim(jobId))).status).toBe(200);
  });

  it("takes a raised capacity from the heartbeat", async () => {
    const t = await twoDevices(() => ({}));
    const a = await t.otherJob();
    const b = await t.job();
    expect((await t.device("pc1").command(claim(a.jobId))).status).toBe(200);
    expect((await t.device("pc1").command(claim(b.jobId))).status).toBe(409);
    await t.beat("pc1", { capacity: { background: 2 } });
    expect((await t.device("pc1").command(claim(b.jobId))).status).toBe(200);
  });

  it("runs a pinned Job only on its device", async () => {
    const t = await twoDevices((_, pc2) => ({ mode: "pinned", preferredDeviceIds: [pc2] }));
    const { jobId } = await t.job();
    expect(await t.listed("pc1")).toEqual([]);
    const refused = await t.device("pc1").command(claim(jobId));
    expect(await refused.json()).toMatchObject({ message: expect.stringContaining("not_allowed") });
    expect((await t.device("pc2").command(claim(jobId))).status).toBe(200);
  });

  it("parks a Job whose capability no online device has, explains why, and resumes it on an eligible heartbeat", async () => {
    const t = await twoDevices(preferred({ requiredCapabilities: ["codex"] }));
    await t.offline("pc1");
    const { jobId } = await t.job(); // the pump in queuedJob parks it
    expect(await t.getJob(jobId)).toMatchObject({
      state: "waiting_device",
      waitingReason: {
        code: "no_eligible_device",
        devices: expect.arrayContaining([
          { deviceId: t.ids.pc1, reasons: ["offline"] },
          { deviceId: t.ids.pc2, reasons: ["capability_missing"] },
        ]),
      },
    });
    const refused = await t.device("pc2").command(claim(jobId, 2));
    expect(await refused.json()).toMatchObject({
      message: expect.stringContaining("capability_missing"),
    });
    // pc2's heartbeat does not requeue a Job it cannot run; pc1's does.
    await t.beat("pc2");
    expect(await t.getJob(jobId)).toMatchObject({ state: "waiting_device" });
    await t.beat("pc1");
    expect(await t.getJob(jobId)).toMatchObject({
      state: "queued",
      revision: 3,
      waitingReason: null,
    });
    expect(await t.listed("pc1")).toEqual([jobId]);
  });

  it("waits when pc2 lacks the environment pc1 has, with environment_missing (AT-22)", async () => {
    const t = await twoDevices(preferred({ environmentId: "backend" }));
    await t.s.ok({
      type: "device.environment.register",
      deviceId: t.ids.pc1,
      name: "backend",
      repository: "git@github.com:example/backend.git",
    });
    await t.offline("pc1");
    const { jobId } = await t.job();
    expect(await t.getJob(jobId)).toMatchObject({
      state: "waiting_device",
      waitingReason: {
        devices: expect.arrayContaining([
          { deviceId: t.ids.pc2, reasons: ["environment_missing"] },
        ]),
      },
    });
    const refused = await t.device("pc2").command(claim(jobId, 2));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      message: expect.stringContaining("environment_missing"),
    });
  });

  it("stores and lists the heartbeat's capabilities and capacity", async () => {
    const t = await twoDevices(() => ({}), ["bash", "env:backend"]);
    await t.beat("pc2", { capacity: { background: 3 } });
    const { devices } = await (
      await t.s.user.get(`/v1/devices?workspaceId=${t.s.workspaceId}`)
    ).json<{ devices: Json[] }>();
    expect(devices.find((d) => d.id === t.ids.pc2)).toMatchObject({
      capabilities: ["bash", "env:backend"],
      capacityBackground: 3,
      lastHeartbeatAt: expect.any(String),
    });
    expect((await t.beat("pc2", { capacity: { background: 0 } })).status).toBe(422);
  });

  it("updates a Bot's placement; a preferred device outside the allowed list is rejected", async () => {
    const t = await twoDevices(() => ({}));
    const bots = async () =>
      (
        await (
          await t.s.user.get(`/v1/bots?workspaceId=${t.s.workspaceId}`)
        ).json<{ bots: Json[] }>()
      ).bots;
    const bot = (await bots()).find((b) => b.name === "placed")!;
    const update = (placementPolicy: Json) =>
      t.s.user.command({
        operationId: crypto.randomUUID(),
        idempotencyKey: crypto.randomUUID(),
        workspaceId: t.s.workspaceId,
        command: { type: "bot.update", botId: bot.id, expectedRevision: 1, placementPolicy },
      });
    expect(
      (await update({ allowedDeviceIds: [t.ids.pc1], preferredDeviceIds: [t.ids.pc2] })).status,
    ).toBe(422);
    expect((await update({ mode: "pinned", preferredDeviceIds: [t.ids.pc2] })).status).toBe(200);
    expect((await bots()).find((b) => b.id === bot.id)).toMatchObject({
      placementPolicy: { mode: "pinned", preferredDeviceIds: [t.ids.pc2] },
    });
  });
});
