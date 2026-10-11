import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, claim, envelope, executor, login, queuedJob, setup } from "./helpers.ts";

const db = env.DB;

const conversationId = async (workspaceId: string, channelId: string) =>
  (await db
    .prepare(
      "SELECT id FROM conversations WHERE workspace_id = ? AND channel_id = ? AND kind = 'channel'",
    )
    .bind(workspaceId, channelId)
    .first<{ id: string }>())!.id;

describe("PERM-01 channel roles", () => {
  it("allows viewers to read but not post or manage members", async () => {
    const s = await setup();
    const other = await login();
    const { userId } = await (await other.me()).json<{ userId: string }>();
    await db.batch([
      db
        .prepare(
          "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')",
        )
        .bind(s.workspaceId, userId),
      db
        .prepare(
          "INSERT INTO actors (id, workspace_id, kind, user_id, display_name) VALUES (?, ?, 'user', ?, 'viewer')",
        )
        .bind(crypto.randomUUID(), s.workspaceId, userId),
    ]);
    expect(
      (
        await other.command(
          envelope(s.workspaceId, {
            type: "channel.member.add",
            channelId: s.channelId,
            botId: s.botId,
            role: "viewer",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await other.command(
          envelope(s.workspaceId, {
            type: "channel.member.update",
            channelId: s.channelId,
            botId: s.botId,
            role: "viewer",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await other.command(
          envelope(s.workspaceId, {
            type: "channel.member.remove",
            channelId: s.channelId,
            botId: s.botId,
          }),
        )
      ).status,
    ).toBe(403);
    await s.ok({ type: "channel.member.add", channelId: s.channelId, userId, role: "viewer" });
    expect(
      (await other.get(`/v1/channels/${s.channelId}/messages?workspaceId=${s.workspaceId}`)).status,
    ).toBe(200);
    expect(
      (
        await other.command(
          envelope(s.workspaceId, {
            type: "message.post",
            channelId: s.channelId,
            text: `<@bot:${s.botId}> no`,
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await other.command(
          envelope(s.workspaceId, {
            type: "channel.member.remove",
            channelId: s.channelId,
            botId: s.botId,
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("never wakes a viewer Bot from direct send or a mention", async () => {
    const s = await setup();
    await s.ok({
      type: "channel.member.update",
      channelId: s.channelId,
      botId: s.botId,
      role: "viewer",
    });
    const mention = await s.user.command(
      envelope(s.workspaceId, {
        type: "message.post",
        channelId: s.channelId,
        text: `<@bot:${s.botId}> no`,
      }),
    );
    expect(mention.status).toBe(200);
    expect((await mention.json<{ inboxItemIds: string[] }>()).inboxItemIds).toEqual([]);
    expect((await s.user.command(s.send())).status).toBe(403);
  });
});

describe("PERM-01 Bot management", () => {
  it("enforces management flags and limits a Run to its Bot and child Bots", async () => {
    const s = await setup();
    const destination = await conversationId(s.workspaceId, s.channelId);
    const request = {
      type: "subscription.create",
      botId: s.botId,
      eventTypes: ["github.*"],
      destination: { conversationId: destination },
    };
    const routine = {
      type: "routine.create",
      botId: s.botId,
      name: "daily",
      schedule: { kind: "once", at: new Date(Date.now() + 60_000).toISOString() },
      inputText: "summarize",
      conversationId: destination,
    };
    const deniedJob = await queuedJob(s);
    const deniedClaim = await (
      await executor(s.deviceToken, s.workspaceId).command(claim(deniedJob.jobId))
    ).json<{ runId: string; executionGeneration: number; capability: { token: string } }>();
    const deniedHeaders = { Authorization: `Bearer ${deniedClaim.capability.token}` };
    expect(
      (await call("/v1/run/commands", deniedHeaders, envelope(s.workspaceId, request))).status,
    ).toBe(403);
    expect(
      (await call("/v1/run/commands", deniedHeaders, envelope(s.workspaceId, routine))).status,
    ).toBe(403);
    expect(
      (
        await executor(s.deviceToken, s.workspaceId).command({
          type: "run.result.submit",
          runId: deniedClaim.runId,
          executionGeneration: deniedClaim.executionGeneration,
          state: "succeeded",
          summary: "denied",
        })
      ).status,
    ).toBe(200);

    const listed = await (
      await s.user.get(`/v1/bots?workspaceId=${s.workspaceId}`)
    ).json<{ bots: { revision: number }[] }>();
    await s.ok({
      type: "bot.update",
      botId: s.botId,
      expectedRevision: listed.bots[0]!.revision,
      toolPolicy: { manage: { subscriptions: true, routines: true } },
    });
    const allowedJob = await queuedJob(s);
    const allowedClaim = await (
      await executor(s.deviceToken, s.workspaceId).command(claim(allowedJob.jobId))
    ).json<{ capability: { token: string } }>();
    const headers = { Authorization: `Bearer ${allowedClaim.capability.token}` };
    const created = await call("/v1/run/commands", headers, envelope(s.workspaceId, request));
    expect(created.status).toBe(200);
    const body = await created.json<{ subscriptionId: string }>();
    const receipt = await db
      .prepare("SELECT actor_id FROM operation_receipts WHERE workspace_id = ? AND response LIKE ?")
      .bind(s.workspaceId, `%${body.subscriptionId}%`)
      .first<{ actor_id: string }>();
    expect(receipt!.actor_id).toBe(allowedClaim.capability.token.split(".")[1]);

    const ownedRoutineResponse = await call(
      "/v1/run/commands",
      headers,
      envelope(s.workspaceId, routine),
    );
    expect(ownedRoutineResponse.status).toBe(200);
    const ownedRoutine = await ownedRoutineResponse.json<{ routineId: string }>();
    expect(
      (
        await call(
          "/v1/run/commands",
          headers,
          envelope(s.workspaceId, {
            type: "routine.update",
            routineId: ownedRoutine.routineId,
            expectedRevision: 1,
            name: "weekday",
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      await db
        .prepare("SELECT name FROM routines WHERE id = ?")
        .bind(ownedRoutine.routineId)
        .first(),
    ).toMatchObject({ name: "weekday" });
    for (const command of [
      { type: "routine.pause", routineId: ownedRoutine.routineId },
      { type: "routine.resume", routineId: ownedRoutine.routineId },
      { type: "routine.delete", routineId: ownedRoutine.routineId },
    ]) {
      expect(
        // oxlint-disable-next-line no-await-in-loop -- pause, resume and delete are ordered state transitions.
        (await call("/v1/run/commands", headers, envelope(s.workspaceId, command))).status,
      ).toBe(200);
      // oxlint-disable-next-line no-await-in-loop -- inspect the state after each transition.
      const saved = await db
        .prepare("SELECT enabled FROM routines WHERE id = ?")
        .bind(ownedRoutine.routineId)
        .first<{ enabled: number }>();
      if (command.type === "routine.delete") expect(saved).toBeNull();
      else expect(saved?.enabled).toBe(command.type === "routine.pause" ? 0 : 1);
    }

    const { botId: unrelated } = await s.ok({ type: "bot.create", name: "unrelated" });
    await s.ok({
      type: "channel.member.add",
      channelId: s.channelId,
      botId: unrelated,
      role: "member",
    });
    expect(
      (
        await call(
          "/v1/run/commands",
          headers,
          envelope(s.workspaceId, { ...request, botId: unrelated }),
        )
      ).status,
    ).toBe(403);
    const unrelatedRoutine = await s.ok({ ...routine, botId: unrelated, name: "unrelated" });
    for (const command of [
      {
        type: "routine.update",
        routineId: unrelatedRoutine.routineId as string,
        expectedRevision: 1,
        name: "blocked",
      },
      { type: "routine.pause", routineId: unrelatedRoutine.routineId as string },
      { type: "routine.resume", routineId: unrelatedRoutine.routineId as string },
      { type: "routine.delete", routineId: unrelatedRoutine.routineId as string },
    ]) {
      expect(
        // oxlint-disable-next-line no-await-in-loop -- verify each denied command without concurrent mutations.
        (await call("/v1/run/commands", headers, envelope(s.workspaceId, command))).status,
      ).toBe(403);
    }
  });

  it("creates child Bots with false manage flags and creates Bot-owned Channels", async () => {
    const s = await setup();
    const listed = await (
      await s.user.get(`/v1/bots?workspaceId=${s.workspaceId}`)
    ).json<{ bots: { revision: number }[] }>();
    await s.ok({
      type: "bot.update",
      botId: s.botId,
      expectedRevision: listed.bots[0]!.revision,
      toolPolicy: {
        tools: { Read: "allow" },
        manage: { bots: true, channels: true, subscriptions: true },
      },
    });
    const job = await queuedJob(s);
    const claimed = await (
      await executor(s.deviceToken, s.workspaceId).command(claim(job.jobId))
    ).json<{ capability: { token: string } }>();
    const headers = { Authorization: `Bearer ${claimed.capability.token}` };
    const wide = await call(
      "/v1/run/commands",
      headers,
      envelope(s.workspaceId, {
        type: "bot.create",
        name: "wide",
        toolPolicy: { tools: { Bash: "allow" } },
      }),
    );
    expect(wide.status).toBe(403);
    const child = await (
      await call(
        "/v1/run/commands",
        headers,
        envelope(s.workspaceId, {
          type: "bot.create",
          name: "child",
          toolPolicy: { tools: { Read: "allow" }, manage: { bots: true } },
        }),
      )
    ).json<{ botId: string }>();
    const childRow = await db
      .prepare("SELECT created_by_bot_id, tool_policy FROM bots WHERE id = ?")
      .bind(child.botId)
      .first<{ created_by_bot_id: string; tool_policy: string }>();
    expect(childRow!.created_by_bot_id).toBe(s.botId);
    const childPolicy = JSON.parse(childRow!.tool_policy) as { manage?: Record<string, boolean> };
    expect(Object.values(childPolicy.manage ?? {}).every((enabled) => !enabled)).toBe(true);
    await s.ok({
      type: "channel.member.add",
      channelId: s.channelId,
      botId: child.botId,
      role: "member",
    });
    const subscription = await call(
      "/v1/run/commands",
      headers,
      envelope(s.workspaceId, {
        type: "subscription.create",
        botId: child.botId,
        eventTypes: ["github.*"],
        destination: { conversationId: await conversationId(s.workspaceId, s.channelId) },
      }),
    );
    expect(subscription.status).toBe(200);
    const channel = await (
      await call(
        "/v1/run/commands",
        headers,
        envelope(s.workspaceId, { type: "channel.create", name: "bot-owned" }),
      )
    ).json<{ channelId: string }>();
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM channel_members WHERE workspace_id = ? AND channel_id = ? AND role = 'owner'",
        )
        .bind(s.workspaceId, channel.channelId)
        .first<{ n: number }>(),
    ).toEqual({ n: 2 });
  });
});
