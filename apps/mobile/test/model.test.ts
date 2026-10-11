import { describe, expect, it } from "vitest";
import {
  conversationSections,
  insertMention,
  mentionSuggestions,
  notificationTarget,
  postMessage,
  type Conversation,
} from "../src/model";

const channel: Conversation = { kind: "channel", id: "c1", title: "#dev" };
const bots = [
  { id: "coder", name: "Coder" },
  { id: "reviewer", name: "Reviewer" },
];

describe("mobile conversation list", () => {
  it("puts pinned conversations first in stored order, omits hidden ones even if pinned, and keeps groups distinct", () => {
    const channels = [
      { id: "c1", name: "dev", lastMessage: { body: "latest" } },
      { id: "c2", name: "hidden" },
      { id: "c3", name: "grouped" },
    ];
    const sections = conversationSections(
      channels,
      [{ id: "dm1", name: "Coder", botId: "coder" }],
      {
        pinned: [
          { kind: "dm", id: "dm1" },
          { kind: "channel", id: "c2" },
          { kind: "channel", id: "c1" },
        ],
        hidden: [{ kind: "channel", id: "c2" }],
        groups: [
          {
            name: "Work",
            items: [
              { kind: "channel", id: "c3" },
              { kind: "channel", id: "c1" },
            ],
          },
        ],
      },
    );
    expect(sections[0]?.items.map((item) => item.key)).toEqual(["dm:dm1", "channel:c1"]);
    expect(sections[1]?.items.map((item) => item.key)).toEqual(["channel:c3"]);
    expect(sections.flatMap((section) => section.items).map((item) => item.key)).toEqual([
      "dm:dm1",
      "channel:c1",
      "channel:c3",
    ]);
    expect(sections[0]?.items[1]?.preview).toBe("latest");
  });

  it("honors pinned and hidden Bots when starting DMs", () => {
    const sections = conversationSections(
      [],
      [],
      {
        pinned: [{ kind: "bot", id: "coder" }],
        hidden: [{ kind: "bot", id: "reviewer" }],
        groups: [],
      },
      bots,
    );
    expect(sections[0]?.items.map((item) => item.key)).toEqual(["bot:coder"]);
    expect(sections.flatMap((section) => section.items).map((item) => item.key)).toEqual([
      "bot:coder",
    ]);
  });
});

describe("mobile composer", () => {
  it("suggests by case-insensitive @prefix, inserts a bot token and posts to a channel", () => {
    expect(mentionSuggestions("hello @co", bots, channel)).toEqual([bots[0]]);
    expect(mentionSuggestions("hello coder", bots, channel)).toEqual([]);
    const draft = insertMention("hello @co", "coder");
    expect(postMessage(channel, draft + "reply")).toEqual({
      type: "message.post",
      channelId: "c1",
      text: "hello <@bot:coder> reply",
    });
  });
  it("only suggests the counterpart of a DM and preserves the thread target", () => {
    const dm: Conversation = { kind: "dm", id: "dm1", botId: "coder", title: "Coder" };
    expect(mentionSuggestions("@", bots, dm)).toEqual([bots[0]]);
    expect(postMessage({ ...dm, threadOf: "root1" }, " reply ")).toEqual({
      type: "message.post",
      conversationId: "dm1",
      threadOf: "root1",
      text: "reply",
    });
    expect(postMessage({ kind: "thread", id: "thread1", title: "Thread" }, "reply")).toEqual({
      type: "message.post",
      conversationId: "thread1",
      text: "reply",
    });
  });
});

it("accepts identifier-only notification hints, never embedded approval decisions or content", () => {
  expect(notificationTarget({ kind: "approval", id: "a1" })).toEqual({
    kind: "approval",
    id: "a1",
  });
  expect(notificationTarget({ kind: "mention", id: "dm1" })).toEqual({
    kind: "mention",
    id: "dm1",
  });
  expect(notificationTarget({ kind: "job", id: "j1" })).toEqual({ kind: "job", id: "j1" });
  for (const invalid of [
    { kind: "approval", id: "a1", credential: "unsafe" },
    { kind: "approval", id: "a1", decision: "allow" },
    { kind: "run", id: "r1" },
    { kind: "job", id: "" },
    null,
  ])
    expect(notificationTarget(invalid)).toBeNull();
});
