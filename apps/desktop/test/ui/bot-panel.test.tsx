// @vitest-environment happy-dom
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { findComposer, renderApp, sidebar } from "./fakeHive.ts";
import { dms } from "./fixtures.ts";

/** Opens coder's DM from its sidebar blob, then its panel from the DM header. */
const openCoder = async (overrides: Parameters<typeof renderApp>[0] = {}) => {
  const app = renderApp({ ...overrides, get: { "/v1/dms": { dms } } });
  await app.user.click(await (await sidebar()).findByRole("button", { name: "coder" }));
  const head = within(await waitForHead(app.container));
  await app.user.click(head.getByRole("button", { name: "coder" }));
  const panel = within(app.container.querySelector<HTMLElement>(".panel")!);
  return { ...app, panel };
};
const waitForHead = async (container: HTMLElement) => {
  await findComposer("Message coder");
  return container.querySelector<HTMLElement>(".chat-head")!;
};

describe("bot panel", () => {
  it("opens from the DM header with instructions, tool policy and its routines", async () => {
    const { panel, hive } = await openCoder();
    expect(panel.getByRole("heading", { name: "coder" })).toBeTruthy();
    expect(panel.getByText("Write small diffs.")).toBeTruthy();
    expect(panel.getByText(/"bash": "ask"/)).toBeTruthy();
    expect(await panel.findByText("Daily digest")).toBeTruthy();
    expect(panel.getByText("Weekdays at 9:00 AM")).toBeTruthy();
    expect(panel.getByText("# general")).toBeTruthy();
    expect(hive.calls.get).toContain("/v1/routines?workspaceId=ws-1&botId=bot-1");
  });

  it("pauses and deletes a routine from its menu", async () => {
    const { panel, user, hive } = await openCoder();
    await user.click(await panel.findByRole("button", { name: "Daily digest actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Pause" }));
    await user.click(panel.getByRole("button", { name: "Daily digest actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(hive.calls.command.map((e) => e.command)).toEqual([
      { type: "routine.pause", routineId: "rt-1" },
      { type: "routine.delete", routineId: "rt-1" },
    ]);
  });

  it("lists the bot's memories in Library", async () => {
    const { panel, user, hive } = await openCoder();
    await user.click(panel.getByRole("tab", { name: "Library" }));
    expect(await panel.findByText("prefers bun")).toBeTruthy();
    expect(hive.calls.get).toContain("/v1/memories?workspaceId=ws-1&scopeKind=bot&scopeId=bot-1");
  });

  it("labels consolidated memories, filters by source, and shows workspace proposals", async () => {
    const { panel, user, hive } = await openCoder();
    await user.click(panel.getByRole("tab", { name: "Library" }));
    expect(await panel.findByText("deploys are frozen on Fridays")).toBeTruthy();
    expect(panel.getByText("consolidated")).toBeTruthy();
    expect(panel.getByText("merged from 2")).toBeTruthy();
    expect(panel.getByRole("heading", { name: "Proposed for workspace" })).toBeTruthy();
    await user.selectOptions(panel.getByRole("combobox", { name: "Memory source" }), "explicit");
    expect(hive.calls.get).toContain(
      "/v1/memories?workspaceId=ws-1&scopeKind=bot&scopeId=bot-1&source=explicit",
    );
  });

  it("promotes or dismisses a workspace proposal and reloads the library", async () => {
    const { panel, user, hive } = await openCoder();
    await user.click(panel.getByRole("tab", { name: "Library" }));
    await panel.findByRole("button", { name: "Promote" });
    const before = hive.calls.get.filter((path) => path.startsWith("/v1/memories?")).length;
    await user.click(panel.getByRole("button", { name: "Promote" }));
    await user.click(panel.getByRole("button", { name: "Dismiss" }));
    expect(hive.sent("memory.promote")).toEqual([
      { workspaceId: "ws-1", command: { type: "memory.promote", memoryId: "mem-3" } },
    ]);
    expect(hive.sent("memory.delete")).toEqual([
      {
        workspaceId: "ws-1",
        command: { type: "memory.delete", memoryId: "mem-3", expectedRevision: 2 },
      },
    ]);
    await waitFor(() =>
      expect(
        hive.calls.get.filter((path) => path.startsWith("/v1/memories?")).length,
      ).toBeGreaterThan(before),
    );
  });

  it("toggles the nightly memory consolidation routine", async () => {
    const { panel, user, hive } = await openCoder();
    const toggle = await panel.findByRole("checkbox", {
      name: "Nightly memory consolidation enabled",
    });
    await user.click(toggle);
    expect(hive.sent("routine.pause")).toContainEqual({
      workspaceId: "ws-1",
      command: { type: "routine.pause", routineId: "rt-nightly" },
    });
  });

  it("shows the executor service in Computer and starts it with the chosen provider", async () => {
    const { panel, user, hive } = await openCoder();
    await user.click(panel.getByRole("tab", { name: "Computer" }));
    expect(await panel.findByText("loaded, pid 4242")).toBeTruthy();
    expect(panel.getByText("studio")).toBeTruthy();
    expect(panel.getByText("online")).toBeTruthy();
    await user.selectOptions(panel.getByRole("combobox", { name: "Provider" }), "codex");
    await user.click(panel.getByRole("button", { name: "Start" }));
    expect(hive.calls.executor).toEqual([{ start: { provider: "codex", concurrency: 1 } }]);
  });

  it("offers Set up this PC in Computer when this device is not registered", async () => {
    const { panel, user, hive } = await openCoder({
      executor: { registered: false, installed: false },
    });
    await user.click(panel.getByRole("tab", { name: "Computer" }));
    await user.click(await panel.findByRole("button", { name: "Set up this PC" }));
    expect(hive.calls.setup).toEqual([{ register: { name: "test-pc" } }]);
  });
});
