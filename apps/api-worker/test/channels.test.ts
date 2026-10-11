// Channel topic (`channel.update`) and the members list (UI-03, strict since DM-01).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { envelope, type Json, login, setup } from "./helpers.ts";

const db = env.DB;

/** A second Workspace member with a user actor, not in the setup Channel. */
const outsider = async (workspaceId: string) => {
  const other = await login();
  const { userId } = await (await other.me()).json<{ userId: string }>();
  await db.batch([
    db
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')",
      )
      .bind(workspaceId, userId),
    db
      .prepare(
        "INSERT INTO actors (id, workspace_id, kind, user_id, display_name) VALUES (?, ?, 'user', ?, 'other')",
      )
      .bind(crypto.randomUUID(), workspaceId, userId),
  ]);
  return other;
};

describe("channels", () => {
  it("channel.update sets and clears the topic for members only, with a channel change row", async () => {
    const s = await setup();
    const topic = async () =>
      (
        await (
          await s.user.get(`/v1/channels?workspaceId=${s.workspaceId}`)
        ).json<{
          channels: Json[];
        }>()
      ).channels.find((c) => c.id === s.channelId)!.topic;
    expect(await topic()).toBeNull();
    const set = await s.ok({ type: "channel.update", channelId: s.channelId, topic: "Daily ops" });
    expect(set.topic).toBe("Daily ops");
    expect(await topic()).toBe("Daily ops");
    const change = await db
      .prepare(
        "SELECT scope FROM change_log WHERE workspace_id = ? AND entity_kind = 'channel' ORDER BY seq DESC LIMIT 1",
      )
      .bind(s.workspaceId)
      .first<{ scope: string }>();
    expect(change?.scope).toBe(`channel:${s.channelId}`);
    await s.ok({ type: "channel.update", channelId: s.channelId, topic: "  " });
    expect(await topic()).toBeNull();

    const tooLong = await s.user.command(
      envelope(s.workspaceId, {
        type: "channel.update",
        channelId: s.channelId,
        topic: "x".repeat(251),
      }),
    );
    expect(tooLong.status).toBe(422);
    const missing = await s.user.command(
      envelope(s.workspaceId, { type: "channel.update", channelId: "nope", topic: "x" }),
    );
    expect(missing.status).toBe(404);
    const other = await outsider(s.workspaceId);
    const forbidden = await other.command(
      envelope(s.workspaceId, { type: "channel.update", channelId: s.channelId, topic: "x" }),
    );
    expect(forbidden.status).toBe(403);
  });

  it("lists members only (a Bot that posted is not one), for members only", async () => {
    const s = await setup();
    const bot = await db
      .prepare("SELECT actor_id FROM bots WHERE id = ?")
      .bind(s.botId)
      .first<{ actor_id: string }>();
    const { conversationId } = (
      await (
        await s.user.get(`/v1/channels?workspaceId=${s.workspaceId}`)
      ).json<{
        channels: Json[];
      }>()
    ).channels[0]!;
    const path = `/v1/channels/${s.channelId}/members?workspaceId=${s.workspaceId}`;
    const members = async () =>
      (await (await s.user.get(path)).json<{ members: Json[] }>()).members;
    await db
      .prepare(
        `INSERT INTO messages (id, workspace_id, conversation_id, seq, actor_id, client_message_id, body)
         VALUES (?, ?, ?, 1, ?, ?, 'hi')`,
      )
      .bind(crypto.randomUUID(), s.workspaceId, conversationId, bot!.actor_id, crypto.randomUUID())
      .run();
    expect(await members()).toEqual([
      expect.objectContaining({ userId: expect.any(String), role: "owner", botId: null }),
      expect.objectContaining({ botId: s.botId, role: "member" }),
    ]);
    const other = await outsider(s.workspaceId);
    expect((await other.get(path)).status).toBe(404);
  });

  it("keeps the last channel owner while allowing an owner to manage members", async () => {
    const s = await setup();
    const self = await (await s.user.me()).json<{ userId: string }>();
    const lastOwner = await s.user.command(
      envelope(s.workspaceId, {
        type: "channel.member.update",
        channelId: s.channelId,
        userId: self.userId,
        role: "member",
      }),
    );
    expect(lastOwner.status).toBe(422);
    const other = await outsider(s.workspaceId);
    const otherMe = await (await other.me()).json<{ userId: string }>();
    await s.ok({
      type: "channel.member.add",
      channelId: s.channelId,
      userId: otherMe.userId,
      role: "owner",
    });
    const demoted = await s.ok({
      type: "channel.member.update",
      channelId: s.channelId,
      userId: self.userId,
      role: "member",
    });
    expect(demoted.role).toBe("member");
  });
});
