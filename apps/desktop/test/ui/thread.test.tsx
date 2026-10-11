// @vitest-environment happy-dom
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, sidebar } from "./fakeHive.ts";
import { me, messages } from "./fixtures.ts";

const thread = {
  conversationId: "thread-msg-1",
  replyCount: 2,
  lastReplyAt: "2026-10-11T10:43:00.000Z",
  participants: ["actor-user-1", "actor-bot-1"],
};
const reply = (id: string, seq: number, actorId: string, body: string) => ({
  id,
  conversationId: "thread-msg-1",
  seq,
  actorId,
  userId: actorId === "actor-user-1" ? me : null,
  body,
  createdAt: `2026-10-11T10:4${seq}:00.000Z`,
});
const routes = {
  "/v1/channels/ch-1/messages": {
    messages: messages.map((m) => (m.id === "msg-1" ? { ...m, thread } : m)),
  },
  "/v1/conversations/thread-msg-1/messages": {
    messages: [
      reply("r-2", 2, "actor-bot-1", "thread ok"),
      reply("r-1", 1, "actor-user-1", "ping"),
    ],
    root: messages[1],
  },
  "/v1/threads": {
    threads: [
      {
        conversationId: "thread-msg-1",
        channelId: "ch-1",
        parentConversationId: "conv-1",
        parentKind: "channel",
        channelName: "general",
        root: {
          id: "msg-1",
          actorId: "actor-user-1",
          body: "please fix the build",
          createdAt: "x",
        },
        replyCount: 2,
        lastReplyAt: "2026-10-11T10:43:00.000Z",
      },
    ],
  },
};

const panel = () => within(screen.getByRole("complementary", { name: "Thread" }));
const replyBox = () =>
  waitFor(() => {
    const box = screen.getByRole("textbox", { name: "Reply" });
    if (!box.querySelector("[data-placeholder]")) throw new Error("composer not ready");
    return box;
  });

describe("threads", () => {
  it("shows a thread footer with the reply count under a message with replies", async () => {
    renderApp({ get: routes });
    const footer = await screen.findByRole("button", { name: /2 replies/ });
    expect(footer.textContent).toContain("last reply");
    // Only the root has a footer.
    expect(screen.getAllByRole("button", { name: /repl(y|ies)/ })).toHaveLength(1);
  });

  it("clicking the footer opens the Thread panel with the root and its replies", async () => {
    const { hive, user } = renderApp({ get: routes });
    await user.click(await screen.findByRole("button", { name: /2 replies/ }));
    await waitFor(() => expect(panel().getByText("thread ok")).toBeTruthy());
    expect(panel().getByText("please fix the build")).toBeTruthy();
    expect(panel().getByText("ping")).toBeTruthy();
    expect(hive.calls.get).toContain("/v1/conversations/thread-msg-1/messages?workspaceId=ws-1");
  });

  it("Reply in thread posts message.post with threadOf and then shows the new thread", async () => {
    const { hive, user } = renderApp({
      get: routes,
      command: (e) =>
        e.command.type === "message.post"
          ? {
              ok: true,
              value: { status: "accepted", conversationId: "thread-msg-2", inboxItemIds: [] },
            }
          : undefined,
    });
    hive.routes["/v1/conversations/thread-msg-2/messages"] = {
      messages: [
        { ...reply("r-9", 1, "actor-user-1", "first reply"), conversationId: "thread-msg-2" },
      ],
      root: messages[0],
    };
    await screen.findByText("Done");
    const replyButtons = screen.getAllByRole("button", { name: "Reply in thread" });
    // Oldest first: msg-1, then msg-2.
    await user.click(replyButtons[1]!);
    await user.type(await replyBox(), "first reply{Enter}");
    expect(hive.sent("message.post")).toEqual([
      {
        workspaceId: "ws-1",
        command: {
          type: "message.post",
          channelId: "ch-1",
          threadOf: "msg-2",
          text: "first reply",
        },
      },
    ]);
    await waitFor(() => expect(panel().getByText("first reply")).toBeTruthy());
  });

  it("the Threads view lists the user's threads and opens one", async () => {
    const { user } = renderApp({ get: routes });
    await user.click(await (await sidebar()).findByRole("button", { name: "Threads" }));
    const row = await screen.findByRole("button", { name: /please fix the build/ });
    expect(row.textContent).toContain("#general");
    expect(row.textContent).toContain("2 replies");
    await user.click(row);
    await waitFor(() => expect(panel().getByText("thread ok")).toBeTruthy());
  });
});
