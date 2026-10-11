import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { maxAttachmentBytes } from "@hive/contracts";
import { claim, count, envelope, executor, login, request, setup } from "./helpers.ts";

const encoder = new TextEncoder();
const sha256 = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

type AttachmentSetup = {
  user: { headers: Record<string, string> };
  workspaceId: string;
  channelId: string;
};

const attachmentApi = (headers: Record<string, string>) => {
  const init = (body: Record<string, unknown>) =>
    request("/v1/attachments/init", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const put = (id: string, body: Uint8Array) =>
    request(`/v1/attachments/${id}/content`, { method: "PUT", headers, body });
  const complete = (id: string) =>
    request(`/v1/attachments/${id}/complete`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
    });
  return { init, put, complete };
};

const initialized = async (
  s: AttachmentSetup,
  bytes: Uint8Array,
  target: Record<string, string> = { channelId: s.channelId },
  sha?: string,
) => {
  const api = attachmentApi(s.user.headers);
  const response = await api.init({
    workspaceId: s.workspaceId,
    ...target,
    name: "note.md",
    contentType: "text/markdown",
    size: bytes.length,
    ...(sha ? { sha256: sha } : {}),
  });
  expect(response.status).toBe(200);
  const { id, uploadUrl } = await response.json<{ id: string; uploadUrl: string }>();
  expect(uploadUrl).toBe(`/v1/attachments/${id}/content`);
  return { api, id };
};

const ready = async (s: AttachmentSetup, bytes: Uint8Array, target?: Record<string, string>) => {
  const attachment = await initialized(s, bytes, target);
  expect((await attachment.api.put(attachment.id, bytes)).status).toBe(200);
  expect((await attachment.api.complete(attachment.id)).status).toBe(200);
  return attachment;
};

describe("attachments", () => {
  it("initializes, streams, completes, atomically attaches, lists and reads immutable content", async () => {
    const s = await setup();
    const bytes = encoder.encode("# deployment notes\n");
    const attachment = await ready(s, bytes);
    expect(await attachment.api.complete(attachment.id)).toHaveProperty("status", 200);

    const posted = await s.ok({
      type: "message.post",
      channelId: s.channelId,
      text: "see note",
      attachmentIds: [attachment.id],
    });
    const listed = await (
      await s.user.get(`/v1/channels/${s.channelId}/messages?workspaceId=${s.workspaceId}`)
    ).json<{
      messages: { id: string; attachments: { id: string; name: string; size: number }[] }[];
    }>();
    expect(listed.messages[0]).toMatchObject({
      id: posted.messageId,
      attachments: [{ id: attachment.id, name: "note.md", size: bytes.length }],
    });
    const downloaded = await s.user.get(`/v1/attachments/${attachment.id}`);
    expect(downloaded.headers.get("Content-Type")).toBe("text/markdown");
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
    expect((await attachment.api.put(attachment.id, bytes)).status).toBe(409);
  });

  it("rejects unsupported types, oversize streams, and checksum mismatches", async () => {
    const s = await setup();
    const api = attachmentApi(s.user.headers);
    const wrongType = await api.init({
      workspaceId: s.workspaceId,
      channelId: s.channelId,
      name: "binary.exe",
      contentType: "application/octet-stream",
      size: 1,
    });
    expect(wrongType.status).toBe(415);
    const oversized = await api.init({
      workspaceId: s.workspaceId,
      channelId: s.channelId,
      name: "huge.md",
      contentType: "text/markdown",
      size: maxAttachmentBytes + 1,
    });
    expect(oversized.status).toBe(413);

    const bytes = encoder.encode("too large for declaration");
    const limited = await initialized(s, encoder.encode("x"));
    expect((await limited.api.put(limited.id, bytes)).status).toBe(413);
    const hashed = await initialized(
      s,
      bytes,
      undefined,
      await sha256(encoder.encode("different")),
    );
    const mismatch = await hashed.api.put(hashed.id, bytes);
    expect(mismatch.status).toBe(422);
    expect(await count("attachments WHERE id = ? AND state = 'ready'", hashed.id)).toBe(0);
  });

  it("requires ready, caller-owned, unattached attachments in the exact destination and rolls back a failed post", async () => {
    const s = await setup();
    const bytes = encoder.encode("x");
    const pending = await initialized(s, bytes);
    const failed = await s.user.command(
      envelope(s.workspaceId, {
        type: "message.post",
        channelId: s.channelId,
        text: "cannot attach pending",
        attachmentIds: [pending.id],
      }),
    );
    expect(failed.status).toBe(409);
    expect(
      await count(
        "messages WHERE body = 'cannot attach pending' AND workspace_id = ?",
        s.workspaceId,
      ),
    ).toBe(0);

    const { conversationId } = await s.ok({ type: "dm.open", botId: s.botId });
    const inDm = await ready(s, bytes, { conversationId: String(conversationId) });
    const wrongConversation = await s.user.command(
      envelope(s.workspaceId, {
        type: "message.post",
        channelId: s.channelId,
        text: "cannot cross conversation",
        attachmentIds: [inDm.id],
      }),
    );
    expect(wrongConversation.status).toBe(409);
    expect(
      await count(
        "messages WHERE body = 'cannot cross conversation' AND workspace_id = ?",
        s.workspaceId,
      ),
    ).toBe(0);
    const other = await login();
    const { userId } = await (await other.me()).json<{ userId: string }>();
    const actorId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')",
      ).bind(s.workspaceId, userId),
      env.DB.prepare(
        "INSERT INTO actors (id, workspace_id, kind, user_id, display_name) VALUES (?, ?, 'user', ?, 'other')",
      ).bind(actorId, s.workspaceId, userId),
      env.DB.prepare(
        "INSERT INTO channel_members (workspace_id, channel_id, actor_id, role) VALUES (?, ?, ?, 'member')",
      ).bind(s.workspaceId, s.channelId, actorId),
    ]);
    const foreign = await ready(
      { user: other, workspaceId: s.workspaceId, channelId: s.channelId },
      bytes,
    );
    const wrongUploader = await s.user.command(
      envelope(s.workspaceId, {
        type: "message.post",
        channelId: s.channelId,
        text: "cannot attach another uploader",
        attachmentIds: [foreign.id],
      }),
    );
    expect(wrongUploader.status).toBe(409);
    expect(
      await count(
        "messages WHERE body = 'cannot attach another uploader' AND workspace_id = ?",
        s.workspaceId,
      ),
    ).toBe(0);

    const attached = await ready(s, bytes);
    await s.ok({
      type: "message.post",
      channelId: s.channelId,
      text: "first",
      attachmentIds: [attached.id],
    });
    const again = await s.user.command(
      envelope(s.workspaceId, {
        type: "message.post",
        channelId: s.channelId,
        text: "second",
        attachmentIds: [attached.id],
      }),
    );
    expect(again.status).toBe(409);
    expect(await count("messages WHERE body = 'second' AND workspace_id = ?", s.workspaceId)).toBe(
      0,
    );
  });

  it("enforces channel, DM and thread reader ACLs", async () => {
    const s = await setup();
    const bytes = encoder.encode("private");
    const channel = await ready(s, bytes);
    const root = await s.ok({ type: "message.post", channelId: s.channelId, text: "root" });
    const thread = await ready(s, bytes, {
      channelId: s.channelId,
      threadOf: String(root.messageId),
    });
    const { conversationId } = await s.ok({ type: "dm.open", botId: s.botId });
    const dm = await ready(s, bytes, { conversationId: String(conversationId) });
    expect((await s.user.get(`/v1/attachments/${channel.id}`)).status).toBe(200);
    expect((await s.user.get(`/v1/attachments/${thread.id}`)).status).toBe(200);
    expect((await s.user.get(`/v1/attachments/${dm.id}`)).status).toBe(200);
    const outsider = await login();
    const { userId } = await (await outsider.me()).json<{ userId: string }>();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')",
      ).bind(s.workspaceId, userId),
      env.DB.prepare(
        "INSERT INTO actors (id, workspace_id, kind, user_id, display_name) VALUES (?, ?, 'user', ?, 'other')",
      ).bind(crypto.randomUUID(), s.workspaceId, userId),
    ]);
    expect((await outsider.get(`/v1/attachments/${channel.id}`)).status).toBe(404);
    expect((await outsider.get(`/v1/attachments/${thread.id}`)).status).toBe(404);
    expect((await outsider.get(`/v1/attachments/${dm.id}`)).status).toBe(404);
  });

  it("includes attachment metadata in run context and permits run-capability download", async () => {
    const s = await setup();
    const bytes = encoder.encode("context file");
    const attachment = await ready(s, bytes);
    const posted = await s.ok({
      type: "message.post",
      channelId: s.channelId,
      text: `<@bot:${s.botId}> inspect this`,
      attachmentIds: [attachment.id],
    });
    await s.pump();
    const job = (await env.DB.prepare("SELECT id FROM jobs WHERE trigger_key = ?")
      .bind(`inbox:${(posted.inboxItemIds as string[])[0]}`)
      .first<{ id: string }>())!;
    const device = executor(s.deviceToken, s.workspaceId);
    const run = await (
      await device.command(claim(job.id))
    ).json<{
      runId: string;
      executionGeneration: number;
      capability: { token: string };
    }>();
    const context = await (
      await device.get(
        `/v1/executor/jobs/${job.id}/context?runId=${run.runId}&executionGeneration=${run.executionGeneration}`,
      )
    ).json<{ attachments: { id: string; messageId: string }[] }>();
    expect(context.attachments).toContainEqual(
      expect.objectContaining({ id: attachment.id, messageId: posted.messageId }),
    );
    const runDownload = await request(`/v1/run/attachments/${attachment.id}`, {
      headers: { Authorization: `Bearer ${run.capability.token}` },
    });
    expect(new Uint8Array(await runDownload.arrayBuffer())).toEqual(bytes);
  });

  it("collects expired pending and unattached ready attachments while retaining attached ones", async () => {
    const s = await setup();
    const bytes = encoder.encode("expire me");
    const pending = await initialized(s, bytes);
    const unattached = await ready(s, bytes);
    const retained = await ready(s, bytes);
    await s.ok({
      type: "message.post",
      channelId: s.channelId,
      text: "keep",
      attachmentIds: [retained.id],
    });
    await env.DB.prepare("UPDATE attachments SET created_at = ? WHERE id IN (?, ?, ?)")
      .bind(
        new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        pending.id,
        unattached.id,
        retained.id,
      )
      .run();
    await s.pump();
    expect(await count("attachments WHERE id IN (?, ?)", pending.id, unattached.id)).toBe(0);
    expect(await count("attachments WHERE id = ?", retained.id)).toBe(1);
  });
});
