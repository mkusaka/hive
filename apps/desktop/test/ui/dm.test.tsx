// @vitest-environment happy-dom
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { findComposer, renderApp, sidebar } from "./fakeHive.ts";
import { dms } from "./fixtures.ts";

const dmMessages = {
  messages: [
    {
      id: "msg-9",
      conversationId: "dm-1",
      seq: 1,
      actorId: "actor-bot-1",
      userId: null,
      body: "dm ok",
      createdAt: "2026-10-11T12:00:00.000Z",
    },
  ],
};
const section = async (label: string) =>
  within((await (await sidebar()).findByRole("button", { name: label })).closest("section")!);

describe("direct messages", () => {
  it("lists DMs under Direct messages with the Bot and a preview", async () => {
    renderApp({ get: { "/v1/dms": { dms } } });
    const list = await section("Direct messages");
    expect(list.getByText("coder")).toBeTruthy();
    expect(list.getByText("dm ok")).toBeTruthy();
  });

  it("clicking a Bot without a DM sends dm.open and opens the new DM", async () => {
    const { hive, user } = renderApp({
      get: { "/v1/conversations/dm-2/messages": { messages: [] } },
      command: (e) => {
        if (e.command.type !== "dm.open") return undefined;
        hive.routes["/v1/dms"] = {
          dms: [
            { ...dms[0], id: "dm-2", conversationId: "dm-2", botId: "bot-2", name: "reviewer" },
          ],
        };
        return { ok: true, value: { conversationId: "dm-2" } };
      },
    });
    await user.click(await (await sidebar()).findByRole("button", { name: "reviewer" }));
    await findComposer("Message reviewer");
    expect(hive.sent("dm.open")).toEqual([
      { workspaceId: "ws-1", command: { type: "dm.open", botId: "bot-2" } },
    ]);
    expect(hive.calls.get).toContain("/v1/conversations/dm-2/messages?workspaceId=ws-1");
    expect((await section("Direct messages")).getByText("reviewer")).toBeTruthy();
  });

  it("posts in a DM with message.post and its conversationId; @ offers only the DM's Bot", async () => {
    const { hive, user } = renderApp({
      get: { "/v1/dms": { dms }, "/v1/conversations/dm-1/messages": dmMessages },
    });
    await user.click(await (await section("Direct messages")).findByText("coder"));
    const box = await findComposer("Message coder");
    await user.type(box, "@");
    expect(screen.getAllByRole("option").map((o) => o.textContent?.trim())).toEqual(["C coder"]);
    await user.keyboard("{Escape}{Backspace}");
    await user.type(box, "reply with exactly: dm ok{Enter}");
    expect(hive.sent("message.post")).toEqual([
      {
        workspaceId: "ws-1",
        command: {
          type: "message.post",
          conversationId: "dm-1",
          text: "reply with exactly: dm ok",
        },
      },
    ]);
    // The DM was already listed: no dm.open.
    expect(hive.sent("dm.open")).toEqual([]);
  });
});
