// Direct messages with a Bot and Bots as Channel members (DM-01).
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

const opened = async () => {
  const s = await setup();
  const { conversationId } = await s.ok({ type: "dm.open", botId: s.botId });
  const post = (text: string) =>
    envelope(s.workspaceId, { type: "message.post", conversationId, text });
  return { ...s, conversationId: conversationId as string, post };
};

describe("direct messages", () => {
  it("dm.open returns the same conversation every time and lists it with its Bot", async () => {
    const s = await opened();
    const again = await s.ok({ type: "dm.open", botId: s.botId });
    expect(again.conversationId).toBe(s.conversationId);
    expect(await count("conversations WHERE kind = 'dm' AND workspace_id = ?", s.workspaceId)).toBe(
      1,
    );
    // Not a channel of the user.
    const { channels } = await (
      await s.user.get(`/v1/channels?workspaceId=${s.workspaceId}`)
    ).json<{ channels: Json[] }>();
    expect(channels.map((c) => c.name)).toEqual(["dev"]);
    const { dms } = await (
      await s.user.get(`/v1/dms?workspaceId=${s.workspaceId}`)
    ).json<{
      dms: Json[];
    }>();
    expect(dms).toEqual([
      expect.objectContaining({
        id: s.conversationId,
        conversationId: s.conversationId,
        botId: s.botId,
        name: "coder",
        lastMessage: null,
      }),
    ]);
    const missing = await s.user.command(
      envelope(s.workspaceId, { type: "dm.open", botId: "nope" }),
    );
    expect(missing.status).toBe(404);
  });

  it("message.post in a DM wakes its Bot once; the Run sees kind dm with the user and replies there", async () => {
    const s = await opened();
    const request = s.post("reply with exactly: dm ok");
    const res = await s.user.command(request);
    expect(res.status).toBe(200);
    const body = await res.json<{ inboxItemIds: string[] }>();
    expect(body.inboxItemIds).toHaveLength(1);
    await s.pump();
    const op = await (await s.user.get(`/v1/operations/${request.operationId}`)).json<Json>();
    const [jobId] = op.jobIds as string[];
    const job = await (await s.user.get(`/v1/jobs/${jobId}`)).json<Json>();
    expect(job.botId).toBe(s.botId);

    const device = executor(s.deviceToken, s.workspaceId);
    const run = await (await device.command(claim(jobId!))).json<Claimed>();
    const context = await (
      await device.get(
        `/v1/executor/jobs/${jobId}/context?runId=${run.runId}&executionGeneration=${run.executionGeneration}`,
      )
    ).json<{ conversation: { id: string; kind: string; counterpart: Json } }>();
    expect(context.conversation).toMatchObject({
      id: s.conversationId,
      kind: "dm",
      counterpart: { actorId: expect.any(String), name: expect.any(String) },
    });
    const submitted = await device.command({
      type: "run.result.submit",
      runId: run.runId,
      executionGeneration: run.executionGeneration,
      state: "succeeded",
      summary: "dm ok",
      reply: { conversationId: s.conversationId, text: "dm ok" },
    });
    expect(submitted.status).toBe(200);
    const path = `/v1/conversations/${s.conversationId}/messages?workspaceId=${s.workspaceId}`;
    const { messages } = await (await s.user.get(path)).json<{ messages: Json[] }>();
    expect(messages.map((m) => m.body)).toEqual(["dm ok", "reply with exactly: dm ok"]);

    // The DM's changes reach its user through sync.
    const changes = await db
      .prepare(
        "SELECT DISTINCT scope FROM change_log WHERE workspace_id = ? AND entity_kind = 'message'",
      )
      .bind(s.workspaceId)
      .all<{ scope: string }>();
    expect(changes.results.map((r) => r.scope)).toEqual([`channel:${s.conversationId}`]);
  });

  it("is participant-only and rejects mentions of another Bot", async () => {
    const s = await opened();
    const { botId: reviewerId } = await s.ok({ type: "bot.create", name: "reviewer" });
    const other = await s.user.command(s.post(`<@bot:${reviewerId}> hi`));
    expect(other.status).toBe(422);
    expect((await s.user.command(s.post(`<@bot:${s.botId}> hi`))).status).toBe(200);

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
    const path = `/v1/conversations/${s.conversationId}/messages?workspaceId=${s.workspaceId}`;
    expect((await outsider.get(path)).status).toBe(404);
    expect((await outsider.command(s.post("hi"))).status).toBe(404);
    const { dms } = await (
      await outsider.get(`/v1/dms?workspaceId=${s.workspaceId}`)
    ).json<{
      dms: Json[];
    }>();
    expect(dms).toEqual([]);
  });
});

const members = async (s: Awaited<ReturnType<typeof setup>>) =>
  (
    await (
      await s.user.get(`/v1/channels/${s.channelId}/members?workspaceId=${s.workspaceId}`)
    ).json<{ members: Json[] }>()
  ).members;

describe("bots as channel members", () => {
  it("channel.join / channel.leave add and remove a Bot; a channel change row each", async () => {
    // channel.create wrote the first channel change row.
    const s = await setup();
    const join = { type: "channel.join", channelId: s.channelId, botId: s.botId };
    await s.ok(join);
    await s.ok(join);
    expect(await members(s)).toEqual([
      expect.objectContaining({ kind: "user", role: "owner" }),
      expect.objectContaining({ kind: "bot", role: "member", botId: s.botId, name: "coder" }),
    ]);
    expect(
      await count(
        "change_log WHERE workspace_id = ? AND entity_kind = 'channel' AND scope = ?",
        s.workspaceId,
        `channel:${s.channelId}`,
      ),
    ).toBe(3);
    await s.ok({ type: "channel.leave", channelId: s.channelId, botId: s.botId });
    expect(await members(s)).toEqual([expect.objectContaining({ kind: "user" })]);

    const outsider = await login();
    const forbidden = await outsider.command(envelope(s.workspaceId, join));
    expect(forbidden.status).toBe(403);
  });

  it("message.post auto-joins a mentioned non-member Bot; a member Bot is not woken unless mentioned", async () => {
    const s = await setup();
    await s.ok({
      type: "message.post",
      channelId: s.channelId,
      text: `<@bot:${s.botId}> hi`,
    });
    expect(await members(s)).toEqual([
      expect.objectContaining({ kind: "user" }),
      expect.objectContaining({ kind: "bot", role: "member", botId: s.botId }),
    ]);
    expect(await count("inbox_items WHERE workspace_id = ?", s.workspaceId)).toBe(1);
    const plain = await s.ok({ type: "message.post", channelId: s.channelId, text: "no mention" });
    expect(plain.inboxItemIds).toEqual([]);
    expect(await count("inbox_items WHERE workspace_id = ?", s.workspaceId)).toBe(1);
    // channel.create's row plus one join: the second mention adds no channel change row.
    await s.ok({ type: "message.post", channelId: s.channelId, text: `<@bot:${s.botId}> again` });
    expect(
      await count("change_log WHERE workspace_id = ? AND entity_kind = 'channel'", s.workspaceId),
    ).toBe(2);
  });
});
