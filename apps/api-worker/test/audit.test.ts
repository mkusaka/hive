import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { call, claim, envelope, executor, login, queuedJob, setup } from "./helpers.ts";

type Json = Record<string, unknown>;

const db = env.DB;

const entries = async (headers: Record<string, string>, workspaceId: string, query = "") => {
  const response = await call(`/v1/audit?workspaceId=${workspaceId}${query}`, headers);
  expect(response.status).toBe(200);
  return response.json<{ entries: Json[]; cursor: string | null }>();
};

const memberOf = async (workspaceId: string, channelId: string) => {
  const user = await login();
  const { userId } = await (await user.me()).json<{ userId: string }>();
  const actorId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')",
      )
      .bind(workspaceId, userId),
    db
      .prepare(
        "INSERT INTO actors (id, workspace_id, kind, user_id, display_name) VALUES (?, ?, 'user', ?, 'member')",
      )
      .bind(actorId, workspaceId, userId),
    db
      .prepare(
        "INSERT INTO channel_members (workspace_id, channel_id, actor_id, role) VALUES (?, ?, ?, 'member')",
      )
      .bind(workspaceId, channelId, actorId),
  ]);
  return { user, userId, actorId };
};
describe("audit", () => {
  it("records channel membership, approval resolution, and run completion without command secrets", async () => {
    const s = await setup();
    await s.ok({ type: "channel.join", channelId: s.channelId, botId: s.botId });

    const { jobId } = await queuedJob(s);
    const device = executor(s.deviceToken, s.workspaceId);
    const claimed = await (
      await device.command(claim(jobId))
    ).json<{
      runId: string;
      executionGeneration: number;
      capability: { token: string };
    }>();
    const runHeaders = { Authorization: `Bearer ${claimed.capability.token}` };
    const requested = await call(
      "/v1/run/commands",
      runHeaders,
      envelope(s.workspaceId, {
        type: "approval.request",
        actionKind: "Bash",
        argsHash: "a".repeat(64),
        argsSummary: "safe summary",
        cwdLabel: "run_scratch",
      }),
    );
    expect(requested.status).toBe(200);
    const { approvalId } = await requested.json<{ approvalId: string }>();
    expect(
      await s.user.command(
        envelope(s.workspaceId, { type: "approval.resolve", approvalId, decision: "allow" }),
      ),
    ).toMatchObject({ status: 200 });
    expect(
      await device.command({
        type: "run.result.submit",
        runId: claimed.runId,
        executionGeneration: claimed.executionGeneration,
        state: "succeeded",
        summary: "finished",
      }),
    ).toMatchObject({ status: 200 });
    expect(
      await s.user.command(
        envelope(s.workspaceId, {
          type: "bot.update",
          botId: s.botId,
          expectedRevision: 1,
          instructions: "never include this secret",
        }),
      ),
    ).toMatchObject({ status: 200 });

    const audit = await entries(s.user.headers, s.workspaceId);
    expect(audit.entries.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["channel.join", "approval.resolved", "run.finished", "bot.update"]),
    );
    expect(JSON.stringify(audit)).not.toContain("never include this secret");
    expect(audit.entries.find((entry) => entry.kind === "channel.join")).toMatchObject({
      target: { type: "channel", id: s.channelId },
      details: { botId: s.botId, result: "accepted" },
    });
    expect(audit.entries.find((entry) => entry.kind === "approval.resolved")).toMatchObject({
      details: { state: "approved" },
      target: { type: "approval", id: approvalId },
    });
    expect(audit.entries.find((entry) => entry.kind === "run.finished")).toMatchObject({
      target: { type: "run", id: claimed.runId },
      details: { state: "succeeded", deviceId: s.deviceId },
    });
    expect(audit.entries.find((entry) => entry.kind === "bot.update")).toMatchObject({
      details: { revision: 2 },
    });
  });

  it("paginates stable timestamp ties and applies exact kind and actor filters", async () => {
    const s = await setup();
    const userId = (await (await s.user.me()).json<{ userId: string }>()).userId;
    const at = "2026-01-01T00:00:00.000Z";
    await db.batch(
      ["audit-tie-a", "audit-tie-b"].map((id) =>
        db
          .prepare(
            `INSERT INTO audit_log (id, workspace_id, actor_id, action, target_kind, target_id, data, created_at)
         VALUES (?, ?, ?, 'channel.join', 'channel', ?, ?, ?)`,
          )
          .bind(
            id,
            s.workspaceId,
            userId,
            s.channelId,
            JSON.stringify({ scope: `channel:${s.channelId}` }),
            at,
          ),
      ),
    );
    const first = await entries(
      s.user.headers,
      s.workspaceId,
      "&limit=1&kinds=channel.join&actor=" + userId,
    );
    expect(first.entries.map((entry) => entry.id)).toEqual(["audit-tie-b"]);
    expect(first.cursor).not.toBeNull();
    const second = await entries(
      s.user.headers,
      s.workspaceId,
      `&limit=1&kinds=channel.join&actor=${userId}&cursor=${first.cursor!}`,
    );
    expect(second.entries.map((entry) => entry.id)).toEqual(["audit-tie-a"]);
    expect(second.cursor).toBeNull();
    const after = await entries(
      s.user.headers,
      s.workspaceId,
      "&kinds=channel.join&since=2026-01-01T01%3A00%3A00%2B01%3A00",
    );
    expect(after.entries.map((entry) => entry.id)).toEqual(["audit-tie-b", "audit-tie-a"]);
  });

  it("does not expose revoked channel or another user's private DM audit", async () => {
    const s = await setup();
    const { user: other, actorId } = await memberOf(s.workspaceId, s.channelId);
    await s.ok({ type: "channel.join", channelId: s.channelId, botId: s.botId });
    expect((await entries(other.headers, s.workspaceId, "&kinds=channel.join")).entries).toEqual([
      expect.objectContaining({
        kind: "channel.join",
        target: expect.objectContaining({ id: s.channelId }),
      }),
    ]);
    await s.ok({ type: "dm.open", botId: s.botId });
    expect((await entries(other.headers, s.workspaceId, "&kinds=dm.open")).entries).toEqual([]);
    await db
      .prepare(
        "DELETE FROM channel_members WHERE workspace_id = ? AND channel_id = ? AND actor_id = ?",
      )
      .bind(s.workspaceId, s.channelId, actorId)
      .run();
    expect((await entries(other.headers, s.workspaceId, "&kinds=channel.join")).entries).toEqual(
      [],
    );
  });

  it("paginates after ACL filtering even when many newer entries are unreadable", async () => {
    const s = await setup();
    const { user } = await memberOf(s.workspaceId, s.channelId);
    const scoped = JSON.stringify({ scope: `channel:${s.channelId}` });
    await db.batch([
      ...Array.from({ length: 12 }, (_, n) =>
        db
          .prepare(
            "INSERT INTO audit_log (id, workspace_id, actor_id, action, target_kind, target_id, data, created_at) VALUES (?, ?, 'service', 'channel.join', 'channel', 'hidden', '{}', '2026-02-01T00:00:00.000Z')",
          )
          .bind(`hidden-${n}`, s.workspaceId),
      ),
      ...["a", "b"].map((id) =>
        db
          .prepare(
            "INSERT INTO audit_log (id, workspace_id, actor_id, action, target_kind, target_id, data, created_at) VALUES (?, ?, 'service', 'channel.join', 'channel', ?, ?, '2026-01-01T00:00:00.000Z')",
          )
          .bind(`visible-${id}`, s.workspaceId, s.channelId, scoped),
      ),
    ]);
    const first = await entries(user.headers, s.workspaceId, "&kinds=channel.join&limit=1");
    expect(first.entries.map((entry) => entry.id)).toEqual(["visible-b"]);
    const second = await entries(
      user.headers,
      s.workspaceId,
      `&kinds=channel.join&limit=1&cursor=${first.cursor}`,
    );
    expect(second.entries.map((entry) => entry.id)).toEqual(["visible-a"]);
    expect(second.cursor).toBeNull();
  });

  it("preserves readable routine mutation history after deletion and deduplicates receipts", async () => {
    const s = await setup();
    const { user } = await memberOf(s.workspaceId, s.channelId);
    const { id: conversationId } = (await db
      .prepare(
        "SELECT id FROM conversations WHERE workspace_id = ? AND channel_id = ? AND kind = 'channel'",
      )
      .bind(s.workspaceId, s.channelId)
      .first<{ id: string }>())!;
    const created = await s.ok({
      type: "routine.create",
      botId: s.botId,
      name: "history",
      inputText: "not audit content",
      conversationId,
      schedule: { kind: "once", at: "2099-01-01T00:00:00.000Z" },
    });
    const command = envelope(s.workspaceId, {
      type: "routine.pause",
      routineId: created.routineId,
    });
    expect((await s.user.command(command)).status).toBe(200);
    expect((await s.user.command(command)).status).toBe(200);
    await s.ok({ type: "routine.delete", routineId: created.routineId });
    const history = await entries(
      user.headers,
      s.workspaceId,
      "&kinds=routine.create,routine.pause,routine.delete",
    );
    expect(history.entries.map((entry) => entry.kind)).toEqual([
      "routine.delete",
      "routine.pause",
      "routine.create",
    ]);
    expect(history.entries.every((entry) => (entry.target as Json).id === created.routineId)).toBe(
      true,
    );
    expect(JSON.stringify(history)).not.toContain("not audit content");
  });
});

describe("status", () => {
  it("reports a lagging outbox and an overdue enabled routine", async () => {
    const s = await setup();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    await db.batch([
      db
        .prepare(
          "INSERT INTO outbox (id, workspace_id, topic, payload, state, created_at, updated_at) VALUES (?, ?, 'search.index', '{}', 'pending', ?, ?)",
        )
        .bind(crypto.randomUUID(), s.workspaceId, stale, stale),
      db
        .prepare(
          `INSERT INTO outbox (id, workspace_id, topic, payload, state, attempt, lease_until, created_at, updated_at)
           VALUES (?, ?, 'event.route', '{}', 'sending', 1, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), s.workspaceId, stale, stale, stale),
      db
        .prepare(
          "INSERT INTO outbox (id, workspace_id, topic, payload, state, created_at, updated_at) VALUES (?, ?, 'event.route', '{}', 'dead', ?, ?)",
        )
        .bind(crypto.randomUUID(), s.workspaceId, stale, stale),
      db
        .prepare(
          `INSERT INTO routines (id, workspace_id, bot_id, name, input_text, schedule, misfire, next_fire_at)
           VALUES (?, ?, ?, 'stale', 'ignored', '{}', 'coalesce', ?)`,
        )
        .bind(crypto.randomUUID(), s.workspaceId, s.botId, stale),
    ]);
    const response = await s.user.get(`/v1/status?workspaceId=${s.workspaceId}`);
    expect(response.status).toBe(200);
    const status = await response.json<{
      outbox: { queued: number; failing: number; oldestAgeMs: number };
      search: { lagMs: number };
      routines: { overdue: number };
    }>();
    expect(status.outbox).toMatchObject({ queued: 2, failing: 2 });
    expect(status.outbox.oldestAgeMs).toBeGreaterThanOrEqual(10 * 60_000);
    expect(status.search.lagMs).toBeGreaterThanOrEqual(10 * 60_000);
    expect(status.routines.overdue).toBe(1);
  });

  it("shows readable member backlog and excludes another user's DM backlog", async () => {
    const s = await setup();
    const { user } = await memberOf(s.workspaceId, s.channelId);
    await s.user.command(s.send());
    const { conversationId } = await s.ok({ type: "dm.open", botId: s.botId });
    await s.ok({ type: "message.post", conversationId, text: "private backlog" });
    const stale = new Date(Date.now() - 60_000).toISOString();
    await db
      .prepare("UPDATE outbox SET created_at = ? WHERE workspace_id = ?")
      .bind(stale, s.workspaceId)
      .run();
    const status = await (
      await user.get(`/v1/status?workspaceId=${s.workspaceId}`)
    ).json<{
      outbox: { queued: number; oldestAgeMs: number };
      search: { lagMs: number };
    }>();
    expect(status.outbox.queued).toBe(2);
    expect(status.outbox.oldestAgeMs).toBeGreaterThanOrEqual(60_000);
    expect(status.search.lagMs).toBeGreaterThanOrEqual(60_000);
    const owner = await (
      await s.user.get(`/v1/status?workspaceId=${s.workspaceId}`)
    ).json<{ outbox: { queued: number } }>();
    expect(owner.outbox.queued).toBe(4);
  });
});
