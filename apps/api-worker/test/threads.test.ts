// Threads: a reply is a message of a `thread` conversation rooted at a Channel / DM message (THREAD-01).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  type Claimed,
  claim,
  count,
  envelope,
  executor,
  type Json,
  login,
  setup,
} from "./helpers.ts";

const db = env.DB;

const rooted = async () => {
  const s = await setup();
  const post = (text: string, threadOf?: string) =>
    s.ok({ type: "message.post", channelId: s.channelId, text, ...(threadOf ? { threadOf } : {}) });
  const root = await post("root message");
  const messages = async (path: string) =>
    await (
      await s.user.get(`${path}?workspaceId=${s.workspaceId}`)
    ).json<{
      messages: Json[];
      root?: Json;
    }>();
  return { ...s, post, rootId: root.messageId as string, messages };
};

/** pump → claim the operation's one Job; its Run context and a submit that replies `text` into `conversationId`. */
const runFor = async (s: Awaited<ReturnType<typeof rooted>>, inboxItemId: string) => {
  await s.pump();
  const job = await db
    .prepare("SELECT id FROM jobs WHERE trigger_key = ?")
    .bind(`inbox:${inboxItemId}`)
    .first<{ id: string }>();
  const device = executor(s.deviceToken, s.workspaceId);
  const run = await (await device.command(claim(job!.id))).json<Claimed>();
  const context = await (
    await device.get(
      `/v1/executor/jobs/${job!.id}/context?runId=${run.runId}&executionGeneration=${run.executionGeneration}`,
    )
  ).json<Json>();
  const reply = (conversationId: string, text: string) =>
    device.command({
      type: "run.result.submit",
      runId: run.runId,
      executionGeneration: run.executionGeneration,
      state: "succeeded",
      summary: text,
      reply: { conversationId, text },
    });
  return { context, reply };
};

describe("threads", () => {
  it("creates the thread on the first reply once; the channel stays one channel with its own conversation", async () => {
    const s = await rooted();
    const first = await s.post("reply 1", s.rootId);
    const second = await s.post("reply 2", s.rootId);
    expect(first.conversationId).toBe(`thread-${s.rootId}`);
    expect(second.conversationId).toBe(first.conversationId);
    expect(
      await count("conversations WHERE kind = 'thread' AND workspace_id = ?", s.workspaceId),
    ).toBe(1);
    // Neither a reply's own thread nor an unknown message can be a root.
    const nested = await s.user.command(
      envelope(s.workspaceId, {
        type: "message.post",
        channelId: s.channelId,
        text: "x",
        threadOf: first.messageId,
      }),
    );
    expect(nested.status).toBe(404);

    const plain = await s.post("after the thread");
    expect(plain.conversationId).not.toBe(first.conversationId);
    const { channels } = await (
      await s.user.get(`/v1/channels?workspaceId=${s.workspaceId}`)
    ).json<{ channels: Json[] }>();
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      conversationId: plain.conversationId,
      lastMessage: { body: "after the thread" },
    });
    // Replies refresh the open channel: they carry the parent's scope.
    expect(
      await count(
        "change_log WHERE entity_kind = 'message' AND entity_id = ? AND scope = ?",
        first.messageId,
        `channel:${s.channelId}`,
      ),
    ).toBe(1);
  });

  it("summarizes each message's thread and lists the thread's replies with its root", async () => {
    const s = await rooted();
    await s.post("reply 1", s.rootId);
    await s.post("reply 2", s.rootId);
    const parent = await s.messages(`/v1/channels/${s.channelId}/messages`);
    // Replies are not channel messages, and the preview stays the root.
    expect(parent.messages.map((m) => m.body)).toEqual(["root message"]);
    const { channels } = await (
      await s.user.get(`/v1/channels?workspaceId=${s.workspaceId}`)
    ).json<{ channels: Json[] }>();
    expect(channels[0]!.lastMessage).toMatchObject({ body: "root message" });
    const thread = parent.messages[0]!.thread as Json;
    expect(thread).toMatchObject({
      conversationId: `thread-${s.rootId}`,
      replyCount: 2,
      lastReplyAt: expect.any(String),
    });
    expect(thread.participants).toHaveLength(1);

    const replies = await s.messages(`/v1/conversations/thread-${s.rootId}/messages`);
    expect(replies.messages.map((m) => m.body)).toEqual(["reply 2", "reply 1"]);
    expect(replies.root).toMatchObject({ id: s.rootId, body: "root message" });

    const { threads } = await (
      await s.user.get(`/v1/threads?participant=me&workspaceId=${s.workspaceId}`)
    ).json<{ threads: Json[] }>();
    expect(threads).toEqual([
      expect.objectContaining({
        conversationId: `thread-${s.rootId}`,
        channelId: s.channelId,
        parentKind: "channel",
        channelName: "dev",
        replyCount: 2,
        root: expect.objectContaining({ id: s.rootId, body: "root message" }),
      }),
    ]);
  });

  it("a mention in a reply wakes the Bot in the thread; its reply lands there; later replies wake it unmentioned", async () => {
    const s = await rooted();
    await s.post("earlier in the channel");
    const root2 = await s.post("deploy question");
    const mentioned = await s.post(
      `<@bot:${s.botId}> reply with exactly: thread ok`,
      root2.messageId as string,
    );
    const threadId = `thread-${root2.messageId}`;
    const [itemId] = mentioned.inboxItemIds as string[];
    const first = await runFor(s, itemId!);
    expect(first.context.conversation).toMatchObject({
      id: threadId,
      kind: "thread",
      channelId: s.channelId,
    });
    const recent = (first.context.conversation as { recent: Json[] }).recent.map((m) => m.body);
    expect(recent).toEqual(["deploy question", "@coder reply with exactly: thread ok"]);
    expect((first.context.parentMessages as Json[]).map((m) => m.body)).toEqual([
      "root message",
      "earlier in the channel",
    ]);
    // The Run may reply only in its thread.
    expect((await first.reply(String(s.channelId), "nope")).status).toBe(403);
    expect((await first.reply(threadId, "thread ok")).status).toBe(200);
    const replies = await s.messages(`/v1/conversations/${threadId}/messages`);
    expect(replies.messages.map((m) => m.body)).toEqual([
      "thread ok",
      `<@bot:${s.botId}> reply with exactly: thread ok`,
    ]);
    const parent = await s.messages(`/v1/channels/${s.channelId}/messages`);
    expect(parent.messages.map((m) => m.body)).not.toContain("thread ok");

    // The Bot took part: an unmentioned reply wakes it again; a reply in a thread it never joined does not.
    const again = await s.post("and one more word", root2.messageId as string);
    expect(again.inboxItemIds).toHaveLength(1);
    const second = await runFor(s, (again.inboxItemIds as string[])[0]!);
    expect(second.context.conversation).toMatchObject({ id: threadId });
    const elsewhere = await s.post("no bot here", s.rootId);
    expect(elsewhere.inboxItemIds).toEqual([]);
  });

  it("a thread is readable only by who may read its parent; a DM thread wakes the DM's Bot", async () => {
    const s = await rooted();
    await s.post("reply", s.rootId);
    const outsider = await login();
    const { userId } = await (await outsider.me()).json<{ userId: string }>();
    await db.batch([
      db
        .prepare(
          "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')",
        )
        .bind(s.workspaceId, userId),
      db
        .prepare(
          "INSERT INTO actors (id, workspace_id, kind, user_id, display_name) VALUES (?, ?, 'user', ?, 'other')",
        )
        .bind(crypto.randomUUID(), s.workspaceId, userId),
    ]);
    const path = `/v1/conversations/thread-${s.rootId}/messages?workspaceId=${s.workspaceId}`;
    expect((await outsider.get(path)).status).toBe(404);
    const reply = envelope(s.workspaceId, {
      type: "message.post",
      channelId: s.channelId,
      text: "hi",
      threadOf: s.rootId,
    });
    expect((await outsider.command(reply)).status).toBe(403);
    const { threads } = await (
      await outsider.get(`/v1/threads?participant=me&workspaceId=${s.workspaceId}`)
    ).json<{ threads: Json[] }>();
    expect(threads).toEqual([]);

    const { conversationId } = await s.ok({ type: "dm.open", botId: s.botId });
    const dmRoot = await s.ok({ type: "message.post", conversationId, text: "dm root" });
    const dmReply = await s.ok({
      type: "message.post",
      conversationId,
      text: "dm reply",
      threadOf: dmRoot.messageId,
    });
    expect(dmReply.inboxItemIds).toHaveLength(1);
    expect(
      (
        await outsider.get(
          `/v1/conversations/${dmReply.conversationId}/messages?workspaceId=${s.workspaceId}`,
        )
      ).status,
    ).toBe(404);
  });
});
