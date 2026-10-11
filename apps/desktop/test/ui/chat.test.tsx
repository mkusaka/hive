// @vitest-environment happy-dom
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { dayLabel } from "../../src/renderer/src/chat.tsx";
import { renderApp } from "./fakeHive.ts";
import { channels, messages } from "./fixtures.ts";

const post = (text: string) => ({
  workspaceId: "ws-1",
  command: { type: "message.post", channelId: "ch-1", text },
});

const accepted = (inboxItemIds: string[]) => () => ({
  ok: true as const,
  value: { status: "accepted", inboxItemIds },
});

const options = () =>
  screen
    .queryAllByRole("option")
    .map((o) => [o.textContent?.trim(), o.getAttribute("aria-selected")]);

describe("chat", () => {
  it("renders the Markdown subset in bubbles", async () => {
    const { container } = renderApp();
    expect((await screen.findByText("Done")).tagName).toBe("STRONG");
    expect([...container.querySelectorAll(".bubble li")].map((li) => li.textContent)).toEqual([
      "one",
      "two",
    ]);
    expect(screen.getByText("bun test").tagName).toBe("CODE");
  });

  it("shows the user's own messages as You and a bot's under its name", async () => {
    const { container } = renderApp();
    await screen.findByText("please fix the build");
    const authors = [...container.querySelectorAll(".message .author")].map((a) =>
      a.firstElementChild?.textContent?.trim(),
    );
    // Oldest first; a bot author's blob letter precedes its name.
    expect(authors).toEqual(["You", "C coder"]);
  });

  it("posts message.post on Enter; without a mention it says nobody was woken", async () => {
    const { hive, user } = renderApp({ command: accepted([]) });
    await screen.findByText("please fix the build");
    const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    expect(box.placeholder).toBe("Message #general");
    await user.type(box, "hello{Enter}");
    expect(hive.sent("message.post")).toEqual([post("hello")]);
    expect(await screen.findByText(/posted, no Bot mentioned/)).toBeTruthy();
    expect(box.value).toBe("");
  });

  it("sends with the button, and Shift+Enter adds a line instead", async () => {
    const { hive, user } = renderApp();
    await screen.findByText("please fix the build");
    const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    await user.type(box, "line 1{Shift>}{Enter}{/Shift}line 2");
    expect(hive.calls.command).toEqual([]);
    expect(box.value).toBe("line 1\nline 2");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(hive.sent("message.post")).toEqual([post("line 1\nline 2")]);
  });

  it("opens the @ popup filtered by the prefix and picks with Enter", async () => {
    const { hive, user } = renderApp({ command: accepted(["in-1"]) });
    await screen.findByText("please fix the build");
    const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    await user.type(box, "@");
    expect(options()).toEqual([
      ["C coder", "true"],
      ["R reviewer", "false"],
    ]);
    await user.type(box, "cod");
    expect(options()).toEqual([["C coder", "true"]]);
    await user.keyboard("{Enter}");
    expect(box.value).toBe("@coder ");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(hive.calls.command).toEqual([]);
    await user.type(box, "reply with exactly: mention ok{Enter}");
    expect(hive.sent("message.post")).toEqual([
      post("<@bot:bot-1> reply with exactly: mention ok"),
    ]);
    expect(await screen.findByText(/accepted, routing pending/)).toBeTruthy();
  });

  it("moves with the arrows, picks with Tab, closes on Esc", async () => {
    const { hive, user } = renderApp();
    await screen.findByText("please fix the build");
    const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    await user.type(box, "@");
    await user.keyboard("{ArrowDown}{Tab}");
    expect(box.value).toBe("@reviewer ");
    await user.type(box, "and @");
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    // With the popup closed, Enter sends; the unpicked `@` stays text.
    await user.keyboard("{Enter}");
    expect(hive.sent("message.post")).toEqual([post("<@bot:bot-2> and @")]);
  });

  it("shows one Job id per mentioned Bot once routing created them", async () => {
    const { hive, user } = renderApp({ command: accepted(["in-1", "in-2"]) });
    await screen.findByText("please fix the build");
    await user.type(
      screen.getByRole("textbox", { name: "Message" }),
      "@c{Enter}@r{Enter}hi{Enter}",
    );
    expect(hive.sent("message.post")).toEqual([post("<@bot:bot-1> <@bot:bot-2> hi")]);
    hive.routes[`/v1/operations/${hive.calls.command[0]!.operationId}`] = {
      jobIds: ["job-7", "job-8"],
    };
    expect(await screen.findByText("job-8", {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText(/jobs/).textContent).toMatch(/jobs job-7, job-8$/);
  });

  it("renders mention tokens as @name pills in bubbles and the sidebar preview", async () => {
    const body = "<@bot:bot-1> and <@bot:gone> look";
    const { container } = renderApp({
      get: {
        "/v1/channels": {
          channels: [{ ...channels[0], lastMessage: { body, createdAt: "x", actorId: "a" } }],
        },
        "/v1/channels/ch-1/messages": {
          messages: [{ ...messages[1], body }],
        },
      },
    });
    await screen.findByText("@unknown", { selector: ".bubble .mention" });
    const pills = (where: string) =>
      [...container.querySelectorAll(`${where} .mention`)].map((m) => m.textContent);
    expect(pills(".bubble")).toEqual(["@coder", "@unknown"]);
    expect(pills(".preview")).toEqual(["@coder", "@unknown"]);
  });

  it("refetches messages and the channel list on a channel:* sync.changed", async () => {
    const { hive } = renderApp();
    await screen.findByText("please fix the build");
    const count = (path: string) => hive.calls.get.filter((p) => p.startsWith(path)).length;
    const before = { channels: count("/v1/channels?"), messages: count("/v1/channels/ch-1/") };
    hive.routes["/v1/sync/changes"] = (q) =>
      q.get("cursor")
        ? {
            changes: [{ scope: "channel:ch-1", entityKind: "message" }],
            cursor: "C1",
            hasMore: false,
          }
        : { changes: [], cursor: "H0", hasMore: false };
    hive.routes["/v1/channels/ch-1/messages"] = {
      messages: [
        {
          id: "msg-9",
          actorId: "actor-bot-1",
          userId: null,
          body: "a new reply",
          createdAt: "2026-10-11T10:05:00.000Z",
        },
      ],
    };
    act(() => hive.emit({ type: "sync.changed", cursor: "C1", scopes: ["channel:ch-1"] }));
    expect(await screen.findByText("a new reply")).toBeTruthy();
    expect(count("/v1/channels?")).toBe(before.channels + 1);
    expect(count("/v1/channels/ch-1/")).toBe(before.messages + 1);
  });

  it("groups messages by day under a date pill", async () => {
    const { container } = renderApp();
    await screen.findByText("please fix the build");
    const days = [...container.querySelectorAll(".day")];
    expect(days).toHaveLength(1);
    expect(days[0]!.querySelector(".day-pill")!.textContent).toBe(
      dayLabel(new Date(messages[0]!.createdAt)),
    );
    expect(days[0]!.querySelectorAll(".message")).toHaveLength(2);
    const now = new Date(2026, 9, 12, 9);
    expect(dayLabel(new Date(2026, 9, 12, 1), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 11, 23), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 6), now)).toBe("Tuesday, October 6");
    expect(dayLabel(new Date(2025, 11, 31), now)).toBe("Wednesday, December 31, 2025");
  });

  it("stars the channel from the header star (sidebar.update), shown in Starred", async () => {
    const { hive, user, container } = renderApp();
    await user.click(await screen.findByRole("button", { name: "Star #general" }));
    await vi.waitFor(() =>
      expect(hive.sent("sidebar.update").map((s) => s.command)).toEqual([
        {
          type: "sidebar.update",
          prefs: { pinned: [{ kind: "channel", id: "ch-1" }], hidden: [], groups: [] },
          expectedRevision: 0,
        },
      ]),
    );
    expect(screen.getByRole("button", { name: "Unstar #general" })).toBeTruthy();
    const starred = within(container.querySelector(".side-section")!);
    expect(starred.getByText("# general")).toBeTruthy();
  });

  it("opens the channel panel on Members from the member count and on About from …", async () => {
    const { user, container } = renderApp();
    await user.click(await screen.findByRole("button", { name: "2 members" }));
    const panel = () => within(container.querySelector<HTMLElement>(".panel")!);
    expect(panel().getByRole("tab", { name: "Members" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(await panel().findByText("Mina (you)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Channel details" }));
    expect(panel().getByRole("tab", { name: "About" }).getAttribute("aria-selected")).toBe("true");
  });
});
