import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, envelope, type Json, setup } from "./helpers.ts";

const db = env.DB;
type Task = Json & { id: string; key: string; revision: number; status: string; display: string };

/** setup() plus a Project `APP` and helpers for Task commands. */
const work = async () => {
  const s = await setup();
  const command = (body: Json, idempotencyKey?: string) =>
    s.user.command(envelope(s.workspaceId, body, idempotencyKey));
  const task = async (id: string) => (await s.user.get(`/v1/tasks/${id}`)).json<Task>();
  const create = async (title: string, extra: Json = {}) =>
    (await s.ok({ type: "task.create", projectKey: "APP", title, ...extra })) as {
      taskId: string;
      key: string;
    };
  /** Edits `id` at its current revision. */
  const edit = async (type: string, id: string, extra: Json = {}) =>
    command({ type, taskId: id, expectedRevision: (await task(id)).revision, ...extra });
  const device = (cmd: Json, idempotencyKey?: string) =>
    call(
      "/v1/executor/commands",
      { Authorization: `Bearer ${s.deviceToken}` },
      envelope(s.workspaceId, cmd, idempotencyKey),
    );
  await s.ok({ type: "project.create", key: "APP", name: "app" });
  /** job.start → claim; returns the claimed Run's fence. */
  const startAndClaim = async (taskId: string) => {
    const { jobId } = await s.ok({ type: "job.start", taskId, botId: s.botId });
    const claimed = await (
      await device({ type: "job.claim", jobId, expectedRevision: 1 })
    ).json<{ runId: string; executionId: string; executionGeneration: number }>();
    return { jobId: jobId as string, ...claimed };
  };
  const submit = (run: { runId: string; executionGeneration: number }, state = "succeeded") =>
    device({
      type: "run.result.submit",
      runId: run.runId,
      executionGeneration: run.executionGeneration,
      state,
      summary: "done",
    });
  return { ...s, command, task, create, edit, device, startAndClaim, submit };
};

const errorOf = async (res: Response) => ({ status: res.status, ...(await res.json<Json>()) });

describe("projects and tasks", () => {
  it("creates a Project and Tasks with generated keys; a subtask inherits the Project", async () => {
    const w = await work();
    const first = await w.create("first", { priority: 2 });
    const second = await w.create("second");
    const child = await w.create("child", { projectKey: undefined, parentTaskId: first.taskId });
    expect([first.key, second.key, child.key]).toEqual(["APP-1", "APP-2", "APP-3"]);

    expect(await w.task(child.taskId)).toMatchObject({
      key: "APP-3",
      projectKey: "APP",
      parentTaskId: first.taskId,
      status: "pending",
      display: "ready",
      revision: 1,
      scopeRevision: 1,
      completionPolicy: "declaration",
      assignee: null,
    });
    const projects = await (await w.user.get(`/v1/projects?workspaceId=${w.workspaceId}`)).json();
    expect(projects).toMatchObject({ projects: [{ key: "APP", name: "app", status: "active" }] });
    // Duplicate project key, unknown project, no project at all.
    expect(
      await errorOf(await w.command({ type: "project.create", key: "APP", name: "x" })),
    ).toMatchObject({ status: 422 });
    expect((await w.command({ type: "task.create", projectKey: "NOPE", title: "x" })).status).toBe(
      404,
    );
    expect((await w.command({ type: "task.create", title: "x" })).status).toBe(422);
  });

  it("assigns with expectedRevision; a stale revision is 409 and changes nothing", async () => {
    const w = await work();
    const { taskId } = await w.create("t");
    const assign = (expectedRevision: number) =>
      w.command({
        type: "task.assign",
        taskId,
        assignee: { kind: "bot", id: w.botId },
        expectedRevision,
      });
    expect((await assign(1)).status).toBe(200);
    expect(await w.task(taskId)).toMatchObject({
      revision: 2,
      assignee: { kind: "bot", id: w.botId },
    });
    expect(await errorOf(await assign(1))).toMatchObject({
      status: 409,
      code: "REVISION_CONFLICT",
      reason: "stale_revision",
    });
    const unknown = await w.command({
      type: "task.assign",
      taskId,
      assignee: { kind: "bot", id: "nope" },
      expectedRevision: 2,
    });
    expect(unknown.status).toBe(404);
    expect((await w.edit("task.assign", taskId, { assignee: null })).status).toBe(200);
    expect(await w.task(taskId)).toMatchObject({ revision: 3, assignee: null });
  });
});

describe("dependency DAG", () => {
  it("rejects a dependency cycle, including one through parent/child (AT-18)", async () => {
    const w = await work();
    const a = await w.create("a");
    const b = await w.create("b");
    expect((await w.edit("task.plan", b.taskId, { addPrerequisites: [a.taskId] })).status).toBe(
      200,
    );
    const cycle = await w.edit("task.plan", a.taskId, { addPrerequisites: [b.taskId] });
    expect(await errorOf(cycle)).toMatchObject({
      status: 422,
      code: "INVALID_INPUT",
      reason: "cycle",
    });
    const self = await w.edit("task.plan", a.taskId, { addPrerequisites: [a.taskId] });
    expect(self.status).toBe(422);

    // A child waiting for its parent's completion is a hidden cycle.
    const child = await w.create("child", { parentTaskId: a.taskId });
    const hidden = await w.edit("task.plan", child.taskId, { addPrerequisites: [a.taskId] });
    expect(await errorOf(hidden)).toMatchObject({ status: 422, reason: "cycle" });
    expect(await w.task(child.taskId)).toMatchObject({ revision: 1, prerequisites: [] });
  });

  it("blocks a dependent of a cancelled prerequisite (AT-17) and computes display states", async () => {
    const w = await work();
    const a = await w.create("a");
    const b = await w.create("b");
    const c = await w.create("c");
    await w.edit("task.plan", b.taskId, { addPrerequisites: [a.taskId] });
    expect((await w.edit("task.cancel", a.taskId)).status).toBe(200);
    await w.startAndClaim(c.taskId);

    const list = await (
      await w.user.get(`/v1/tasks?workspaceId=${w.workspaceId}&projectKey=APP`)
    ).json<{ tasks: Task[] }>();
    expect(list.tasks.map((t) => [t.key, t.display])).toEqual([
      ["APP-1", "cancelled"],
      ["APP-2", "blocked"],
      ["APP-3", "in_progress"],
    ]);
    expect(list.tasks[1]!.prerequisites).toEqual([
      { id: a.taskId, key: "APP-1", status: "cancelled" },
    ]);
    const pending = await (
      await w.user.get(`/v1/tasks?workspaceId=${w.workspaceId}&status=pending`)
    ).json<{ tasks: Task[] }>();
    expect(pending.tasks.map((t) => t.key)).toEqual(["APP-2"]);

    // job.start on the blocked Task is refused and creates no Job.
    const blocked = await w.command({ type: "job.start", taskId: b.taskId, botId: w.botId });
    expect(await errorOf(blocked)).toMatchObject({ status: 422, reason: "blocked" });
    expect(await w.task(b.taskId)).toMatchObject({ status: "pending", jobs: [] });
    // Dropping the cancelled dependency explicitly unblocks it.
    await w.edit("task.plan", b.taskId, { removePrerequisites: [a.taskId] });
    expect(await w.task(b.taskId)).toMatchObject({ display: "ready", scopeRevision: 3 });
  });
});

describe("job.start and completion", () => {
  it("links the Execution to the Task; a Result does not complete the Task (AT-16)", async () => {
    const w = await work();
    const { taskId } = await w.create("t");
    const run = await w.startAndClaim(taskId);
    const execution = await db
      .prepare("SELECT task_id, task_scope_revision FROM executions WHERE id = ?")
      .bind(run.executionId)
      .first();
    expect(execution).toEqual({ task_id: taskId, task_scope_revision: 1 });

    expect((await w.submit(run)).status).toBe(200);
    const task = await w.task(taskId);
    expect(task).toMatchObject({
      status: "in_progress",
      display: "in_progress",
      results: [
        { runId: run.runId, executionId: run.executionId, scopeRevision: 1, state: "succeeded" },
      ],
      jobs: [{ id: run.jobId, state: "succeeded", triggerKey: `task:${taskId}:1:1` }],
    });
    expect(await (await w.user.get(`/v1/jobs/${run.jobId}`)).json()).toMatchObject({ taskId });
  });

  it("completes only with a succeeded Result for the current scope revision", async () => {
    const w = await work();
    const { taskId } = await w.create("t");
    const noResult = await w.edit("task.complete", taskId);
    expect(await errorOf(noResult)).toMatchObject({ status: 422, reason: "no_result" });

    const failed = await w.startAndClaim(taskId);
    await w.submit(failed, "failed");
    expect(await errorOf(await w.edit("task.complete", taskId))).toMatchObject({
      reason: "no_result",
    });

    const ok = await w.startAndClaim(taskId);
    expect((await w.task(taskId)).jobs).toHaveLength(2);
    await w.submit(ok);
    const { revision } = await w.task(taskId);
    const complete = { type: "task.complete", taskId, expectedRevision: revision };
    expect((await w.command(complete, "complete-1")).status).toBe(200);
    expect(await w.task(taskId)).toMatchObject({ status: "completed", revision: revision + 1 });
    // A replay returns the stored receipt even though the Task is no longer open.
    expect((await w.command(complete, "complete-1")).status).toBe(200);
    const again = await w.command({ ...complete, expectedRevision: revision + 1 });
    expect(await errorOf(again)).toMatchObject({ status: 422, reason: "invalid_status" });
    const start = await w.command({ type: "job.start", taskId, botId: w.botId });
    expect(await errorOf(start)).toMatchObject({ status: 422, reason: "invalid_status" });
  });

  it("a Result for a stale scope revision does not satisfy completion", async () => {
    const w = await work();
    const { taskId } = await w.create("t");
    const other = await w.create("other");
    const run = await w.startAndClaim(taskId);
    // The plan changes while the Run works: its Result is for scope revision 1.
    await w.edit("task.plan", taskId, { addPrerequisites: [other.taskId] });
    await w.edit("task.plan", taskId, { removePrerequisites: [other.taskId] });
    await w.submit(run);
    expect((await w.task(taskId)).scopeRevision).toBe(3);
    // Change rows (§12.2): dependency upsert and delete tombstone, and the Task Result.
    const { results: changes } = await db
      .prepare(
        `SELECT entity_kind AS kind, entity_id AS id, op FROM change_log
          WHERE workspace_id = ? AND entity_kind IN ('task_dependency', 'task_result') ORDER BY seq`,
      )
      .bind(w.workspaceId)
      .all();
    const [result] = (await w.task(taskId)).results as { id: string }[];
    expect(changes).toEqual([
      { kind: "task_dependency", id: `${other.taskId}:${taskId}`, op: "upsert" },
      { kind: "task_dependency", id: `${other.taskId}:${taskId}`, op: "delete" },
      { kind: "task_result", id: result!.id, op: "upsert" },
    ]);
    expect(await errorOf(await w.edit("task.complete", taskId))).toMatchObject({
      reason: "no_result",
    });
  });

  it("pins a Job to a device inside the Bot's placement; replays and refusals", async () => {
    const w = await work();
    const { taskId } = await w.create("t");
    const start = { type: "job.start", taskId, botId: w.botId, deviceId: w.deviceId };
    const res = await w.command(start, "start-1");
    expect(res.status).toBe(200);
    const { jobId } = await res.json<{ jobId: string }>();
    expect(await (await w.user.get(`/v1/jobs/${jobId}`)).json()).toMatchObject({
      placement: {
        mode: "pinned",
        allowedDeviceIds: [w.deviceId],
        preferredDeviceIds: [w.deviceId],
      },
    });
    expect(await (await w.command(start, "start-1")).json()).toMatchObject({ jobId });
    expect((await w.task(taskId)).jobs).toHaveLength(1);

    const other = await w.ok({
      type: "device.register",
      name: "pc2",
      os: "linux",
      agentVersion: "0",
    });
    const { botId } = await w.ok({
      type: "bot.create",
      name: "pinned",
      placementPolicy: {
        mode: "pinned",
        allowedDeviceIds: [w.deviceId],
        preferredDeviceIds: [w.deviceId],
      },
    });
    const outside = await w.command({ ...start, botId, deviceId: other.deviceId });
    expect(await errorOf(outside)).toMatchObject({ status: 422, reason: "not_eligible" });
    expect((await w.command({ ...start, deviceId: "nope" })).status).toBe(404);
  });
});
