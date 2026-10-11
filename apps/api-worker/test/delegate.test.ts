// task.delegate (docs/architecture.md §8.1): authority, the delegated Run's Task access, completion and expiry.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, claim, count, envelope, executor, type Json, setup } from "./helpers.ts";

const db = env.DB;
type Claimed = { runId: string; executionGeneration: number; capability: { token: string } };

const errorOf = async (res: Response) => ({ status: res.status, ...(await res.json<Json>()) });

/** setup() plus Bots `helper` and `other`, a Task APP-1, and helpers to act as the device and a Run. */
const world = async () => {
  const s = await setup();
  const { botId: helperId } = await s.ok({ type: "bot.create", name: "helper" });
  const { botId: otherId } = await s.ok({ type: "bot.create", name: "other" });
  await s.ok({ type: "project.create", key: "APP", name: "app" });
  const { taskId } = await s.ok({ type: "task.create", projectKey: "APP", title: "build" });
  const device = executor(s.deviceToken, s.workspaceId);
  await device.post("/v1/executor/heartbeat", { capacity: { background: 8 } });
  const task = async () => (await s.user.get(`/v1/tasks/${taskId}`)).json<Json>();
  const revision = async () => (await task()).revision as number;
  const delegate = async (command: Json) =>
    s.user.command(
      envelope(s.workspaceId, {
        type: "task.delegate",
        taskId,
        mode: "read",
        instructions: "review the diff",
        expectedRevision: await revision(),
        ...command,
      }),
    );
  const claimJob = async (jobId: string) => {
    const res = await device.command(claim(jobId));
    expect(res.status).toBe(200);
    return res.json<Claimed>();
  };
  const as = (run: Claimed) => {
    const auth = { Authorization: `Bearer ${run.capability.token}` };
    return {
      get: (path: string) => call(path, auth),
      command: (command: Json) => call("/v1/run/commands", auth, envelope(s.workspaceId, command)),
    };
  };
  const context = async (jobId: string, run: Claimed) =>
    (
      await device.get(
        `/v1/executor/jobs/${jobId}/context?runId=${run.runId}&executionGeneration=${run.executionGeneration}`,
      )
    ).json<Json>();
  const submit = (run: Claimed, state = "succeeded") =>
    device.command({
      type: "run.result.submit",
      runId: run.runId,
      executionGeneration: run.executionGeneration,
      state,
      summary: "looks good",
    });
  const delegation = (id: string) =>
    db
      .prepare("SELECT state, outcome_summary, job_id FROM delegations WHERE id = ?")
      .bind(id)
      .first<{ state: string; outcome_summary: string | null; job_id: string }>();
  const jobState = async (id: string) =>
    (await db.prepare("SELECT state FROM jobs WHERE id = ?").bind(id).first<{ state: string }>())!
      .state;
  return {
    ...s,
    helperId: helperId as string,
    otherId: otherId as string,
    taskId: taskId as string,
    task,
    revision,
    delegate,
    claimJob,
    as,
    context,
    submit,
    delegation,
    jobState,
  };
};

describe("task.delegate by a user", () => {
  it("creates a Job whose Run sees the delegation, may write in write mode, and closes on completion", async () => {
    const w = await world();
    const deadline = new Date(Date.now() + 3_600_000).toISOString();
    const res = await w.delegate({ toBotId: w.helperId, mode: "write", deadline });
    expect(res.status).toBe(200);
    const { delegationId, jobId } = await res.json<{ delegationId: string; jobId: string }>();
    expect(
      await db
        .prepare("SELECT bot_id, trigger_key, task_id, delegation_id FROM jobs WHERE id = ?")
        .bind(jobId)
        .first(),
    ).toEqual({
      bot_id: w.helperId,
      trigger_key: `delegation:${delegationId}`,
      task_id: w.taskId,
      delegation_id: delegationId,
    });
    // The assignee does not change.
    expect(await w.task()).toMatchObject({ assignee: null, revision: 2 });

    const run = await w.claimJob(jobId);
    expect(await w.context(jobId, run)).toMatchObject({
      task: { id: w.taskId, key: "APP-1" },
      delegation: {
        id: delegationId,
        mode: "write",
        deadline,
        fromBot: null,
        fromUser: { id: expect.any(String) },
        instructions: "review the diff",
      },
    });
    const assign = await w.as(run).command({
      type: "task.assign",
      taskId: w.taskId,
      assignee: { kind: "bot", id: w.botId },
      expectedRevision: await w.revision(),
    });
    expect(assign.status).toBe(200);

    expect((await w.submit(run)).status).toBe(200);
    await w.pump();
    expect(await w.delegation(delegationId)).toMatchObject({
      state: "completed",
      outcome_summary: "succeeded: looks good",
    });
    // A user delegator is told through the change log, not an Inbox.
    expect(
      await count("change_log WHERE entity_kind = 'delegation' AND entity_id = ?", delegationId),
    ).toBe(2);
    expect(
      await count(
        "inbox_items WHERE purpose = 'delegation.result' AND input_id IN (SELECT id FROM messages WHERE job_id = ?)",
        jobId,
      ),
    ).toBe(0);
    expect(((await w.task()).delegations as Json[])[0]).toMatchObject({
      id: delegationId,
      toBotId: w.helperId,
      state: "completed",
    });
  });

  it("revoke cancels a queued Job; the pump expires an overdue Delegation", async () => {
    const w = await world();
    const revoked = await (await w.delegate({ toBotId: w.helperId })).json<Json>();
    const revoke = { type: "task.delegate.revoke", delegationId: revoked.delegationId };
    expect((await w.user.command(envelope(w.workspaceId, revoke))).status).toBe(200);
    expect(await w.delegation(revoked.delegationId as string)).toMatchObject({ state: "revoked" });
    expect(await w.jobState(revoked.jobId as string)).toBe("cancelled");
    expect(await errorOf(await w.user.command(envelope(w.workspaceId, revoke)))).toMatchObject({
      status: 409,
      reason: "delegation_revoked",
    });

    const overdue = await (
      await w.delegate({ toBotId: w.otherId, deadline: new Date(Date.now() - 1000).toISOString() })
    ).json<Json>();
    await w.pump();
    expect(await w.delegation(overdue.delegationId as string)).toMatchObject({ state: "expired" });
    expect(await w.jobState(overdue.jobId as string)).toBe("cancelled");
  });
});

describe("task.delegate from a Run", () => {
  it("needs the assignee or a write delegate, and limits a read delegate's Run to reads", async () => {
    const w = await world();
    await w.ok({
      type: "task.assign",
      taskId: w.taskId,
      assignee: { kind: "bot", id: w.botId },
      expectedRevision: await w.revision(),
    });
    const { jobId } = await w.ok({ type: "job.start", taskId: w.taskId, botId: w.botId });
    const assignee = w.as(await w.claimJob(jobId as string));
    const delegate = async (run: ReturnType<typeof w.as>, command: Json) =>
      run.command({
        type: "task.delegate",
        taskId: w.taskId,
        mode: "read",
        instructions: "review the diff",
        expectedRevision: await w.revision(),
        ...command,
      });

    expect(await errorOf(await delegate(assignee, { toBotId: w.botId }))).toMatchObject({
      status: 422,
      reason: "self_delegation",
    });
    const ok = await delegate(assignee, { toBotId: w.helperId });
    expect(ok.status).toBe(200);
    const { delegationId, jobId: helperJob } = await ok.json<{
      delegationId: string;
      jobId: string;
    }>();
    expect(await errorOf(await delegate(assignee, { toBotId: w.helperId }))).toMatchObject({
      status: 409,
      reason: "already_delegated",
    });

    // The read delegate's Run: bot_pair conversation with the instructions, hop 1, reads but no writes.
    const helperRun = await w.claimJob(helperJob);
    const helper = w.as(helperRun);
    expect(await w.context(helperJob, helperRun)).toMatchObject({
      delegation: { mode: "read", fromBot: { id: w.botId, name: "coder" }, fromUser: null },
      conversation: {
        kind: "bot_pair",
        recent: [expect.objectContaining({ body: "review the diff" })],
      },
    });
    expect(await (await helper.get("/v1/run/me")).json()).toMatchObject({ hop: 1 });
    expect((await helper.get(`/v1/run/tasks/${w.taskId}`)).status).toBe(200);
    expect(
      await errorOf(
        await helper.command({
          type: "task.complete",
          taskId: w.taskId,
          expectedRevision: await w.revision(),
        }),
      ),
    ).toMatchObject({ status: 403, reason: "delegation_read_only" });
    expect(
      await errorOf(await delegate(helper, { toBotId: w.otherId, mode: "write" })),
    ).toMatchObject({ status: 403, reason: "not_delegator" });

    // A Bot that is neither assignee nor delegate.
    const { jobId: otherJob } = await w.ok({
      type: "job.start",
      taskId: w.taskId,
      botId: w.otherId,
    });
    const other = w.as(await w.claimJob(otherJob as string));
    expect(await errorOf(await delegate(other, { toBotId: w.helperId }))).toMatchObject({
      status: 403,
      reason: "not_delegator",
    });

    // The delegated Job ends: the Delegation closes and the delegator Bot is notified once.
    expect((await w.submit(helperRun, "failed")).status).toBe(200);
    await w.pump();
    await w.pump();
    expect(await w.delegation(delegationId)).toMatchObject({
      state: "completed",
      outcome_summary: "failed: looks good",
    });
    const notices = await db
      .prepare(
        `SELECT i.bot_id, i.delivery_mode, m.kind, m.body FROM inbox_items i
           JOIN messages m ON m.id = i.input_id
          WHERE i.workspace_id = ? AND i.purpose = 'delegation.result'`,
      )
      .bind(w.workspaceId)
      .all();
    expect(notices.results).toEqual([
      {
        bot_id: w.botId,
        delivery_mode: "notify",
        kind: "delegation_result",
        body: "Delegation of APP-1 failed: looks good",
      },
    ]);
    // Notify never wakes: no Job for the delegator from the notice.
    expect(await count("jobs WHERE workspace_id = ? AND bot_id = ?", w.workspaceId, w.botId)).toBe(
      1,
    );
  });
});
