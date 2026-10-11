// Bot tool policy, device environments and the approval broker (docs/architecture.md §10.1, §19; AT-35).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, claim, count, envelope, executor, type Json, queuedJob, setup } from "./helpers.ts";

const db = env.DB;
type Claimed = { runId: string; executionGeneration: number; capability: { token: string } };

const bash = (summary = "ls") => ({
  type: "approval.request",
  actionKind: "Bash",
  argsHash: "a".repeat(64),
  argsSummary: summary,
  cwdLabel: "run_scratch",
});

/** setup() plus a claimed Run of the setup Bot, acting through its capability. */
const running = async () => {
  const s = await setup();
  const device = executor(s.deviceToken, s.workspaceId);
  const { jobId } = await queuedJob(s);
  const run = await (await device.command(claim(jobId))).json<Claimed>();
  const auth = { Authorization: `Bearer ${run.capability.token}` };
  const asRun = {
    get: (path: string) => call(path, auth),
    command: (command: Json) => call("/v1/run/commands", auth, envelope(s.workspaceId, command)),
  };
  const runState = async () =>
    (await db.prepare("SELECT state FROM runs WHERE id = ?").bind(run.runId).first<{
      state: string;
    }>())!.state;
  const request = async () => {
    const res = await asRun.command(bash());
    expect(res.status).toBe(200);
    return (await res.json<{ approvalId: string; expiresAt: string }>()).approvalId;
  };
  const resolve = (approvalId: string, decision = "allow") =>
    s.user.command(envelope(s.workspaceId, { type: "approval.resolve", approvalId, decision }));
  const poll = async (id: string) => (await asRun.get(`/v1/run/approvals/${id}`)).json<Json>();
  return { ...s, device, jobId, run, asRun, runState, request, resolve, poll };
};

describe("bot tool policy", () => {
  it("defaults to deny-all, is set on create and replaced by bot.update with a revision CAS", async () => {
    const s = await setup();
    const { botId } = await s.ok({
      type: "bot.create",
      name: "shell",
      toolPolicy: { tools: { Read: "allow", Bash: "ask" } },
    });
    const bots = async () =>
      (
        (await (await s.user.get(`/v1/bots?workspaceId=${s.workspaceId}`)).json<Json>())
          .bots as Json[]
      ).find((b) => b.id === botId)!;
    expect(await bots()).toMatchObject({
      revision: 1,
      toolPolicy: { tools: { Read: "allow", Bash: "ask" }, cwdMode: "run_scratch" },
    });
    const coder = (
      (await (await s.user.get(`/v1/bots?workspaceId=${s.workspaceId}`)).json<Json>())
        .bots as Json[]
    ).find((b) => b.id === s.botId)!;
    expect(coder.toolPolicy).toEqual({ tools: {}, cwdMode: "run_scratch" });

    const update = (expectedRevision: number) =>
      s.user.command(
        envelope(s.workspaceId, {
          type: "bot.update",
          botId,
          expectedRevision,
          toolPolicy: { tools: { Bash: "deny" }, cwdMode: "environment" },
        }),
      );
    const ok = await update(1);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ revision: 2 });
    expect(await bots()).toMatchObject({
      revision: 2,
      toolPolicy: { tools: { Bash: "deny" }, cwdMode: "environment" },
    });
    expect(await count("change_log WHERE entity_kind = 'bot' AND entity_id = ?", botId)).toBe(2);
    const stale = await update(1);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "REVISION_CONFLICT",
      reason: "stale_revision",
    });
    // Unknown tools are rejected.
    const bad = await s.user.command(
      envelope(s.workspaceId, {
        type: "bot.update",
        botId,
        expectedRevision: 2,
        toolPolicy: { tools: { WebFetch: "allow" } },
      }),
    );
    expect(bad.status).toBe(422);
  });
});

describe("device environments", () => {
  it("make a Job eligible only on devices that registered the placement's environment", async () => {
    const s = await setup();
    const device = executor(s.deviceToken, s.workspaceId);
    const { botId } = await s.ok({
      type: "bot.create",
      name: "repo-bot",
      placementPolicy: { environmentId: "backend" },
      toolPolicy: { tools: { Read: "allow" }, cwdMode: "environment" },
    });
    const { jobId } = await queuedJob(s, botId as string);
    const listed = async () =>
      (
        (await (await device.get("/v1/executor/jobs?state=queued")).json<Json>()).jobs as Json[]
      ).map((j) => j.id);
    expect(await listed()).not.toContain(jobId);
    const refused = await device.command(claim(jobId));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ reason: "not_eligible" });

    const registered = await s.ok({
      type: "device.environment.register",
      deviceId: s.deviceId,
      name: "backend",
      repository: "git@github.com:example/backend.git",
    });
    // Re-registering keeps the id and replaces the repository identity.
    const again = await s.ok({
      type: "device.environment.register",
      deviceId: s.deviceId,
      name: "backend",
      repository: "https://github.com/example/backend.git",
    });
    expect(again.environmentId).toBe(registered.environmentId);
    expect(
      await db
        .prepare("SELECT repository FROM device_environments WHERE id = ?")
        .bind(registered.environmentId as string)
        .first(),
    ).toEqual({ repository: "https://github.com/example/backend.git" });

    expect(await listed()).toContain(jobId);
    const won = await device.command(claim(jobId));
    expect(won.status).toBe(200);
    const run = await won.json<Claimed>();
    const context = await (
      await device.get(
        `/v1/executor/jobs/${jobId}/context?runId=${run.runId}&executionGeneration=1`,
      )
    ).json<Json>();
    expect(context).toMatchObject({
      environment: "backend",
      bot: { toolPolicy: { tools: { Read: "allow" }, cwdMode: "environment" } },
    });

    // Only on the caller's own device.
    const other = await setup();
    const foreign = await other.user.command(
      envelope(other.workspaceId, {
        type: "device.environment.register",
        deviceId: s.deviceId,
        name: "backend",
        repository: "x",
      }),
    );
    expect(foreign.status).toBe(404);
  });
});

describe("approvals", () => {
  it("a Run's request is pending, puts the Run in waiting_approval and writes change rows", async () => {
    const r = await running();
    const approvalId = await r.request();
    expect(await r.runState()).toBe("waiting_approval");
    expect(
      await count("change_log WHERE entity_kind = 'approval' AND entity_id = ?", approvalId),
    ).toBe(1);
    expect(
      await count(
        "change_log WHERE entity_kind = 'run' AND entity_id = ? AND scope = ?",
        r.run.runId,
        `workspace:${r.workspaceId}`,
      ),
    ).toBe(2);
    expect(await r.poll(approvalId)).toMatchObject({
      id: approvalId,
      state: "pending",
      argsHash: "a".repeat(64),
    });
    const listed = await (
      await r.user.get(`/v1/approvals?workspaceId=${r.workspaceId}&state=pending`)
    ).json<Json>();
    expect(listed.approvals).toEqual([
      expect.objectContaining({
        id: approvalId,
        runId: r.run.runId,
        executionGeneration: 1,
        botName: "coder",
        actionKind: "Bash",
        argsSummary: "ls",
        cwdLabel: "run_scratch",
      }),
    ]);
    // The lease is still renewable while waiting.
    const renew = await r.device.command({
      type: "run.lease.renew",
      runId: r.run.runId,
      executionGeneration: 1,
    });
    expect(renew.status).toBe(200);
    // A summary over 2 KiB is refused.
    expect((await r.asRun.command(bash("x".repeat(2049)))).status).toBe(422);
  });

  it("resolves exactly once; the Run resumes running (AT-35)", async () => {
    const r = await running();
    const approvalId = await r.request();
    const first = await r.resolve(approvalId);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ approvalId, state: "approved" });
    expect(await r.poll(approvalId)).toMatchObject({ state: "approved" });
    expect(await r.runState()).toBe("running");
    const row = await db
      .prepare("SELECT resolved_by, resolved_at FROM approvals WHERE id = ?")
      .bind(approvalId)
      .first<{ resolved_by: string; resolved_at: string }>();
    expect(row!.resolved_by).toBe((await (await r.user.me()).json<Json>()).userId);

    for (const again of await Promise.all([r.resolve(approvalId), r.resolve(approvalId, "deny")])) {
      expect(again.status).toBe(409);
      // oxlint-disable-next-line no-await-in-loop -- reads an already received body
      expect(await again.json()).toMatchObject({
        code: "REVISION_CONFLICT",
        reason: "approval_approved",
      });
    }

    // A deny is recorded the same way; the Run stays waiting while another approval is pending.
    const a = await r.request();
    const b = await r.request();
    expect((await r.resolve(a, "deny")).status).toBe(200);
    expect(await r.poll(a)).toMatchObject({ state: "denied" });
    expect(await r.runState()).toBe("waiting_approval");
    expect((await r.resolve(b, "deny")).status).toBe(200);
    expect(await r.runState()).toBe("running");
  });

  it("rejects a resolve once the requesting Run is no longer current, and the sweep expires it", async () => {
    const r = await running();
    const approvalId = await r.request();
    // The lease expired: the Run is `unknown`, a new generation may follow (recovery).
    await db.prepare("UPDATE runs SET state = 'unknown' WHERE id = ?").bind(r.run.runId).run();
    const res = await r.resolve(approvalId);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "STALE_GENERATION",
      reason: "stale_generation",
    });

    expect((await r.pump()).approvalsExpired).toBeGreaterThanOrEqual(1);
    expect(
      await db
        .prepare("SELECT state, decision_reason FROM approvals WHERE id = ?")
        .bind(approvalId)
        .first(),
    ).toEqual({ state: "expired", decision_reason: "run_not_current" });
    // The unknown Run is not touched by the sweep.
    expect(await r.runState()).toBe("unknown");
  });

  it("expires a pending approval after its timeout: deny, the Run resumes", async () => {
    const r = await running();
    const approvalId = await r.request();
    await db
      .prepare("UPDATE approvals SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), approvalId)
      .run();
    expect((await r.pump()).approvalsExpired).toBeGreaterThanOrEqual(1);
    expect(await r.poll(approvalId)).toMatchObject({ state: "expired", decisionReason: "timeout" });
    expect(await r.runState()).toBe("running");
    const late = await r.resolve(approvalId);
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ reason: "approval_expired" });
  });

  it("a Run only sees its own approvals", async () => {
    const r = await running();
    const approvalId = await r.request();
    const other = await running();
    expect((await other.asRun.get(`/v1/run/approvals/${approvalId}`)).status).toBe(404);
    // Another workspace's member cannot resolve it.
    expect((await other.resolve(approvalId)).status).toBe(404);
  });
});
