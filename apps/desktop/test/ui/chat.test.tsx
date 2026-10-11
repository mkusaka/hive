// @vitest-environment happy-dom
import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "./fakeHive.ts";

const agentSend = (text: string) => ({
  workspaceId: "ws-1",
  command: {
    type: "agent.send",
    recipientBotId: "bot-1",
    channelId: "ch-1",
    message: { kind: "request", text },
    delivery: "wake",
  },
});

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

  it("sends agent.send on Enter and shows the accepted operation", async () => {
    const { hive, user } = renderApp();
    await screen.findByText("please fix the build");
    await user.type(screen.getByRole("textbox", { name: "Message" }), "hello{Enter}");
    expect(hive.sent("agent.send")).toEqual([agentSend("hello")]);
    expect(await screen.findByText(/accepted, routing pending/)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "",
    );
  });

  it("sends with the button, and Shift+Enter adds a line instead", async () => {
    const { hive, user } = renderApp();
    await screen.findByText("please fix the build");
    const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    await user.type(box, "line 1{Shift>}{Enter}{/Shift}line 2");
    expect(hive.calls.command).toEqual([]);
    expect(box.value).toBe("line 1\nline 2");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(hive.sent("agent.send")).toEqual([agentSend("line 1\nline 2")]);
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
});
