// @vitest-environment happy-dom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, sidebar } from "./fakeHive.ts";

describe("sidebar", () => {
  it("lists bots and channels with a Markdown-stripped preview of the latest message", async () => {
    renderApp();
    const side = await sidebar();
    expect(await side.findByRole("button", { name: "coder" })).toBeTruthy();
    expect(side.getByRole("button", { name: "reviewer" })).toBeTruthy();
    expect(side.getByText("# general")).toBeTruthy();
    expect(side.getByText("Fixed the build")).toBeTruthy();
    expect(side.getByText("No messages yet")).toBeTruthy();
  });

  it("loads a channel's messages when it is clicked", async () => {
    const { hive, user } = renderApp();
    await user.click(await (await sidebar()).findByText("# release"));
    expect(await screen.findByText("release notes ready")).toBeTruthy();
    expect(hive.calls.get).toContain("/v1/channels/ch-2/messages?workspaceId=ws-1");
  });

  it("collapses to an icon rail and remembers it", async () => {
    const { user } = renderApp();
    const side = await sidebar();
    await side.findByText("# general");
    await user.click(side.getByRole("button", { name: "Toggle sidebar" }));
    expect(side.queryByText("# general")).toBeNull();
    expect(localStorage.getItem("hive.sidebarCollapsed")).toBe("1");
  });

  it("starts collapsed when the last session left it collapsed", async () => {
    localStorage.setItem("hive.sidebarCollapsed", "1");
    const { container } = renderApp();
    await (await sidebar()).findByRole("button", { name: "coder" });
    expect(container.querySelector(".sidebar.collapsed")).toBeTruthy();
  });
});
