// @vitest-environment happy-dom
// Group chat in a Channel (ROUTE-02): presence blobs, the Members state, @everyone, Reply and the "passed" badge.
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, sidebar } from "./fakeHive.ts";
import { messages } from "./fixtures.ts";

const presence = {
  "/v1/channels/ch-1/presence": {
    presence: [
      { botId: "bot-1", name: "coder", state: "working" },
      { botId: "bot-2", name: "reviewer", state: "reading" },
    ],
  },
};

describe("group chat", () => {
  it("shows reading / working Bots as blobs on the member count, and their state in Members", async () => {
    const { user, container } = renderApp({ get: presence });
    const members = await screen.findByRole("button", { name: /members?$/ });
    expect(await within(members).findByTitle("coder is working")).toBeTruthy();
    expect(within(members).getByTitle("reviewer is reading")).toBeTruthy();
    await user.click(members);
    const panel = within(container.querySelector<HTMLElement>(".panel")!);
    expect(await panel.findByText("working")).toBeTruthy();
  });

  it("offers @everyone in a Channel and sends the <@everyone> token", async () => {
    const { user, hive } = renderApp();
    await screen.findByText("please fix the build");
    const box = screen.getByRole("textbox", { name: "Message" });
    await user.type(box, "@al");
    expect(screen.getAllByRole("option").map((o) => o.textContent?.trim())).toEqual(["E everyone"]);
    await user.keyboard("{Enter}");
    await user.type(box, "say your name{Enter}");
    expect(hive.sent("message.post")).toEqual([
      {
        workspaceId: "ws-1",
        command: { type: "message.post", channelId: "ch-1", text: "<@everyone> say your name" },
      },
    ]);
  });

  it("Reply on a Bot's message sends replyToMessageId and a reply shows its quote", async () => {
    const reply = {
      id: "msg-3",
      conversationId: "conv-1",
      seq: 3,
      actorId: "actor-user-1",
      userId: "user-1",
      body: "thanks",
      replyToMessageId: "msg-2",
      createdAt: "2026-10-11T10:02:00.000Z",
    };
    const { user, hive } = renderApp({
      get: { "/v1/channels/ch-1/messages": { messages: [reply, ...messages] } },
    });
    expect(await screen.findByText(/Replying to coder: \*\*Done\*\*/)).toBeTruthy();
    const botMessage = screen.getByText("Done").closest("article")!;
    await user.click(within(botMessage).getByRole("button", { name: "Reply" }));
    expect(screen.getByText("Replying to coder")).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Message" }), "one more word{Enter}");
    expect(hive.sent("message.post")).toEqual([
      {
        workspaceId: "ws-1",
        command: {
          type: "message.post",
          channelId: "ch-1",
          replyToMessageId: "msg-2",
          text: "one more word",
        },
      },
    ]);
    expect(screen.queryByRole("button", { name: "Cancel reply" })).toBeNull();
  });

  it("shows a passed Job and Run as passed in Activity", async () => {
    const { user } = renderApp({
      get: {
        "/v1/jobs": { jobs: [{ id: "job-1", state: "succeeded", outcome: "pass" }] },
        "/v1/jobs/job-1": {
          id: "job-1",
          state: "succeeded",
          runs: [{ id: "run-1", generation: 1, state: "succeeded", outcome: "pass" }],
        },
      },
    });
    await user.click(await (await sidebar()).findByRole("button", { name: "Activity" }));
    await user.click(await screen.findByRole("button", { name: /job-1/ }));
    const badges = await screen.findAllByText("passed");
    expect(badges.map((b) => b.className)).toEqual(["badge passed", "badge passed"]);
  });
});
