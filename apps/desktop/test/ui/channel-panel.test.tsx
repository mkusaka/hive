// @vitest-environment happy-dom
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp } from "./fakeHive.ts";

/** Opens #general's panel from the header pill. */
const openGeneral = async (overrides: Parameters<typeof renderApp>[0] = {}) => {
  const app = renderApp(overrides);
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

  it("lists members, marks you, and opens a bot member's panel", async () => {
    const { panel, user, container } = await openGeneral();
    await user.click(panel.getByRole("tab", { name: "Members" }));
    expect(await panel.findByText("Mina (you)")).toBeTruthy();
    await user.click(panel.getByRole("button", { name: "coder" }));
    const botPanel = within(container.querySelector<HTMLElement>(".panel")!);
    expect(await botPanel.findByText("Write small diffs.")).toBeTruthy();
  });

  it("adds a user or Bot with a role, updates a Bot role, and removes the Bot", async () => {
    const { panel, user, hive } = await openGeneral();
    await user.click(panel.getByRole("tab", { name: "Members" }));
    expect(await panel.findByText("owner")).toBeTruthy();
    expect(panel.getByText("member")).toBeTruthy();
    await user.click(panel.getByRole("button", { name: "Add member" }));
    await user.selectOptions(panel.getByRole("combobox", { name: "Member" }), "user:user-2");
    await user.selectOptions(panel.getByRole("combobox", { name: "Member role" }), "viewer");
    await user.click(panel.getByRole("button", { name: "Add" }));
    await user.click(panel.getByRole("button", { name: "Add member" }));
    await user.selectOptions(panel.getByRole("combobox", { name: "Member" }), "bot:bot-2");
    await user.click(panel.getByRole("button", { name: "Add" }));
    await user.click(panel.getByRole("button", { name: "coder actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Make viewer" }));
    await user.click(panel.getByRole("button", { name: "coder actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove from channel" }));
    expect(hive.calls.command.map((entry) => entry.command)).toEqual([
      { type: "channel.member.add", channelId: "ch-1", userId: "user-2", role: "viewer" },
      { type: "channel.member.add", channelId: "ch-1", botId: "bot-2", role: "member" },
      { type: "channel.member.update", channelId: "ch-1", botId: "bot-1", role: "viewer" },
      { type: "channel.member.remove", channelId: "ch-1", botId: "bot-1" },
    ]);
  });

  it("hides membership controls when the caller cannot manage members", async () => {
    const { panel, user } = await openGeneral({
      get: {
        "/v1/channels/ch-1/members": {
          canManage: false,
          members: [
            { actorId: "actor-user-1", name: "Mina", userId: "user-1", botId: null, role: "owner" },
          ],
        },
      },
    });
    await user.click(panel.getByRole("tab", { name: "Members" }));
    await panel.findByText("owner");
    expect(panel.queryByRole("button", { name: "Add member" })).toBeNull();
    expect(panel.queryByRole("button", { name: "Mina (you) actions" })).toBeNull();
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
