// Search projection, Memory and run context injection (docs/architecture.md §13.5, §13.6, §14; AT-32, AT-33, AT-38,
// AT-39). G-06 on miniflare only.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { indexSource } from "../src/search.ts";
import { call, claim, count, envelope, executor, type Json, login, setup } from "./helpers.ts";

const db = env.DB;
type Hit = { sourceKind: string; sourceId: string; snippet: string; scope: string };
type Result = { hits: Hit[]; indexedThrough: string | null; cursor: string | null };

/** setup() plus: a user message in the channel, search / memory helpers and a claimed Run of a request. */
const world = async () => {
  const s = await setup();
  const say = async (text: string, delivery = "notify") => {
    const res = await s.user.command(
      envelope(s.workspaceId, {
        type: "agent.send",
        recipientBotId: s.botId,
        channelId: s.channelId,
        message: { kind: "request", text },
        delivery,
      }),
    );
    expect(res.status).toBe(200);
    return res.json<{ messageId: string; operationId: string }>();
  };
  const searchAs = async (
    user: { get: (path: string) => Promise<Response> },
    q: string,
    extra = "",
  ) => {
    const res = await user.get(
      `/v1/search?workspaceId=${s.workspaceId}&q=${encodeURIComponent(q)}${extra}`,
    );
    expect(res.status).toBe(200);
    return res.json<Result>();
  };
  const remember = (scopeKind: string, scopeId: string, content: string) =>
    s.ok({ type: "memory.write", scopeKind, scopeId, content });
  const device = executor(s.deviceToken, s.workspaceId);
  /** A wake request → its Job claimed; the Run's capability and context. */
  const runFor = async (text: string) => {
    const sent = await say(text, "wake");
    await s.pump();
    const op = await (await s.user.get(`/v1/operations/${sent.operationId}`)).json<Json>();
    const res = await device.command(claim(op.jobId as string));
    expect(res.status).toBe(200);
    const run = await res.json<{
      runId: string;
      executionGeneration: number;
      capability: { token: string };
    }>();
    const auth = { Authorization: `Bearer ${run.capability.token}` };
    return {
      ...run,
      messageId: sent.messageId,
      context: async () =>
        (
          await device.get(
            `/v1/executor/jobs/${op.jobId}/context?runId=${run.runId}&executionGeneration=${run.executionGeneration}`,
          )
        ).json<Json>(),
      get: (path: string) => call(path, auth),
      command: (command: Json) => call("/v1/run/commands", auth, envelope(s.workspaceId, command)),
    };
  };
  return {
    ...s,
    say,
    search: (q: string, extra?: string) => searchAs(s.user, q, extra),
    searchAs,
    remember,
    runFor,
  };
};

/** A second Workspace member (no member command yet) who is in no channel. */
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

describe("search", () => {
  it("finds a Japanese phrase through FTS, a 2-character query through the short path, with indexedThrough (AT-32)", async () => {
    const s = await world();
    const { messageId } = await s.say("レビューコメントを確認して");
    expect((await s.search("レビュー")).hits).toEqual([]);
    await s.pump();

    const fts = await s.search("レビュー");
    expect(fts.hits).toEqual([
      expect.objectContaining({
        sourceKind: "message",
        sourceId: messageId,
        scope: `channel:${s.channelId}`,
        sourceRevision: 1,
      }),
    ]);
    expect(fts.hits[0]!.snippet).toContain("[レビュー]");
    expect(fts.indexedThrough).not.toBeNull();

    const short = await s.search("確認");
    expect(short.hits.map((h) => h.sourceId)).toEqual([messageId]);
    expect(short.hits[0]!.snippet).toContain("[確認]");

    // User input is a phrase, never FTS syntax.
    expect((await s.search('レビュー" OR "x')).hits).toEqual([]);
    expect((await s.search("NEAR(a b)")).hits).toEqual([]);
  });

  it("indexes Tasks by key and title and follows edits; pages with a cursor", async () => {
    const s = await world();
    await s.ok({ type: "project.create", key: "APP", name: "app" });
    const { taskId } = await s.ok({
      type: "task.create",
      projectKey: "APP",
      title: "deploy staging",
      description: "after the review",
    });
    await s.ok({ type: "task.create", projectKey: "APP", title: "deploy production" });
    await s.pump();
    const page1 = await s.search("deploy", "&kinds=task&limit=1");
    expect(page1.hits).toHaveLength(1);
    expect(page1.cursor).toBe("1");
    const page2 = await s.search("deploy", `&kinds=task&limit=1&cursor=${page1.cursor}`);
    expect(page2.hits).toHaveLength(1);
    expect(page2.hits[0]!.sourceId).not.toBe(page1.hits[0]!.sourceId);
    expect((await s.search("AP", "&kinds=task")).hits).toHaveLength(2);

    await s.ok({ type: "task.cancel", taskId, expectedRevision: 1 });
    await s.pump();
    // A cancelled Task stays indexed, at its new revision.
    const hit = (await s.search("staging")).hits.find((h) => h.sourceId === taskId);
    expect(hit).toMatchObject({ sourceKind: "task", sourceRevision: 2 });
  });

  it("never shows channel-scoped hits to a member outside the channel", async () => {
    const s = await world();
    await s.say("secret rollout plan");
    await s.remember("channel", s.channelId, "secret channel memory");
    await s.remember("workspace", s.workspaceId, "secret workspace memory");
    await s.pump();
    expect((await s.search("secret")).hits).toHaveLength(3);
    expect((await s.search("se")).hits).toHaveLength(3);

    const other = await outsider(s.workspaceId);
    const seen = await s.searchAs(other, "secret");
    expect(seen.hits.map((h) => h.scope)).toEqual([`workspace:${s.workspaceId}`]);
    expect((await s.searchAs(other, "se")).hits).toHaveLength(1);
    expect(seen.indexedThrough).not.toBeNull();
    // Another Workspace's member cannot search this one at all.
    expect(
      (await (await login()).get(`/v1/search?workspaceId=${s.workspaceId}&q=secret`)).status,
    ).toBe(403);
  });

  it("never lets an older index read overwrite a newer one, and never resurrects a deleted memory (AT-39)", async () => {
    const s = await world();
    const { memoryId } = await s.remember("bot", s.botId, "deploy window is friday");
    await s.pump();
    expect((await s.search("friday")).hits).toHaveLength(1);

    // A newer revision already indexed: re-indexing the current (older) source is a no-op.
    await db
      .prepare(
        "UPDATE search_documents SET source_revision = 5, body = 'newer' WHERE source_id = ?",
      )
      .bind(memoryId)
      .run();
    await indexSource(db, { sourceKind: "memory", sourceId: memoryId as string });
    expect((await s.search("newer")).hits).toHaveLength(1);
    await db
      .prepare(
        "UPDATE search_documents SET source_revision = 1, body = 'deploy window is friday' WHERE source_id = ?",
      )
      .bind(memoryId)
      .run();

    const stale = await s.user.command(
      envelope(s.workspaceId, { type: "memory.delete", memoryId, expectedRevision: 2 }),
    );
    expect(stale.status).toBe(409);
    await s.ok({ type: "memory.delete", memoryId, expectedRevision: 1 });
    await s.pump();
    expect((await s.search("friday")).hits).toEqual([]);

    // A late duplicate index row after the delete only rewrites the tombstone.
    await db
      .prepare(
        "INSERT INTO outbox (id, workspace_id, topic, payload) VALUES (?, ?, 'search.index', ?)",
      )
      .bind(
        crypto.randomUUID(),
        s.workspaceId,
        JSON.stringify({ sourceKind: "memory", sourceId: memoryId }),
      )
      .run();
    await s.pump();
    expect((await s.search("friday")).hits).toEqual([]);
    const doc = await db
      .prepare("SELECT body, deleted_at, source_revision FROM search_documents WHERE source_id = ?")
      .bind(memoryId)
      .first<{ body: string; deleted_at: string | null; source_revision: number }>();
    expect(doc).toMatchObject({ body: "", source_revision: 2 });
    expect(doc!.deleted_at).not.toBeNull();
  });

  it("rebuilds one Workspace from its sources without touching or mixing others (AT-38)", async () => {
    const a = await world();
    const b = await world();
    await a.say("rebuild me alpha");
    await a.remember("bot", a.botId, "rebuild memory alpha");
    await b.say("rebuild me beta");
    await a.pump();
    await b.pump();
    const before = (await a.search("rebuild")).hits;
    expect(before).toHaveLength(2);

    const other = await outsider(a.workspaceId);
    const path = `/v1/admin/search/rebuild?workspaceId=${a.workspaceId}`;
    expect((await call(path, other.headers, {})).status).toBe(403);
    const rebuilt = await call(path, a.user.headers, {});
    expect(rebuilt.status).toBe(200);
    expect(await rebuilt.json()).toEqual({ status: "accepted" });
    expect(
      await count(
        "outbox WHERE workspace_id = ? AND topic = 'search.index' AND state = 'pending'",
        a.workspaceId,
      ),
    ).toBe(2);
    expect((await a.search("rebuild")).hits).toEqual([]);
    expect((await b.search("rebuild")).hits).toHaveLength(1);

    await a.pump();
    const after = (await a.search("rebuild")).hits;
    expect(after.map((h) => h.sourceId).toSorted()).toEqual(
      before.map((h) => h.sourceId).toSorted(),
    );
    expect(after.every((h) => !h.snippet.includes("beta"))).toBe(true);
  });
});

describe("memory", () => {
  it("checks the user's scope, supersedes within one scope and lists live memories", async () => {
    const s = await world();
    const other = await outsider(s.workspaceId);
    const denied = await other.command(
      envelope(s.workspaceId, {
        type: "memory.write",
        scopeKind: "channel",
        scopeId: s.channelId,
        content: "x",
      }),
    );
    expect(denied.status).toBe(403);
    const missing = await s.user.command(
      envelope(s.workspaceId, {
        type: "memory.write",
        scopeKind: "bot",
        scopeId: "nope",
        content: "x",
      }),
    );
    expect(missing.status).toBe(404);
    const tooBig = await s.user.command(
      envelope(s.workspaceId, {
        type: "memory.write",
        scopeKind: "bot",
        scopeId: s.botId,
        content: "あ".repeat(6000),
      }),
    );
    expect(tooBig.status).toBe(422);

    const { memoryId: first } = await s.remember("channel", s.channelId, "standup at 10");
    const { memoryId: second } = await s.ok({
      type: "memory.write",
      scopeKind: "channel",
      scopeId: s.channelId,
      content: "standup at 11",
      supersedesId: first,
    });
    const list = await (
      await s.user.get(
        `/v1/memories?workspaceId=${s.workspaceId}&scopeKind=channel&scopeId=${s.channelId}`,
      )
    ).json<{ memories: Json[] }>();
    expect(list.memories).toEqual([
      expect.objectContaining({
        id: second,
        content: "standup at 11",
        supersedesId: first,
        revision: 1,
      }),
    ]);
    const history = await db
      .prepare(
        "SELECT revision, deleted_at FROM memory_revisions WHERE memory_id = ? ORDER BY revision",
      )
      .bind(first)
      .all<{ revision: number; deleted_at: string | null }>();
    expect(history.results.map((r) => [r.revision, r.deleted_at !== null])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(
      (
        await other.get(
          `/v1/memories?workspaceId=${s.workspaceId}&scopeKind=channel&scopeId=${s.channelId}`,
        )
      ).status,
    ).toBe(403);
  });

  it("lets a Run write only to its own bot, task or channel (AT-33) and search only what it may read", async () => {
    const s = await world();
    const { botId: otherBot } = await s.ok({ type: "bot.create", name: "other" });
    const { channelId: privateChannel } = await s.ok({ type: "channel.create", name: "private" });
    await s.ok({
      type: "channel.member.add",
      channelId: privateChannel as string,
      botId: s.botId,
      role: "member",
    });
    await s.ok({
      type: "agent.send",
      recipientBotId: s.botId,
      channelId: privateChannel as string,
      message: { kind: "notification", text: "hidden pancake recipe" },
      delivery: "notify",
    });
    await s.remember("bot", otherBot as string, "other bot pancake memory");
    const run = await s.runFor("hello");

    const write = (scopeKind: string, scopeId: string) =>
      run.command({
        type: "memory.write",
        scopeKind,
        scopeId,
        content: `pancake note for ${scopeKind}`,
      });
    const promoted = await write("workspace", s.workspaceId);
    expect(promoted.status).toBe(403);
    expect(await promoted.json()).toMatchObject({
      code: "FORBIDDEN",
      reason: "scope_not_permitted",
    });
    expect((await write("bot", otherBot as string)).status).toBe(403);
    expect((await write("channel", privateChannel as string)).status).toBe(403);
    expect((await write("task", "any")).status).toBe(403);
    expect((await write("bot", s.botId)).status).toBe(200);
    expect((await write("channel", s.channelId)).status).toBe(200);
    await s.pump();

    const found = await (await run.get("/v1/run/search?q=pancake")).json<Result>();
    expect(found.hits.map((h) => h.scope).toSorted()).toEqual(
      [`bot:${s.botId}`, `channel:${s.channelId}`].toSorted(),
    );
    // The user sees every Bot's memories, but the private channel's message only as its member.
    expect((await s.search("pancake")).hits).toHaveLength(4);
  });

  it("puts the Bot's, Task's and Channel's memories and related hits in the run context", async () => {
    const s = await world();
    const { botId: otherBot } = await s.ok({ type: "bot.create", name: "other" });
    await s.remember("bot", s.botId, "staging host is stage-3");
    await s.remember("channel", s.channelId, "deploys need a review");
    await s.remember("bot", otherBot as string, "not for this bot");
    const { messageId: earlier } = await s.say("yesterday the staging deploy failed");
    const run = await s.runFor("please deploy staging again");
    await s.pump();
    const context = await run.context();

    expect((context.memories as Json[]).map((m) => m.content)).toEqual([
      "deploys need a review",
      "staging host is stage-3",
    ]);
    const related = context.related as { sourceKind: string; sourceId: string }[];
    expect(related.map((r) => r.sourceId)).toContain(earlier);
    expect(related.map((r) => r.sourceId)).not.toContain(run.messageId);
    expect(related.length).toBeLessThanOrEqual(5);
  });
});
