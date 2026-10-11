// @vitest-environment happy-dom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, sidebar } from "./fakeHive.ts";

/** Renders the app and switches to a sidebar view. */
const open = async (label: string) => {
  const app = renderApp();
  await app.user.click(await (await sidebar()).findByRole("button", { name: label }));
  return app;
};

describe("views", () => {
  it("Inbox lists the selected bot's items", async () => {
    const { hive } = await open("Inbox");
    expect(await screen.findByText("in-1")).toBeTruthy();
    expect(hive.calls.get).toContain("/v1/inbox?botId=bot-1");
  });

  it("Activity lists jobs and cancels an active one", async () => {
    const { user, hive } = await open("Activity");
    expect(await screen.findByText("job-1")).toBeTruthy();
    expect(hive.calls.get).not.toContain("/v1/runs?workspaceId=ws-1&kind=external");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(hive.sent("job.cancel")).toEqual([
      { workspaceId: "ws-1", command: { type: "job.cancel", jobId: "job-1" } },
    ]);
  });

  it("Activity filters external sessions, inspects one, and links it to a Task", async () => {
    let linked = false;
    let rejectLink = true;
    const app = renderApp({
      get: {
        "/v1/runs": {
          runs: [
            {
              id: "run-ext-1",
              state: "active",
              provider: "claude",
              cwd: "/work/hive",
              repository: "acme/hive",
              title: "Collect this session",
              startedAt: "2026-10-12T04:00:00.000Z",
              lastActivityAt: "2026-10-12T04:05:00.000Z",
            },
          ],
        },
        "/v1/runs/run-ext-1": () => ({
          id: "run-ext-1",
          workspaceId: "ws-1",
          kind: "external",
          state: "active",
          persistence: "complete",
          deviceId: "dev-1",
          startedAt: "2026-10-12T04:00:00.000Z",
          finishedAt: null,
          hasProviderSession: false,
          transcript: { parts: 1, confirmedThroughSeq: 0 },
          ...(linked ? { taskId: "task-1", taskKey: "APP-1" } : {}),
        }),
        "/v1/runs/run-ext-1/transcript": {
          entries: [{ seq: 0, kind: "user", text: "Collect this session" }],
          nextCursor: null,
        },
        "/v1/effects": { effects: [] },
        "/v1/tasks": { tasks: [{ id: "task-1", key: "APP-1", title: "Collector" }] },
      },
      command: (envelope) => {
        if (envelope.command.type === "run.link_task" && rejectLink)
          return { ok: false, error: { code: "FORBIDDEN", message: "Task access denied" } };
        if (envelope.command.type === "run.link_task") linked = true;
        return { ok: true, value: {} };
      },
    });
    await app.user.click(await (await sidebar()).findByRole("button", { name: "Activity" }));
    expect(await screen.findByText("job-1")).toBeTruthy();
    await app.user.click(screen.getByRole("button", { name: "External" }));
    expect(await screen.findByRole("button", { name: /Collect this session/ })).toBeTruthy();
    expect(app.hive.calls.get).toContain("/v1/runs?workspaceId=ws-1&kind=external");
    await app.user.click(screen.getByRole("button", { name: /Collect this session/ }));
    expect(await screen.findByRole("heading", { name: "Link to Task" })).toBeTruthy();
    await app.user.selectOptions(screen.getByRole("combobox", { name: "Task" }), "task-1");
    await app.user.click(screen.getByRole("button", { name: "Link to Task" }));
    expect(await screen.findByText("FORBIDDEN: Task access denied")).toBeTruthy();
    expect(screen.queryByText("Linked Task APP-1")).toBeNull();
    rejectLink = false;
    await app.user.click(screen.getByRole("button", { name: "Link to Task" }));
    expect(app.hive.sent("run.link_task")).toEqual([
      {
        workspaceId: "ws-1",
        command: { type: "run.link_task", runId: "run-ext-1", taskId: "task-1" },
      },
      {
        workspaceId: "ws-1",
        command: { type: "run.link_task", runId: "run-ext-1", taskId: "task-1" },
      },
    ]);
    expect(await screen.findByText("Linked Task APP-1")).toBeTruthy();
  });

  it("Activity shows a Task's external sessions and opens the selected Run", async () => {
    const app = renderApp({
      get: {
        "/v1/jobs/job-1": { id: "job-1", taskId: "task-1", runs: [] },
        "/v1/tasks/task-1": {
          id: "task-1",
          key: "APP-1",
          git: { commits: 0, prs: [], repositories: [] },
          externalSessions: [
            { id: "run-ext-1", provider: "codex", cwd: "/work/hive", title: "Repair collector" },
          ],
        },
        "/v1/runs/run-ext-1": {
          id: "run-ext-1",
          workspaceId: "ws-1",
          kind: "external",
          state: "finished",
          persistence: "complete",
          deviceId: "dev-1",
          startedAt: "2026-10-12T04:00:00.000Z",
          finishedAt: "2026-10-12T04:05:00.000Z",
          hasProviderSession: false,
          transcript: { parts: 0, confirmedThroughSeq: null },
        },
        "/v1/runs/run-ext-1/transcript": { entries: [], nextCursor: null },
        "/v1/effects": { effects: [] },
        "/v1/tasks": { tasks: [] },
      },
    });
    await app.user.click(await (await sidebar()).findByRole("button", { name: "Activity" }));
    await app.user.click(await screen.findByRole("button", { name: /job-1/ }));
    expect(await screen.findByText("External sessions")).toBeTruthy();
    await app.user.click(screen.getByRole("button", { name: /Repair collector/ }));
    expect(await screen.findByText("Run")).toBeTruthy();
    expect(app.hive.calls.get).toContain("/v1/runs/run-ext-1");
  });

  it("Approvals lists pending approvals and Allow sends approval.resolve", async () => {
    const { user, hive } = await open("Approvals");
    expect(await screen.findByText("rm -rf build")).toBeTruthy();
    expect(screen.getByLabelText("1 pending")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Allow" }));
    expect(hive.sent("approval.resolve")).toEqual([
      {
        workspaceId: "ws-1",
        command: { type: "approval.resolve", approvalId: "ap-1", decision: "allow" },
      },
    ]);
  });

  it("Search shows hits and a message hit opens its channel", async () => {
    const { user, hive } = await open("Search");
    await user.type(screen.getByRole("textbox", { name: "Query" }), "release{Enter}");
    expect(hive.calls.get).toContain("/v1/search?workspaceId=ws-1&q=release");
    await user.click(await screen.findByRole("button", { name: /\[release\] notes ready/ }));
    expect(await screen.findByText("release notes ready")).toBeTruthy();
  });

  it("Memory lists workspace memories and writes one", async () => {
    const { user, hive } = await open("Memory");
    expect(await screen.findByText("deploys on Fridays are frozen")).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Memory" }), "use bun{Enter}");
    expect(hive.sent("memory.write")).toEqual([
      {
        workspaceId: "ws-1",
        command: {
          type: "memory.write",
          scopeKind: "workspace",
          scopeId: "ws-1",
          content: "use bun",
        },
      },
    ]);
  });

  it("Status shows the workspace, connection and sync cursor", async () => {
    await open("Status");
    expect(screen.getByText("ws-1")).toBeTruthy();
    expect(screen.getByText("connected")).toBeTruthy();
    expect(await screen.findByText("H0")).toBeTruthy();
  });
});
