import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import type { Hono } from "hono";
import { exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { type AppEnv, createApp } from "../src/app.ts";
import { sendMobilePush } from "../src/push.ts";
import {
  claim,
  envelope,
  executor,
  localJwks,
  login,
  queuedJob,
  request,
  setup,
} from "./helpers.ts";

const db = env.DB;
const { privateKey } = await generateKeyPair("RS256", { extractable: true });
const privateKeyPem = await exportPKCS8(privateKey);

const requestWith = async (
  app: Hono<AppEnv>,
  path: string,
  headers: Record<string, string>,
  body: unknown,
  bindings: Cloudflare.Env,
) => {
  const ctx = createExecutionContext();
  const response = await app.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
};

const fcmApp = (calls: unknown[]) => {
  const serviceAccount = JSON.stringify({
    project_id: `project-${crypto.randomUUID()}`,
    client_email: `hive-${crypto.randomUUID()}@example.test`,
    private_key: privateKeyPem,
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    if (String(input) === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "fcm-access-token", expires_in: 3600 }));
    }
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ name: "projects/test/messages/1" }));
  };
  return {
    app: createApp({ jwks: () => localJwks, fetchImpl }),
    bindings: { ...env, FCM_SERVICE_ACCOUNT_JSON: serviceAccount },
  };
};

describe("mobile push registration", () => {
  it("is owned by the authenticated user and unregisters only that user's instance", async () => {
    const owner = await login();
    const instanceId = crypto.randomUUID();
    const token = "fcm-owner-token";
    const registered = await request("/v1/devices/mobile", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...owner.headers },
      body: JSON.stringify({ instanceId, token }),
    });
    expect(registered.status).toBe(200);

    const other = await login();
    const otherId = (await (await other.me()).json<{ userId: string }>()).userId;
    const switchedInstance = crypto.randomUUID();
    const switched = await request("/v1/devices/mobile", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...other.headers },
      body: JSON.stringify({ instanceId: switchedInstance, token }),
    });
    expect(switched.status).toBe(200);
    expect(
      await db
        .prepare("SELECT user_id, instance_id FROM mobile_push_tokens WHERE token = ?")
        .bind(token)
        .first(),
    ).toEqual({ user_id: otherId, instance_id: switchedInstance });

    const removedByOwner = await request("/v1/devices/mobile", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...owner.headers },
      body: JSON.stringify({ instanceId: switchedInstance }),
    });
    expect(removedByOwner.status).toBe(200);
    expect(
      await db.prepare("SELECT 1 FROM mobile_push_tokens WHERE token = ?").bind(token).first(),
    ).not.toBeNull();

    const removed = await request("/v1/devices/mobile", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...other.headers },
      body: JSON.stringify({ instanceId: switchedInstance }),
    });
    expect(removed.status).toBe(200);
    expect(
      await db.prepare("SELECT 1 FROM mobile_push_tokens WHERE token = ?").bind(token).first(),
    ).toBeNull();
  });

  it("does not call FCM when the service-account secret is absent", async () => {
    const user = await login();
    const userId = (await (await user.me()).json<{ userId: string }>()).userId;
    await db
      .prepare("INSERT INTO mobile_push_tokens (user_id, instance_id, token) VALUES (?, ?, ?)")
      .bind(userId, crypto.randomUUID(), "fcm-no-secret")
      .run();
    let called = false;
    await sendMobilePush(
      db,
      {},
      { recipients: [userId], kind: "approval", id: crypto.randomUUID() },
      async () => {
        called = true;
        return new Response();
      },
    );
    expect(called).toBe(false);
  });
});

describe("mobile push delivery", () => {
  it("notifies only mentioned channel members with an identifier-only conversation payload", async () => {
    const s = await setup();
    const mentioned = await login();
    const mentionedId = (await (await mentioned.me()).json<{ userId: string }>()).userId;
    const excluded = await login();
    const excludedId = (await (await excluded.me()).json<{ userId: string }>()).userId;
    await db.batch([
      db
        .prepare(
          "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')",
        )
        .bind(s.workspaceId, mentionedId),
      db
        .prepare(
          "INSERT INTO actors (id, workspace_id, kind, user_id, display_name) VALUES (?, ?, 'user', ?, 'mentioned')",
        )
        .bind(crypto.randomUUID(), s.workspaceId, mentionedId),
      db
        .prepare(
          "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')",
        )
        .bind(s.workspaceId, excludedId),
    ]);
    const actor = await db
      .prepare("SELECT id FROM actors WHERE workspace_id = ? AND user_id = ?")
      .bind(s.workspaceId, mentionedId)
      .first<{ id: string }>();
    if (!actor) throw new Error("mentioned actor missing");
    await db
      .prepare(
        "INSERT INTO channel_members (workspace_id, channel_id, actor_id, role) VALUES (?, ?, ?, 'member')",
      )
      .bind(s.workspaceId, s.channelId, actor.id)
      .run();
    await request("/v1/devices/mobile", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...mentioned.headers },
      body: JSON.stringify({ instanceId: crypto.randomUUID(), token: "fcm-mentioned" }),
    });

    const calls: unknown[] = [];
    const fcm = fcmApp(calls);
    const posted = await requestWith(
      fcm.app,
      "/v1/commands",
      s.user.headers,
      envelope(s.workspaceId, {
        type: "message.post",
        channelId: s.channelId,
        text: `<@user:${mentionedId}> hello`,
      }),
      fcm.bindings,
    );
    expect(posted.status).toBe(200);
    const accepted = await posted.json<{ conversationId: string }>();
    expect(calls).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          data: { kind: "mention", id: accepted.conversationId },
          notification: { title: "Hive", body: "New activity is ready" },
        }),
      }),
    ]);

    const target = await request(`/v1/mobile/targets/mention/${accepted.conversationId}`, {
      headers: mentioned.headers,
    });
    expect(target.status).toBe(200);
    expect(await target.json()).toMatchObject({
      workspaceId: s.workspaceId,
      channelId: s.channelId,
      conversationId: accepted.conversationId,
    });
    const hiddenTarget = await request(`/v1/mobile/targets/mention/${accepted.conversationId}`, {
      headers: excluded.headers,
    });
    expect(hiddenTarget.status).toBe(404);

    const unauthorized = await requestWith(
      fcm.app,
      "/v1/commands",
      s.user.headers,
      envelope(s.workspaceId, {
        type: "message.post",
        channelId: s.channelId,
        text: `<@user:${excludedId}> private`,
      }),
      fcm.bindings,
    );
    expect(unauthorized.status).toBe(422);
    expect(calls).toHaveLength(1);
  });

  it("sends one approval push for an idempotent approval request", async () => {
    const s = await setup();
    const ownerId = (await (await s.user.me()).json<{ userId: string }>()).userId;
    await db
      .prepare("INSERT INTO mobile_push_tokens (user_id, instance_id, token) VALUES (?, ?, ?)")
      .bind(ownerId, crypto.randomUUID(), "fcm-approval")
      .run();
    const { jobId } = await queuedJob(s);
    const claimed = await (
      await executor(s.deviceToken, s.workspaceId).command(claim(jobId))
    ).json<{ capability: { token: string } }>();
    const requestBody = envelope(
      s.workspaceId,
      {
        type: "approval.request",
        actionKind: "Bash",
        argsHash: "a".repeat(64),
        argsSummary: "ls",
        cwdLabel: "run_scratch",
      },
      "mobile-push-approval",
    );
    const calls: unknown[] = [];
    const fcm = fcmApp(calls);
    const headers = { Authorization: `Bearer ${claimed.capability.token}` };
    const first = await requestWith(
      fcm.app,
      "/v1/run/commands",
      headers,
      requestBody,
      fcm.bindings,
    );
    expect(first.status).toBe(200);
    const approval = await first.json<{ approvalId: string }>();
    expect(calls).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ data: { kind: "approval", id: approval.approvalId } }),
      }),
    ]);

    const replay = await requestWith(
      fcm.app,
      "/v1/run/commands",
      headers,
      requestBody,
      fcm.bindings,
    );
    expect(replay.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("notifies a DM user with the DM conversation identifier after a bot reply", async () => {
    const s = await setup();
    const ownerId = (await (await s.user.me()).json<{ userId: string }>()).userId;
    const { conversationId } = await s.ok({ type: "dm.open", botId: s.botId });
    await db
      .prepare("INSERT INTO mobile_push_tokens (user_id, instance_id, token) VALUES (?, ?, ?)")
      .bind(ownerId, crypto.randomUUID(), "fcm-dm-reply")
      .run();
    const initial = envelope(s.workspaceId, {
      type: "message.post",
      conversationId,
      text: "reply please",
    });
    await s.user.command(initial);
    await s.pump();
    const operation = await (
      await s.user.get(`/v1/operations/${initial.operationId}`)
    ).json<{ jobIds: string[] }>();
    const claimed = await (
      await executor(s.deviceToken, s.workspaceId).command(claim(operation.jobIds[0]!))
    ).json<{ runId: string; executionGeneration: number }>();
    const calls: unknown[] = [];
    const fcm = fcmApp(calls);
    const result = await requestWith(
      fcm.app,
      "/v1/executor/commands",
      { Authorization: `Bearer ${s.deviceToken}` },
      envelope(s.workspaceId, {
        type: "run.result.submit",
        runId: claimed.runId,
        executionGeneration: claimed.executionGeneration,
        state: "succeeded",
        summary: "done",
        reply: { conversationId, text: "done" },
      }),
      fcm.bindings,
    );
    expect(result.status).toBe(200);
    expect(calls).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ data: { kind: "mention", id: conversationId } }),
      }),
    ]);

    const target = await request(`/v1/mobile/targets/mention/${conversationId}`, {
      headers: s.user.headers,
    });
    expect(target.status).toBe(200);
    expect(await target.json()).toMatchObject({ conversationId, botId: s.botId });
  });

  it("notifies the DM user for a bot reply in a DM thread using the thread identifier", async () => {
    const s = await setup();
    const ownerId = (await (await s.user.me()).json<{ userId: string }>()).userId;
    const { conversationId } = await s.ok({ type: "dm.open", botId: s.botId });
    await db
      .prepare("INSERT INTO mobile_push_tokens (user_id, instance_id, token) VALUES (?, ?, ?)")
      .bind(ownerId, crypto.randomUUID(), "fcm-dm-thread-reply")
      .run();
    const rootRequest = envelope(s.workspaceId, {
      type: "message.post",
      conversationId,
      text: "root",
    });
    const root = await (await s.user.command(rootRequest)).json<{ messageId: string }>();
    const threadRequest = envelope(s.workspaceId, {
      type: "message.post",
      conversationId,
      threadOf: root.messageId,
      text: "thread",
    });
    const thread = await (await s.user.command(threadRequest)).json<{ conversationId: string }>();
    await s.pump();
    const operation = await (
      await s.user.get(`/v1/operations/${threadRequest.operationId}`)
    ).json<{ jobIds: string[] }>();
    const claimed = await (
      await executor(s.deviceToken, s.workspaceId).command(claim(operation.jobIds[0]!))
    ).json<{ runId: string; executionGeneration: number }>();
    const calls: unknown[] = [];
    const fcm = fcmApp(calls);
    const result = await requestWith(
      fcm.app,
      "/v1/executor/commands",
      { Authorization: `Bearer ${s.deviceToken}` },
      envelope(s.workspaceId, {
        type: "run.result.submit",
        runId: claimed.runId,
        executionGeneration: claimed.executionGeneration,
        state: "succeeded",
        summary: "done",
        reply: { conversationId: thread.conversationId, text: "done" },
      }),
      fcm.bindings,
    );
    expect(result.status).toBe(200);
    expect(calls).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ data: { kind: "mention", id: thread.conversationId } }),
      }),
    ]);
  });
});
