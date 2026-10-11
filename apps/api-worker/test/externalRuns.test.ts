import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { call, envelope, executor, login, request, setup } from "./helpers.ts";

const bytes = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const sha256 = async (value: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

describe("external Runs", () => {
  it("upserts one device session, keeps it private, and links it to a Task", async () => {
    const s = await setup();
    const device = executor(s.deviceToken, s.workspaceId);
    const input = {
      provider: "claude",
      externalSessionId: "session-1",
      cwd: "/work/project",
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lastActivityAt: new Date().toISOString(),
      repository: "github.com/example/project",
      title: "Fix collector",
      firstUserMessage: "Fix collector",
    };
    const first = await device.post("/v1/executor/external-runs", input);
    expect(first.status).toBe(200);
    const { runId } = await first.json<{ runId: string; state: string }>();
    const repeated = await device.post("/v1/executor/external-runs", input);
    expect(await repeated.json()).toMatchObject({ runId, state: "active" });
    const stale = await device.post("/v1/executor/external-runs", {
      ...input,
      lastActivityAt: new Date(Date.parse(input.lastActivityAt) - 60_000).toISOString(),
    });
    expect(await stale.json()).toMatchObject({ runId, state: "active" });
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE kind = 'external'").first<{
        n: number;
      }>())!.n,
    ).toBe(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM executions WHERE run_id = ?")
        .bind(runId)
        .first(),
    ).toEqual({ n: 0 });
    expect((await device.get(`/v1/executor/runs/${runId}`)).status).toBe(404);

    const runs = await (
      await s.user.get(`/v1/runs?workspaceId=${s.workspaceId}&kind=external`)
    ).json<{ runs: { id: string; kind: string; title: string }[] }>();
    expect(runs.runs).toMatchObject([{ id: runId, kind: "external", title: "Fix collector" }]);

    await s.ok({ type: "project.create", key: "APP", name: "app" });
    const { taskId } = await s.ok({ type: "task.create", projectKey: "APP", title: "Collector" });
    const linked = await s.user.command(
      envelope(s.workspaceId, { type: "run.link_task", runId, taskId }),
    );
    expect(linked.status).toBe(200);
    expect(await linked.json()).toMatchObject({ runId, taskId });
    expect(await (await s.user.get(`/v1/runs/${runId}`)).json()).toMatchObject({
      kind: "external",
      taskId,
      taskKey: "APP-1",
    });
    expect(await (await s.user.get(`/v1/tasks/${taskId}`)).json()).toMatchObject({
      externalSessions: [{ id: runId, title: "Fix collector" }],
    });

    await s.pump();
    expect(
      await (
        await s.user.get(`/v1/search?workspaceId=${s.workspaceId}&q=collector&kinds=run`)
      ).json(),
    ).toMatchObject({ hits: [expect.objectContaining({ sourceKind: "run", sourceId: runId })] });

    const other = await login();
    const { userId } = await (await other.me()).json<{ userId: string }>();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')",
      ).bind(s.workspaceId, userId),
      env.DB.prepare(
        "INSERT INTO actors (id, workspace_id, kind, user_id, display_name) VALUES (?, ?, 'user', ?, 'other')",
      ).bind(crypto.randomUUID(), s.workspaceId, userId),
    ]);
    expect(
      await other
        .get(`/v1/runs?workspaceId=${s.workspaceId}&kind=external`)
        .then((res) => res.json()),
    ).toEqual({ runs: [] });
    expect(
      await (
        await other.get(`/v1/search?workspaceId=${s.workspaceId}&q=collector&kinds=run`)
      ).json(),
    ).toMatchObject({ hits: [] });
    expect(
      (await other.command(envelope(s.workspaceId, { type: "run.link_task", runId, taskId })))
        .status,
    ).toBe(404);
  });

  it("finishes an unchanged session after thirty idle minutes and reopens it on growth", async () => {
    const s = await setup();
    const device = executor(s.deviceToken, s.workspaceId);
    const observedAt = Date.now();
    const input = {
      provider: "claude",
      externalSessionId: "idle-session",
      cwd: "/work/project",
      startedAt: new Date(observedAt).toISOString(),
      lastActivityAt: new Date(observedAt).toISOString(),
      repository: "",
      title: "Idle session",
    };
    const created = await (
      await device.post("/v1/executor/external-runs", input)
    ).json<{ runId: string; state: string }>();
    expect(created.state).toBe("active");
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(observedAt + 30 * 60_000);
      expect(await (await device.post("/v1/executor/external-runs", input)).json()).toEqual({
        runId: created.runId,
        state: "finished",
      });
      clock.mockReturnValue(observedAt + 31 * 60_000);
      expect(
        await (
          await device.post("/v1/executor/external-runs", {
            ...input,
            lastActivityAt: new Date(observedAt + 31 * 60_000).toISOString(),
          })
        ).json(),
      ).toEqual({ runId: created.runId, state: "active" });
    } finally {
      clock.mockRestore();
    }
  });

  it("reads redacted normalized external parts after a completed stream grows", async () => {
    const s = await setup();
    const device = executor(s.deviceToken, s.workspaceId);
    const created = await device.post("/v1/executor/external-runs", {
      provider: "codex",
      externalSessionId: "thread-1",
      cwd: "/work/project",
      startedAt: "2026-10-12T00:00:00.000Z",
      lastActivityAt: new Date().toISOString(),
      repository: "",
      title: "Session",
    });
    const { runId } = await created.json<{ runId: string }>();
    const auth = { Authorization: `Bearer ${s.deviceToken}`, "Content-Type": "application/json" };
    const upload = async (partSeq: number, value: unknown) => {
      const body = bytes(value);
      const init = await call("/v1/executor/uploads/init", auth, {
        runId,
        partSeq,
        byteSize: body.byteLength,
        sha256: await sha256(body),
        provider: "codex",
      });
      const { uploadId } = await init.json<{ uploadId: string }>();
      return request(`/v1/executor/uploads/${uploadId}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${s.deviceToken}` },
        body,
      });
    };
    expect((await upload(0, { kind: "user", text: "API_TOKEN=private-value" })).status).toBe(200);
    expect(
      (await call("/v1/executor/uploads/complete", auth, { runId, lastPartSeq: 0 })).status,
    ).toBe(200);
    expect((await upload(1, { kind: "other", text: "new activity" })).status).toBe(200);
    expect(
      (await call("/v1/executor/uploads/complete", auth, { runId, lastPartSeq: 1 })).status,
    ).toBe(200);
    expect(await (await s.user.get(`/v1/runs/${runId}`)).json()).toMatchObject({
      persistence: "complete",
      transcript: { parts: 2, confirmedThroughSeq: 1 },
    });
    expect(await (await s.user.get(`/v1/runs/${runId}/transcript`)).json()).toMatchObject({
      entries: [{ kind: "user", text: "[redacted]" }],
    });
  });
});
