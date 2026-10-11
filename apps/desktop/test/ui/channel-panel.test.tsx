// @vitest-environment happy-dom
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "./fakeHive.ts";

/** Opens #general's panel from the header pill. */
const openGeneral = async () => {
  const app = renderApp();
  await app.user.click(await screen.findByRole("button", { name: "# general" }));
  const panel = within(app.container.querySelector<HTMLElement>(".panel")!);
  return { ...app, panel };
};

describe("channel panel", () => {
  it("opens on the pill with About and saves an edited topic with channel.update", async () => {
    const { panel, user, hive } = await openGeneral();
    expect(panel.getByRole("heading", { name: "# general" })).toBeTruthy();
    const channelGets = () => hive.calls.get.filter((p) => p.startsWith("/v1/channels?")).length;
    const before = channelGets();
    await user.click(panel.getByRole("button", { name: "Add a topic" }));
    await user.type(panel.getByRole("textbox", { name: "Topic" }), "Build health{Enter}");
    expect(hive.sent("channel.update")).toEqual([
      {
        workspaceId: "ws-1",
        command: { type: "channel.update", channelId: "ch-1", topic: "Build health" },
      },
    ]);
    await vi.waitFor(() => expect(channelGets()).toBe(before + 1));
  });

  it("cancels a topic edit on Escape", async () => {
    const { panel, user, hive } = await openGeneral();
    await user.click(panel.getByRole("button", { name: "Add a topic" }));
    await user.type(panel.getByRole("textbox", { name: "Topic" }), "nope{Escape}");
    expect(panel.getByRole("button", { name: "Add a topic" })).toBeTruthy();
    expect(hive.calls.command).toEqual([]);
  });

  it("shows the latest summary range and requests a new summary", async () => {
    const { panel, user, hive } = await openGeneral();
    expect(await panel.findByText("The deploy window is Friday at 15:00.")).toBeTruthy();
    expect(panel.getByText("Covers messages 1–12")).toBeTruthy();
    const before = hive.calls.get.filter((path) => path.includes("/summary?")).length;
    await user.click(panel.getByRole("button", { name: "Summarize now" }));
    expect(hive.sent("conversation.summarize")).toEqual([
      {
        workspaceId: "ws-1",
        command: { type: "conversation.summarize", conversationId: "conv-1" },
      },
    ]);
    await vi.waitFor(() =>
      expect(hive.calls.get.filter((path) => path.includes("/summary?")).length).toBeGreaterThan(
        before,
      ),
    );
  });

  it("lists members, marks you, and opens a bot member's panel", async () => {
    const { panel, user, container } = await openGeneral();
    await user.click(panel.getByRole("tab", { name: "Members" }));
    expect(await panel.findByText("Mina (you)")).toBeTruthy();
    await user.click(panel.getByRole("button", { name: "coder" }));
    const botPanel = within(container.querySelector<HTMLElement>(".panel")!);
    expect(await botPanel.findByText("Write small diffs.")).toBeTruthy();
  });

  it("Add bot lists non-member Bots and sends channel.join; a Bot's menu sends channel.leave", async () => {
    const { panel, user, hive } = await openGeneral();
    await user.click(panel.getByRole("tab", { name: "Members" }));
    await user.click(await panel.findByRole("button", { name: "Add bot" }));
    // The blob's letter, then the name.
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["R reviewer"]);
    await user.click(screen.getByRole("menuitem", { name: /reviewer/ }));
    await user.click(panel.getByRole("button", { name: "coder actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from channel" }));
    expect([...hive.sent("channel.join"), ...hive.sent("channel.leave")]).toEqual([
      { workspaceId: "ws-1", command: { type: "channel.join", channelId: "ch-1", botId: "bot-2" } },
      {
        workspaceId: "ws-1",
        command: { type: "channel.leave", channelId: "ch-1", botId: "bot-1" },
      },
    ]);
    // Re-read after each change.
    expect(
      hive.calls.get.filter((p) => p.startsWith("/v1/channels/ch-1/members")).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("creates a routine in the channel's conversation", async () => {
    const { panel, user, hive } = await openGeneral();
    await user.click(panel.getByRole("tab", { name: "Routines" }));
    expect(await panel.findByText("Daily digest")).toBeTruthy();
    await user.click(panel.getByRole("button", { name: "New routine" }));
    await user.type(panel.getByLabelText("Name"), "Standup");
    await user.clear(panel.getByLabelText("Timezone"));
    await user.type(panel.getByLabelText("Timezone"), "Asia/Tokyo");
    await user.type(panel.getByLabelText("Input"), "Post the standup");
    await user.click(panel.getByRole("button", { name: "Create" }));
    expect(hive.sent("routine.create")).toEqual([
      {
        workspaceId: "ws-1",
        command: {
          type: "routine.create",
          botId: "bot-1",
          name: "Standup",
          schedule: { kind: "cron", expr: "0 9 * * 1-5", timezone: "Asia/Tokyo" },
          inputText: "Post the standup",
          misfire: "coalesce",
          conversationId: "conv-1",
        },
      },
    ]);
    expect(await panel.findByRole("button", { name: "New routine" })).toBeTruthy();
  });

  it("edits a routine with expectedRevision and only the changed fields", async () => {
    const { panel, user, hive } = await openGeneral();
    await user.click(panel.getByRole("tab", { name: "Routines" }));
    await user.click(await panel.findByRole("button", { name: "Daily digest actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    await user.clear(panel.getByLabelText("Name"));
    await user.type(panel.getByLabelText("Name"), "Morning digest");
    await user.click(panel.getByRole("button", { name: "Save" }));
    expect(hive.sent("routine.update")).toEqual([
      {
        workspaceId: "ws-1",
        command: {
          type: "routine.update",
          routineId: "rt-1",
          expectedRevision: 3,
          name: "Morning digest",
        },
      },
    ]);
  });
});
