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
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(hive.sent("job.cancel")).toEqual([
      { workspaceId: "ws-1", command: { type: "job.cancel", jobId: "job-1" } },
    ]);
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
