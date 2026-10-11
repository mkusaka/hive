// @vitest-environment happy-dom
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderApp, type FakeHiveOptions } from "./fakeHive.ts";

/** Opens #general's panel from the header pill. */
const openGeneral = async (overrides: FakeHiveOptions = {}) => {
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
  it("creates a webhook routine and discloses its URL and secret once", async () => {
    const { panel, user, hive } = await openGeneral({
      command: (envelope) =>
        envelope.command.type === "routine.create"
          ? {
              ok: true,
              value: { secret: "created-secret", hookPath: "/v1/hooks/routines/rt-new" },
            }
          : undefined,
    });
    await user.click(panel.getByRole("tab", { name: "Routines" }));
    await user.click(panel.getByRole("button", { name: "New routine" }));
    await user.type(panel.getByLabelText("Name"), "Deploy hook");
    await user.selectOptions(panel.getByLabelText("Trigger"), "webhook");
    await user.type(panel.getByLabelText("Input"), "Review the deployment");
    await user.click(panel.getByRole("button", { name: "Create" }));
    expect((panel.getByLabelText("Webhook URL") as HTMLInputElement).value).toBe(
      "https://hive.test/v1/hooks/routines/rt-new",
    );
    expect((panel.getByLabelText("Secret (shown once)") as HTMLInputElement).value).toBe(
      "created-secret",
    );
    expect(panel.queryByRole("button", { name: "Create" })).toBeNull();
    expect(hive.sent("routine.create")[0]).toMatchObject({
      command: { schedule: { kind: "webhook" } },
    });
  });

  it("rotates a webhook secret and clears it when done", async () => {
    const webhook = {
      id: "rt-hook",
      botId: "bot-1",
      name: "Deploy hook",
      conversationId: "conv-1",
      taskId: null,
      inputText: "Review the deployment",
      schedule: { kind: "webhook" },
      scheduleRevision: 1,
      misfire: "coalesce",
      enabled: true,
      revision: 1,
      hookPath: "/v1/hooks/routines/rt-hook",
    };
    const event = {
      ...webhook,
      id: "rt-event",
      name: "PR events",
      schedule: {
        kind: "event",
        filter: { op: "prefix", field: "type", value: "github.pull_request" },
      },
    };
    const { panel, user, hive } = await openGeneral({
      get: { "/v1/routines": { routines: [webhook, event] } },
      command: (envelope) =>
        envelope.command.type === "routine.rotate_secret"
          ? {
              ok: true,
              value: { secret: "rotated-secret", hookPath: "/v1/hooks/routines/rt-hook" },
            }
          : undefined,
    });
    await user.click(panel.getByRole("tab", { name: "Routines" }));
    expect(await panel.findByText("When a webhook fires")).toBeTruthy();
    expect(panel.getByText("When github.pull_request events match")).toBeTruthy();
    await user.click(await panel.findByRole("button", { name: "Deploy hook actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    await user.click(panel.getByRole("button", { name: "Rotate secret" }));
    expect((panel.getByLabelText("Secret (shown once)") as HTMLInputElement).value).toBe(
      "rotated-secret",
    );
    await user.click(panel.getByRole("button", { name: "Done" }));
    expect(panel.queryByLabelText("Secret (shown once)")).toBeNull();
    await user.click(await panel.findByRole("button", { name: "PR events actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    await user.clear(panel.getByLabelText("Event type prefix"));
    await user.type(panel.getByLabelText("Event type prefix"), "github.issue");
    await user.click(panel.getByRole("button", { name: "Save" }));
    expect(hive.sent("routine.update")).toEqual([
      {
        workspaceId: "ws-1",
        command: {
          type: "routine.update",
          routineId: "rt-event",
          expectedRevision: 1,
          schedule: {
            kind: "event",
            filter: { op: "prefix", field: "type", value: "github.issue" },
          },
        },
      },
    ]);
    await user.click(await panel.findByRole("button", { name: "PR events actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    await user.type(panel.getByLabelText("Filter JSON (optional)"), "{{not json");
    await user.click(panel.getByRole("button", { name: "Save" }));
    expect(panel.getByText("Filter must be valid JSON.")).toBeTruthy();
    expect(hive.sent("routine.update")).toHaveLength(1);
  });
  it("switches an existing routine to a webhook and discloses its replacement secret", async () => {
    const { panel, user, hive } = await openGeneral({
      command: (envelope) =>
        envelope.command.type === "routine.update"
          ? {
              ok: true,
              value: { secret: "switched-secret", hookPath: "/v1/hooks/routines/rt-1" },
            }
          : undefined,
    });
    await user.click(panel.getByRole("tab", { name: "Routines" }));
    await user.click(await panel.findByRole("button", { name: "Daily digest actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    await user.selectOptions(panel.getByLabelText("Trigger"), "webhook");
    await user.click(panel.getByRole("button", { name: "Save" }));
    expect((panel.getByLabelText("Webhook URL") as HTMLInputElement).value).toBe(
      "https://hive.test/v1/hooks/routines/rt-1",
    );
    expect((panel.getByLabelText("Secret (shown once)") as HTMLInputElement).value).toBe(
      "switched-secret",
    );
    expect(hive.sent("routine.update")[0]).toMatchObject({
      command: { schedule: { kind: "webhook" } },
    });
    await user.selectOptions(panel.getByLabelText("Trigger"), "cron");
    await user.selectOptions(panel.getByLabelText("Trigger"), "webhook");
    expect(panel.queryByLabelText("Secret (shown once)")).toBeNull();
  });

  it("edits a JSON-only event filter without requiring a type prefix", async () => {
    const routine = {
      id: "rt-cli",
      botId: "bot-1",
      name: "CLI event",
      conversationId: "conv-1",
      taskId: null,
      inputText: "Handle the event",
      schedule: { kind: "event", filter: { op: "eq", field: "data.action", value: "opened" } },
      scheduleRevision: 1,
      misfire: "coalesce",
      enabled: true,
      revision: 1,
    };
    const { panel, user, hive } = await openGeneral({
      get: {
        "/v1/routines": {
          routines: [
            routine,
            {
              ...routine,
              id: "rt-type",
              name: "Typed event",
              schedule: { kind: "event", filter: { op: "eq", field: "type", value: "demo.ping" } },
            },
          ],
        },
      },
    });
    await user.click(panel.getByRole("tab", { name: "Routines" }));
    expect(await panel.findByText("When demo.ping events match")).toBeTruthy();
    expect(panel.getByText("When events match")).toBeTruthy();
    await user.click(await panel.findByRole("button", { name: "CLI event actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect((panel.getByLabelText("Event type prefix") as HTMLInputElement).value).toBe("");
    await user.clear(panel.getByLabelText("Filter JSON (optional)"));
    await user.type(
      panel.getByLabelText("Filter JSON (optional)"),
      '{{"op":"eq","field":"data.action","value":"closed"}',
    );
    await user.click(panel.getByRole("button", { name: "Save" }));
    expect(hive.sent("routine.update")).toEqual([
      {
        workspaceId: "ws-1",
        command: {
          type: "routine.update",
          routineId: "rt-cli",
          expectedRevision: 1,
          schedule: { kind: "event", filter: { op: "eq", field: "data.action", value: "closed" } },
        },
      },
    ]);
  });

  it("keeps an untouched event filter when saving another field", async () => {
    const routine = {
      id: "rt-filter",
      botId: "bot-1",
      name: "Nested event",
      conversationId: "conv-1",
      taskId: null,
      inputText: "Handle the event",
      schedule: {
        kind: "event",
        filter: {
          op: "and",
          nodes: [
            { op: "prefix", field: "type", value: "github.issue" },
            { op: "eq", field: "data.action", value: "opened" },
          ],
        },
      },
      scheduleRevision: 1,
      misfire: "coalesce",
      enabled: true,
      revision: 1,
    };
    const { panel, user, hive } = await openGeneral({
      get: { "/v1/routines": { routines: [routine] } },
    });
    await user.click(panel.getByRole("tab", { name: "Routines" }));
    await user.click(await panel.findByRole("button", { name: "Nested event actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    await user.clear(panel.getByLabelText("Name"));
    await user.type(panel.getByLabelText("Name"), "Renamed event");
    await user.click(panel.getByRole("button", { name: "Save" }));
    expect(hive.sent("routine.update")).toEqual([
      {
        workspaceId: "ws-1",
        command: {
          type: "routine.update",
          routineId: "rt-filter",
          expectedRevision: 1,
          name: "Renamed event",
        },
      },
    ]);
  });

  it("creates an event routine with a validated filter", async () => {
    const { panel, user, hive } = await openGeneral();
    await user.click(panel.getByRole("tab", { name: "Routines" }));
    await user.click(panel.getByRole("button", { name: "New routine" }));
    await user.type(panel.getByLabelText("Name"), "PR events");
    await user.selectOptions(panel.getByLabelText("Trigger"), "event");
    await user.type(panel.getByLabelText("Event type prefix"), "github.pull_request");
    await user.type(
      panel.getByLabelText("Filter JSON (optional)"),
      '{{"op":"eq","field":"data.action","value":"opened"}',
    );
    await user.type(panel.getByLabelText("Input"), "Review the pull request");
    await user.click(panel.getByRole("button", { name: "Create" }));
    expect(hive.sent("routine.create")[0]).toMatchObject({
      command: {
        schedule: {
          kind: "event",
          filter: {
            op: "and",
            nodes: [
              { op: "prefix", field: "type", value: "github.pull_request" },
              { op: "eq", field: "data.action", value: "opened" },
            ],
          },
        },
      },
    });
  });

  it("rejects an invalid event filter before sending a command", async () => {
    const { panel, user, hive } = await openGeneral();
    await user.click(panel.getByRole("tab", { name: "Routines" }));
    await user.click(panel.getByRole("button", { name: "New routine" }));
    await user.type(panel.getByLabelText("Name"), "Broken event");
    await user.selectOptions(panel.getByLabelText("Trigger"), "event");
    await user.type(panel.getByLabelText("Event type prefix"), "github.issue");
    await user.type(panel.getByLabelText("Filter JSON (optional)"), "{{not json");
    await user.type(panel.getByLabelText("Input"), "Do not send");
    await user.click(panel.getByRole("button", { name: "Create" }));
    expect(panel.getByText("Filter must be valid JSON.")).toBeTruthy();
    expect(hive.calls.command).toEqual([]);
  });
});
