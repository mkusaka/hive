import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { visibleScopes } from "../src/realtime.ts";
import { call, envelope, type Json, login, setup, withWorkspace } from "./helpers.ts";

const db = env.DB;

type Change = { seq: number; entityKind: string; entityId: string; scope: string };
type Page = { changes: Change[]; cursor: string; hasMore: boolean };

const changeRows = async (workspaceId: string, afterSeq = 0) =>
  (
    await db
      .prepare(
        `SELECT seq, entity_kind AS kind, entity_id AS id, op, revision, scope
           FROM change_log WHERE workspace_id = ? AND seq > ? ORDER BY seq`,
      )
      .bind(workspaceId, afterSeq)
      .all<{
        seq: number;
        kind: string;
        id: string;
        op: string;
        revision: number | null;
        scope: string;
      }>()
  ).results;
const changesPath = (workspaceId: string, cursor?: string, limit?: number) =>
  `/v1/sync/changes?workspaceId=${workspaceId}` +
  (cursor ? `&cursor=${cursor}` : "") +
  (limit ? `&limit=${limit}` : "");
const summary = (rows: { kind: string; id: string; scope: string }[]) =>
  rows.map(({ kind, id, scope }) => [kind, id, scope]);

const executor = (token: string, workspaceId: string) => (command: unknown) =>
  call(
    "/v1/executor/commands",
    { Authorization: `Bearer ${token}` },
    envelope(workspaceId, command),
  );

/** agent.send + pump: the Job id and inbox item id. */
const queuedJob = async (s: Awaited<ReturnType<typeof setup>>) => {
  const request = s.send();
  const sent = await (
    await s.user.command(request)
  ).json<{ inboxItemId: string; messageId: string }>();
  await s.pump();
  const op = await (await s.user.get(`/v1/operations/${request.operationId}`)).json<Json>();
  return { ...sent, jobId: op.jobId as string };
};

/** A second Workspace member (there is no member command yet) who is in no channel. */
const outsider = async (workspaceId: string) => {
  const user = await login();
  const { userId } = await (await user.me()).json<{ userId: string }>();
  await db.batch([
    db
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')",
      )
      .bind(workspaceId, userId),
    db
      .prepare(
        "INSERT INTO actors (id, workspace_id, kind, user_id, display_name) VALUES (?, ?, 'user', ?, 'o')",
      )
      .bind(crypto.randomUUID(), workspaceId, userId),
  ]);
  return user;
};

describe("change_log", () => {
  it("each mutating command appends its change rows with the entity's scope", async () => {
    const s = await setup();
    const ws = `workspace:${s.workspaceId}`;
    const ch = `channel:${s.channelId}`;
    const created = await changeRows(s.workspaceId);
    expect(summary(created)).toEqual([
      ["workspace", s.workspaceId, ws],
      ["device", s.deviceId, ws],
      ["channel", s.channelId, ch],
      ["conversation", expect.any(String), ch],
      ["bot", s.botId, ws],
    ]);

    let seq = created.at(-1)!.seq;
    const next = async () => {
      const rows = await changeRows(s.workspaceId, seq);
      seq = rows.at(-1)?.seq ?? seq;
      return rows;
    };

    const request = s.send();
    const { messageId, inboxItemId } = await (await s.user.command(request)).json<Json>();
    expect(summary(await next())).toEqual([
      ["message", messageId, ch],
      ["inbox_item", inboxItemId, ch],
    ]);

    await s.pump();
    const routed = await next();
    const jobId = routed[1]?.id;
    expect(summary(routed)).toEqual([
      ["inbox_item", inboxItemId, ch],
      ["job", expect.any(String), ws],
    ]);
    expect(routed[1]).toMatchObject({ op: "upsert", revision: 1 });

    const device = executor(s.deviceToken, s.workspaceId);
    const claimRes = await device({ type: "job.claim", jobId, expectedRevision: 1 });
    const { runId, executionGeneration } = await claimRes.json<Json>();
    const claimed = await next();
    expect(summary(claimed)).toEqual([
      ["job", jobId, ws],
      ["run", runId, ws],
    ]);
    expect(claimed[0]).toMatchObject({ revision: 2 });

    // A failed claim rolls back with its batch: no change rows.
    expect((await device({ type: "job.claim", jobId, expectedRevision: 1 })).status).toBe(409);
    // Lease renewal is heartbeat-class and is not logged.
    expect((await device({ type: "run.lease.renew", runId, executionGeneration })).status).toBe(
      200,
    );
    expect(await next()).toEqual([]);

    const result = { type: "run.result.submit", runId, executionGeneration, state: "succeeded" };
    expect((await device({ ...result, summary: "done" })).status).toBe(200);
    expect(summary(await next())).toEqual([
      ["run", runId, ws],
      ["job", jobId, ws],
      ["inbox_item", inboxItemId, ch],
    ]);

    const revoke = await s.user.command(
      envelope(s.workspaceId, { type: "device.revoke", deviceId: s.deviceId }),
    );
    expect(revoke.status).toBe(200);
    expect(summary(await next())).toEqual([["device", s.deviceId, ws]]);

    // A command whose batch fails (duplicate name) leaves no change row; a replay adds none.
    const dup = await s.user.command(
      envelope(s.workspaceId, { type: "channel.create", name: "dev" }),
    );
    expect(dup.status).toBe(422);
    expect((await s.user.command(request)).status).toBe(200);
    expect(await next()).toEqual([]);
  });
});

describe("GET /v1/sync/changes", () => {
  it("bootstraps a cursor, then pages permitted changes; filtered rows still advance the cursor", async () => {
    const s = await setup();
    const other = await outsider(s.workspaceId);
    const path = (cursor?: string, limit?: number) => changesPath(s.workspaceId, cursor, limit);

    const boot = await (await s.user.get(path())).json<Page>();
    expect(boot).toMatchObject({ changes: [], hasMore: false });
    const otherBoot = await (await other.get(path())).json<Page>();
    expect(otherBoot.cursor).toBe(boot.cursor);

    const { messageId, inboxItemId } = await (await s.user.command(s.send())).json<Json>();
    const page = await (await s.user.get(path(boot.cursor))).json<Page>();
    expect(page.changes.map((c) => [c.entityKind, c.entityId])).toEqual([
      ["message", messageId],
      ["inbox_item", inboxItemId],
    ]);
    expect(page.changes[0]).toMatchObject({
      op: "upsert",
      scope: `channel:${s.channelId}`,
      revision: null,
      createdAt: expect.any(String),
    });
    expect(page.hasMore).toBe(false);

    // Not in the channel: nothing visible, but the cursor moves past the scanned rows.
    const hidden = await (await other.get(path(otherBoot.cursor))).json<Page>();
    expect(hidden).toEqual({ changes: [], cursor: page.cursor, hasMore: false });
    expect(await (await other.get(path(hidden.cursor))).json()).toEqual(hidden);

    // Workspace-scoped rows are visible to every member.
    await s.pump();
    const routed = await (await other.get(path(hidden.cursor))).json<Page>();
    expect(routed.changes.map((c) => c.entityKind)).toEqual(["job"]);

    const first = await (await s.user.get(path(page.cursor, 1))).json<Page>();
    expect(first.changes.map((c) => c.entityKind)).toEqual(["inbox_item"]);
    expect(first.hasMore).toBe(true);
    const second = await (await s.user.get(path(first.cursor, 1))).json<Page>();
    expect(second.changes.map((c) => c.entityKind)).toEqual(["job"]);
    expect(second.hasMore).toBe(false);
  });

  it("returns 410 CURSOR_EXPIRED for a bad, foreign-workspace or old-epoch cursor", async () => {
    const s = await setup();
    const { cursor } = await (
      await s.user.get(`/v1/sync/changes?workspaceId=${s.workspaceId}`)
    ).json<Page>();
    expect((await s.user.get(changesPath(s.workspaceId, cursor))).status).toBe(200);

    const b = await withWorkspace();
    const foreign = await (
      await b.user.get(`/v1/sync/changes?workspaceId=${b.workspaceId}`)
    ).json<Page>();
    const bad = await Promise.all(
      ["not-a-cursor", foreign.cursor].map((c) => s.user.get(changesPath(s.workspaceId, c))),
    );
    expect(bad.map((res) => res.status)).toEqual([410, 410]);
    expect(await bad[0]!.json()).toMatchObject({ code: "CURSOR_EXPIRED" });

    await db
      .prepare("UPDATE workspaces SET auth_epoch = auth_epoch + 1 WHERE id = ?")
      .bind(s.workspaceId)
      .run();
    expect((await s.user.get(changesPath(s.workspaceId, cursor))).status).toBe(410);

    // Not a member of the other Workspace.
    expect((await s.user.get(changesPath(b.workspaceId, foreign.cursor))).status).toBe(403);
  });
});

describe("bootstrap lists", () => {
  it("lists member channels, bots, devices, jobs and newest-first messages", async () => {
    const s = await setup();
    const q = `workspaceId=${s.workspaceId}`;
    const get = async (path: string) => (await s.user.get(path)).json<Json>();
    expect(await get(`/v1/channels?${q}`)).toEqual({
      channels: [expect.objectContaining({ id: s.channelId, lastMessage: null })],
    });
    const first = await (await s.user.command(s.send())).json<Json>();
    const { messageId, jobId } = await queuedJob(s);
    const { userId } = await (await s.user.me()).json<{ userId: string }>();

    const { channels } = await get(`/v1/channels?${q}`);
    expect(channels).toEqual([
      expect.objectContaining({
        id: s.channelId,
        name: "dev",
        role: "owner",
        lastMessage: {
          body: "check PR #123",
          createdAt: expect.any(String),
          actorId: expect.any(String),
        },
      }),
    ]);
    expect(await get(`/v1/bots?${q}`)).toEqual({
      bots: [
        expect.objectContaining({
          id: s.botId,
          actorId: expect.any(String),
          instructions: expect.any(String),
          placementPolicy: expect.objectContaining({ mode: "any" }),
        }),
      ],
    });
    expect(await get(`/v1/devices?${q}`)).toEqual({
      devices: [expect.objectContaining({ id: s.deviceId, revokedAt: null })],
    });
    const { jobs } = await get(`/v1/jobs?${q}&limit=1`);
    expect(jobs).toEqual([expect.objectContaining({ id: jobId, state: "queued" })]);
    const { messages } = await get(`/v1/channels/${s.channelId}/messages?${q}`);
    expect((messages as Json[]).map((m) => m.id)).toEqual([messageId, first.messageId]);
    // The latest message is the user's own: its actor resolves to the caller's user id.
    expect(messages).toEqual([
      expect.objectContaining({
        userId,
        actorId: ((channels as Json[])[0]!.lastMessage as Json).actorId,
      }),
      expect.objectContaining({ userId }),
    ]);

    const other = await outsider(s.workspaceId);
    expect(await (await other.get(`/v1/channels?${q}`)).json()).toEqual({ channels: [] });
    expect((await other.get(`/v1/channels/${s.channelId}/messages?${q}`)).status).toBe(404);
    expect((await (await login()).get(`/v1/bots?${q}`)).status).toBe(403);
    expect((await s.user.get(`/v1/jobs?${q}&limit=0`)).status).toBe(422);
  });
});

/** Opens `/v1/realtime` and collects JSON messages. */
const connect = async (headers: Record<string, string>, workspaceId: string) => {
  const res = await call(`/v1/realtime?workspaceId=${workspaceId}`, {
    ...headers,
    Upgrade: "websocket",
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const received: Json[] = [];
  ws.addEventListener("message", (e) => received.push(JSON.parse(e.data as string) as Json));
  return { ws, received };
};
/** Waits until `ready()` (bounded); hints arrive asynchronously on the client side. */
const until = async (ready: () => boolean) => {
  // oxlint-disable-next-line no-await-in-loop -- polling is sequential by nature
  for (let i = 0; i < 100 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
};

describe("realtime", () => {
  it("takes X-Hive-Token as a device and a Bearer next to an Access assertion as the user", async () => {
    const s = await setup();
    const device = await connect({ "X-Hive-Token": s.deviceToken }, s.workspaceId);
    // Behind Access with Managed OAuth, the user's OAuth Bearer reaches the Worker with the assertion.
    const user = await connect(
      { ...s.user.headers, Authorization: "Bearer opaque-oauth-token" },
      s.workspaceId,
    );
    device.ws.close();
    user.ws.close();
  });

  it("fans sync.changed out only to sockets whose scopes intersect", async () => {
    const s = await setup();
    const other = await outsider(s.workspaceId);
    const member = await connect(s.user.headers, s.workspaceId);
    const stranger = await connect(other.headers, s.workspaceId);
    const device = await connect({ Authorization: `Bearer ${s.deviceToken}` }, s.workspaceId);

    await s.user.command(s.send());
    await until(() => member.received.length === 1);
    expect(member.received).toEqual([
      {
        type: "sync.changed",
        workspaceId: s.workspaceId,
        cursor: expect.any(String),
        scopes: [`channel:${s.channelId}`],
      },
    ]);
    expect(stranger.received).toEqual([]);
    expect(device.received).toEqual([]);

    // Routing creates a queued Job: workspace-scoped change plus job.available for executors.
    await s.pump();
    await until(
      () =>
        member.received.length === 2 &&
        stranger.received.length === 1 &&
        device.received.length === 2,
    );
    const workspaceChange = {
      type: "sync.changed",
      workspaceId: s.workspaceId,
      cursor: expect.any(String),
      scopes: [`workspace:${s.workspaceId}`],
    };
    expect(stranger.received).toEqual([workspaceChange]);
    expect(device.received).toEqual([
      workspaceChange,
      { type: "job.available", workspaceId: s.workspaceId },
    ]);
    expect(member.received.at(-1)).toMatchObject({
      scopes: [`channel:${s.channelId}`, `workspace:${s.workspaceId}`],
    });

    // The hint's cursor is usable for sync.
    const page = await s.user.get(
      `/v1/sync/changes?workspaceId=${s.workspaceId}&cursor=${member.received[0]!.cursor as string}`,
    );
    expect((await page.json<Page>()).changes.map((c) => c.entityKind)).toEqual([
      "inbox_item",
      "job",
    ]);
    for (const { ws } of [member, stranger, device]) ws.close();
  });

  it("rejects a non-upgrade request, a non-member and a DO request without the Worker's principal", async () => {
    const s = await setup();
    expect((await s.user.get(`/v1/realtime?workspaceId=${s.workspaceId}`)).status).toBe(422);
    const stranger = await login();
    const res = await call(`/v1/realtime?workspaceId=${s.workspaceId}`, {
      ...stranger.headers,
      Upgrade: "websocket",
    });
    expect(res.status).toBe(403);

    const stub = env.REALTIME.get(env.REALTIME.idFromName(s.workspaceId));
    const direct = await stub.fetch("https://realtime/connect", {
      headers: { Upgrade: "websocket" },
    });
    expect(direct.status).toBe(403);
  });

  it("visibleScopes intersects the socket's scopes with the changed ones", () => {
    expect(visibleScopes(["workspace:w", "channel:a"], ["channel:a", "channel:b"])).toEqual([
      "channel:a",
    ]);
    expect(visibleScopes(["workspace:w"], ["channel:a"])).toEqual([]);
  });
});
