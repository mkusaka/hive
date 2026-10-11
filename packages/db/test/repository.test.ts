import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  acquireOutboxBatch,
  appendMessage,
  claimJob,
  createInboxItem,
  enqueueOutbox,
  finishRun,
  IdempotencyConflict,
  markOutboxSent,
  renewLease,
  withOperationReceipt,
} from "../src/index.ts";

const db = env.DB;
const id = () => crypto.randomUUID();

// Fresh rows per test so tests do not depend on storage isolation.
const seed = async () => {
  const ws = id();
  const user = id();
  const device = id();
  const botActor = id();
  const bot = id();
  const job = id();
  const channel = id();
  const conversation = id();
  await db.batch([
    db.prepare("INSERT INTO workspaces (id, name) VALUES (?, 'ws')").bind(ws),
    db
      .prepare("INSERT INTO users (id, access_issuer, access_subject) VALUES (?, 'issuer', ?)")
      .bind(user, user),
    db
      .prepare(
        "INSERT INTO actors (id, workspace_id, kind, user_id, display_name) VALUES (?, ?, 'user', ?, 'me')",
      )
      .bind(user, ws, user),
    db
      .prepare(
        "INSERT INTO devices (id, workspace_id, owner_user_id, name, os, agent_version) VALUES (?, ?, ?, 'pc1', 'darwin', '0.0.0')",
      )
      .bind(device, ws, user),
    db
      .prepare(
        "INSERT INTO actors (id, workspace_id, kind, display_name) VALUES (?, ?, 'bot', 'bot')",
      )
      .bind(botActor, ws),
    db
      .prepare(
        "INSERT INTO bots (id, workspace_id, actor_id, name, placement_policy) VALUES (?, ?, ?, 'bot', '{}')",
      )
      .bind(bot, ws, botActor),
    db
      .prepare(
        "INSERT INTO jobs (id, workspace_id, bot_id, trigger_key, placement) VALUES (?, ?, ?, ?, '{}')",
      )
      .bind(job, ws, bot, job),
    db
      .prepare("INSERT INTO channels (id, workspace_id, name) VALUES (?, ?, 'general')")
      .bind(channel, ws),
    db
      .prepare("INSERT INTO conversations (id, workspace_id, channel_id) VALUES (?, ?, ?)")
      .bind(conversation, ws, channel),
  ]);
  return { ws, user, device, bot, job, conversation };
};

const claimInput = (s: Awaited<ReturnType<typeof seed>>, overrides = {}) => ({
  workspaceId: s.ws,
  jobId: s.job,
  deviceId: s.device,
  expectedRevision: 1,
  leaseSeconds: 90,
  resourceKeys: [`repo:${s.ws}`],
  operationId: id(),
  ...overrides,
});

const count = async (sql: string, ...params: unknown[]) =>
  (await db
    .prepare(`SELECT COUNT(*) AS n FROM ${sql}`)
    .bind(...params)
    .first<{ n: number }>())!.n;

const job = (jobId: string) =>
  db
    .prepare("SELECT state, revision FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ state: string; revision: number }>();

describe("claimJob", () => {
  it("stores Run, Execution, reservation and receipt together", async () => {
    const s = await seed();
    const input = claimInput(s);
    const result = await claimJob(db, input);
    expect(result).toMatchObject({ ok: true, generation: 1 });
    if (!result.ok) throw new Error("claim failed");

    expect(await job(s.job)).toEqual({ state: "active", revision: 2 });
    const run = await db.prepare("SELECT * FROM runs WHERE id = ?").bind(result.runId).first();
    expect(run).toMatchObject({
      kind: "root",
      state: "starting",
      execution_generation: 1,
      device_id: s.device,
    });
    expect(
      await count("executions WHERE id = ? AND run_id = ?", result.executionId, result.runId),
    ).toBe(1);
    expect(
      await count("resource_reservations WHERE run_id = ? AND released_at IS NULL", result.runId),
    ).toBe(1);
    expect(await count("operation_receipts WHERE idempotency_key = ?", input.operationId)).toBe(1);
    expect(await count("atomic_guards")).toBe(0);
  });

  it("rejects a stale revision without creating a Run", async () => {
    const s = await seed();
    const result = await claimJob(db, claimInput(s, { expectedRevision: 7 }));
    expect(result).toEqual({ ok: false, reason: "stale_revision" });
    expect(await count("runs WHERE job_id = ?", s.job)).toBe(0);
    expect(await count("resource_reservations WHERE workspace_id = ?", s.ws)).toBe(0);
    expect(await count("operation_receipts WHERE workspace_id = ?", s.ws)).toBe(0);
    expect(await job(s.job)).toEqual({ state: "queued", revision: 1 });
  });

  it("rejects a second claim on the same Job", async () => {
    const s = await seed();
    expect((await claimJob(db, claimInput(s))).ok).toBe(true);
    const second = await claimJob(db, claimInput(s, { resourceKeys: [] }));
    expect(second).toEqual({ ok: false, reason: "already_claimed", jobState: "active" });
    expect(await count("runs WHERE job_id = ?", s.job)).toBe(1);
  });

  it("rolls back Job and Run on a resource conflict", async () => {
    const s = await seed();
    const holder = await claimJob(db, claimInput(s, { resourceKeys: ["repo:shared"] }));
    expect(holder.ok).toBe(true);

    const other = id();
    await db
      .prepare(
        "INSERT INTO jobs (id, workspace_id, bot_id, trigger_key, placement) VALUES (?, ?, ?, ?, '{}')",
      )
      .bind(other, s.ws, s.bot, other)
      .run();
    const result = await claimJob(
      db,
      claimInput(s, { jobId: other, resourceKeys: ["repo:shared"] }),
    );
    expect(result).toEqual({ ok: false, reason: "resource_busy" });
    expect(await job(other)).toEqual({ state: "queued", revision: 1 });
    expect(await count("runs WHERE job_id = ?", other)).toBe(0);
    expect(await count("executions WHERE workspace_id = ?", s.ws)).toBe(1);
  });

  it("replays the stored response for the same operation and rejects a different digest", async () => {
    const s = await seed();
    const input = claimInput(s);
    const first = await claimJob(db, input);
    const replay = await claimJob(db, input);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await count("runs WHERE job_id = ?", s.job)).toBe(1);
    await expect(claimJob(db, { ...input, leaseSeconds: 30 })).rejects.toBeInstanceOf(
      IdempotencyConflict,
    );
  });
});

describe("lease fencing", () => {
  it("rejects renew and finish from a stale generation, then finishes the current one", async () => {
    const s = await seed();
    const claim = await claimJob(db, claimInput(s));
    if (!claim.ok) throw new Error("claim failed");
    const fence = { runId: claim.runId, deviceId: s.device, executionGeneration: claim.generation };

    expect(await renewLease(db, { ...fence, executionGeneration: 0, leaseSeconds: 90 })).toEqual({
      ok: false,
      reason: "stale_generation",
    });
    expect(await renewLease(db, { ...fence, deviceId: id(), leaseSeconds: 90 })).toMatchObject({
      ok: false,
    });
    expect(await renewLease(db, { ...fence, leaseSeconds: 90 })).toMatchObject({ ok: true });

    const stale = await finishRun(db, {
      ...fence,
      executionGeneration: 0,
      state: "failed",
      operationId: id(),
    });
    expect(stale).toEqual({ ok: false, reason: "stale_generation" });
    expect(await job(s.job)).toEqual({ state: "active", revision: 2 });

    const finish = { ...fence, state: "succeeded" as const, operationId: id() };
    expect(await finishRun(db, finish)).toEqual({ ok: true });
    // Replay of the same operation returns the stored result, not stale_generation.
    expect(await finishRun(db, finish)).toEqual({ ok: true });
    expect(await job(s.job)).toEqual({ state: "succeeded", revision: 3 });
    expect(await count("runs WHERE id = ? AND state = 'succeeded'", claim.runId)).toBe(1);
    expect(await count("executions WHERE run_id = ? AND state = 'finished'", claim.runId)).toBe(1);
    expect(
      await count("resource_reservations WHERE run_id = ? AND released_at IS NULL", claim.runId),
    ).toBe(0);
    expect(await count("outbox WHERE workspace_id = ? AND topic = 'run.finished'", s.ws)).toBe(1);

    // Terminal: the same fence can no longer act.
    expect(await renewLease(db, { ...fence, leaseSeconds: 90 })).toMatchObject({ ok: false });
    expect(await finishRun(db, { ...fence, state: "failed", operationId: id() })).toMatchObject({
      ok: false,
    });
  });
});

describe("withOperationReceipt", () => {
  it("replays the same digest and rejects a different digest", async () => {
    const s = await seed();
    const key = { workspaceId: s.ws, actorId: s.user, idempotencyKey: id(), requestDigest: "a" };
    const build = () => ({
      statements: [enqueueOutbox(db, { workspaceId: s.ws, topic: "test", payload: { n: 1 } })],
      status: 202,
      response: { accepted: true },
    });
    expect(await withOperationReceipt(db, key, build)).toEqual({
      replayed: false,
      status: 202,
      response: { accepted: true },
    });
    expect(await withOperationReceipt(db, key, build)).toEqual({
      replayed: true,
      status: 202,
      response: { accepted: true },
    });
    expect(await count("outbox WHERE workspace_id = ? AND topic = 'test'", s.ws)).toBe(1);
    await expect(
      withOperationReceipt(db, { ...key, requestDigest: "b" }, build),
    ).rejects.toBeInstanceOf(IdempotencyConflict);
  });
});

describe("constraints", () => {
  it("rejects a cross-workspace foreign key", async () => {
    const a = await seed();
    const b = await seed();
    // Job in workspace B pointing at a Bot of workspace A.
    await expect(
      db
        .prepare(
          "INSERT INTO jobs (id, workspace_id, bot_id, trigger_key, placement) VALUES (?, ?, ?, 'x', '{}')",
        )
        .bind(id(), b.ws, a.bot)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});

describe("messages and inbox", () => {
  it("appends messages with increasing seq and dedupes client_message_id", async () => {
    const s = await seed();
    const base = { workspaceId: s.ws, conversationId: s.conversation, actorId: s.user };
    const one = await appendMessage(db, { ...base, clientMessageId: "c1", body: "hi" });
    const two = await appendMessage(db, { ...base, clientMessageId: "c2", body: "again" });
    const dup = await appendMessage(db, { ...base, clientMessageId: "c1", body: "hi" });
    expect([one.message.seq, two.message.seq]).toEqual([1, 2]);
    expect(dup).toEqual({ created: false, message: one.message });
  });

  it("returns the existing inbox item on duplicate delivery", async () => {
    const s = await seed();
    const input = {
      workspaceId: s.ws,
      inputId: id(),
      botId: s.bot,
      lane: "interactive",
      purpose: "reply",
    };
    const first = await createInboxItem(db, input);
    const second = await createInboxItem(db, input);
    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, item: first.item });
    const otherLane = await createInboxItem(db, { ...input, lane: "background:task-1" });
    expect(otherLane.created).toBe(true);
  });
});

describe("outbox", () => {
  it("hands each row to exactly one concurrent owner", async () => {
    const s = await seed();
    await db.batch(
      Array.from({ length: 10 }, (_, n) =>
        enqueueOutbox(db, { workspaceId: s.ws, topic: "race", payload: { n } }),
      ),
    );
    const [a, b] = await Promise.all([
      acquireOutboxBatch(db, { owner: "a", limit: 100, leaseSeconds: 60 }),
      acquireOutboxBatch(db, { owner: "b", limit: 100, leaseSeconds: 60 }),
    ]);
    const mine = [...a, ...b].filter((row) => row.workspaceId === s.ws);
    expect(mine).toHaveLength(10);
    expect(new Set(mine.map((row) => row.id)).size).toBe(10);
    const late = await acquireOutboxBatch(db, { owner: "c", limit: 100, leaseSeconds: 60 });
    expect(late.filter((row) => row.workspaceId === s.ws)).toEqual([]);

    const row = mine[0]!;
    const other = row.leaseOwner === "a" ? "b" : "a";
    expect(await markOutboxSent(db, { id: row.id, owner: other })).toBe(false);
    expect(await markOutboxSent(db, { id: row.id, owner: row.leaseOwner! })).toBe(true);
  });
});
