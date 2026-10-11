import { env } from "cloudflare:test";
import { enqueueOutbox, insertEvent } from "@hive/db";
import { describe, expect, it } from "vitest";
import { call, envelope, type Json, setup } from "./helpers.ts";

const db = env.DB;
const count = async (from: string, ...params: unknown[]) =>
  (await db
    .prepare(`SELECT COUNT(*) AS n FROM ${from}`)
    .bind(...params)
    .first<{ n: number }>())!.n;

type Setup = Awaited<ReturnType<typeof setup>>;

const conversationOf = async (s: Setup) =>
  (await db
    .prepare("SELECT id FROM conversations WHERE channel_id = ?")
    .bind(s.channelId)
    .first<{ id: string }>())!.id;

/** A normalized GitHub event as the integration-worker commits it: Event + `event.route` outbox. */
const githubEvent = async (
  workspaceId: string,
  data: Json,
  type = "github.pull_request.opened",
) => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.batch([
    insertEvent(db, {
      id,
      workspaceId,
      type,
      schemaVersion: 1,
      sourceKind: "github",
      actorKind: "integration",
      actorId: "integration-1",
      subjectKind: "pull_request",
      subjectId: `${data.repositoryId}#${data.number}`,
      data,
      correlationId: id,
      occurredAt: now,
      receivedAt: now,
    }),
    enqueueOutbox(db, { workspaceId, topic: "event.route", payload: { eventId: id } }),
  ]);
  return id;
};

const repo42 = { op: "eq", field: "data.repositoryId", value: 42 };

const subscribe = async (s: Setup, spec: Json = {}) => {
  const { subscriptionId } = await s.ok({
    type: "subscription.create",
    botId: s.botId,
    eventTypes: ["github.pull_request.*"],
    filter: repo42,
    destination: { conversationId: await conversationOf(s) },
    ...spec,
  });
  return subscriptionId as string;
};

const deliveriesOf = (eventId: string) =>
  db
    .prepare(
      `SELECT d.bot_id, d.lane, d.purpose, d.matched_subscription_ids, i.id AS item_id, i.delivery_mode,
              i.conversation_id, j.id AS job_id
         FROM event_deliveries d JOIN inbox_items i ON i.delivery_id = d.id
         LEFT JOIN jobs j ON j.trigger_key = 'inbox:' || i.id
        WHERE d.event_id = ?`,
    )
    .bind(eventId)
    .all<Json>()
    .then((r) => r.results);

describe("subscription commands", () => {
  it("creates with a revision row and lists it; update is a revision CAS", async () => {
    const s = await setup();
    const id = await subscribe(s);
    expect(await count("subscription_revisions WHERE subscription_id = ?", id)).toBe(1);
    const list = await (
      await s.user.get(`/v1/subscriptions?workspaceId=${s.workspaceId}`)
    ).json<{ subscriptions: Json[] }>();
    expect(list.subscriptions).toEqual([
      expect.objectContaining({
        id,
        botId: s.botId,
        enabled: true,
        revision: 1,
        filter: repo42,
        delivery: { mode: "wake", debounceMs: 10_000, maxBatchItems: 30, ttlSeconds: 86_400 },
      }),
    ]);

    const update = (expectedRevision: number) =>
      s.user.command(
        envelope(s.workspaceId, {
          type: "subscription.update",
          subscriptionId: id,
          expectedRevision,
          eventTypes: ["github.*"],
        }),
      );
    expect(await (await update(1)).json()).toMatchObject({ revision: 2 });
    const stale = await update(1);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(await count("subscription_revisions WHERE subscription_id = ?", id)).toBe(2);
  });

  it("rejects a bad filter, an unknown bot and a destination outside the caller's channels", async () => {
    const s = await setup();
    const conversationId = await conversationOf(s);
    const create = (spec: Json) =>
      s.user.command(
        envelope(s.workspaceId, {
          type: "subscription.create",
          botId: s.botId,
          eventTypes: ["github.*"],
          destination: { conversationId },
          ...spec,
        }),
      );
    const deep = {
      op: "not",
      node: { op: "not", node: { op: "not", node: { op: "not", node: repo42 } } },
    };
    expect((await create({ filter: deep })).status).toBe(422);
    expect((await create({ botId: crypto.randomUUID() })).status).toBe(404);
    const other = await setup();
    const foreign = await create({ destination: { conversationId: await conversationOf(other) } });
    expect(foreign.status).toBe(404);
  });

  it("test is a dry-run over recent events and writes nothing (AT-06 style)", async () => {
    const s = await setup();
    const id = await subscribe(s);
    const hit = await githubEvent(s.workspaceId, { repositoryId: 42, number: 7 });
    await githubEvent(s.workspaceId, { repositoryId: 9, number: 1 });
    await githubEvent(s.workspaceId, { repositoryId: 42, number: 8 }, "github.issues.opened");
    const receipts = await count("operation_receipts WHERE workspace_id = ?", s.workspaceId);

    const res = await s.user.command(
      envelope(s.workspaceId, { type: "subscription.test", subscriptionId: id }),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ evaluated: number; matched: Json[] }>();
    expect(body.evaluated).toBe(3);
    expect(body.matched).toEqual([expect.objectContaining({ eventId: hit })]);
    expect(await count("operation_receipts WHERE workspace_id = ?", s.workspaceId)).toBe(receipts);
    expect(await count("inbox_items WHERE workspace_id = ?", s.workspaceId)).toBe(0);
  });
});

describe("subscription routing", () => {
  it("a filter match creates Delivery, inbox item and Job with matched_subscription_ids", async () => {
    const s = await setup();
    const id = await subscribe(s);
    const hit = await githubEvent(s.workspaceId, { repositoryId: 42, number: 7 });
    const miss = await githubEvent(s.workspaceId, { repositoryId: 9, number: 1 });
    await s.pump();

    const [delivery] = await deliveriesOf(hit);
    expect(delivery).toMatchObject({
      bot_id: s.botId,
      lane: await conversationOf(s),
      purpose: "subscription",
      matched_subscription_ids: JSON.stringify([id]),
      delivery_mode: "wake",
      conversation_id: await conversationOf(s),
    });
    expect(delivery!.job_id).toBeTruthy();
    // No match: the consumer receipt only.
    expect(await count("event_receipts WHERE event_id = ?", miss)).toBe(1);
    expect(await count("event_deliveries WHERE event_id = ?", miss)).toBe(0);
  });

  it("two Subscriptions of one bot and lane collapse into one wake", async () => {
    const s = await setup();
    const a = await subscribe(s);
    const b = await subscribe(s, { eventTypes: ["github.pull_request.opened"], filter: undefined });
    const eventId = await githubEvent(s.workspaceId, { repositoryId: 42, number: 7 });
    await s.pump();
    const deliveries = await deliveriesOf(eventId);
    expect(deliveries).toHaveLength(1);
    expect(JSON.parse(deliveries[0]!.matched_subscription_ids as string)).toEqual(
      [a, b].toSorted(),
    );
    expect(await count("jobs WHERE workspace_id = ?", s.workspaceId)).toBe(1);
  });

  it("ignores paused and expired Subscriptions", async () => {
    const s = await setup();
    const paused = await subscribe(s);
    await s.ok({ type: "subscription.pause", subscriptionId: paused });
    await subscribe(s, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const eventId = await githubEvent(s.workspaceId, { repositoryId: 42, number: 7 });
    await s.pump();
    expect(await count("event_receipts WHERE event_id = ?", eventId)).toBe(1);
    expect(await count("event_deliveries WHERE event_id = ?", eventId)).toBe(0);
    expect(await count("subscription_revisions WHERE subscription_id = ?", paused)).toBe(2);
  });

  it("batch mode seals after maxBatchItems into one Job whose context has every item", async () => {
    const s = await setup();
    await subscribe(s, { delivery: { mode: "batch", debounceMs: 600_000, maxBatchItems: 2 } });
    const first = await githubEvent(s.workspaceId, { repositoryId: 42, number: 1 });
    await s.pump();
    expect(await count("jobs WHERE workspace_id = ?", s.workspaceId)).toBe(0);
    await githubEvent(s.workspaceId, { repositoryId: 42, number: 2 });
    const { sealed } = (await s.pump()) as { sealed?: number };
    expect(sealed).toBeGreaterThanOrEqual(1);
    // Arrives after the seal: opens the next batch.
    await githubEvent(s.workspaceId, { repositoryId: 42, number: 3 });
    await s.pump();

    const batches = await db
      .prepare(
        "SELECT id, state, item_count FROM inbox_batches WHERE bot_id = ? ORDER BY created_at",
      )
      .bind(s.botId)
      .all<{ id: string; state: string; item_count: number }>();
    expect(batches.results.map((b) => [b.state, b.item_count])).toEqual([
      ["sealed", 2],
      ["open", 1],
    ]);
    const batchId = batches.results[0]!.id;
    const job = await db
      .prepare("SELECT id, trigger_key, inbox_batch_id FROM jobs WHERE workspace_id = ?")
      .bind(s.workspaceId)
      .all<{ id: string; trigger_key: string; inbox_batch_id: string }>();
    expect(job.results).toEqual([
      expect.objectContaining({ trigger_key: `batch:${batchId}`, inbox_batch_id: batchId }),
    ]);
    const jobId = job.results[0]!.id;
    expect((await deliveriesOf(first))[0]).toMatchObject({ delivery_mode: "batch", job_id: null });

    // The executor sees every member's body, then the result settles all of them.
    const auth = { Authorization: `Bearer ${s.deviceToken}` };
    const claimed = await (
      await call(
        "/v1/executor/commands",
        auth,
        envelope(s.workspaceId, { type: "job.claim", jobId, expectedRevision: 1 }),
      )
    ).json<{ runId: string; executionGeneration: number }>();
    const context = await (
      await call(
        `/v1/executor/jobs/${jobId}/context?runId=${claimed.runId}&executionGeneration=${claimed.executionGeneration}`,
        auth,
      )
    ).json<{ batch: { id: string; items: { body: string }[] }; conversation: { id: string } }>();
    expect(context.batch.id).toBe(batchId);
    expect(context.batch.items.map((i) => JSON.parse(i.body).number)).toEqual([1, 2]);
    expect(context.conversation.id).toBe(await conversationOf(s));

    const submitted = await call(
      "/v1/executor/commands",
      auth,
      envelope(s.workspaceId, {
        type: "run.result.submit",
        runId: claimed.runId,
        executionGeneration: claimed.executionGeneration,
        state: "succeeded",
        summary: "reviewed",
        reply: { conversationId: context.conversation.id, text: "done" },
      }),
    );
    expect(submitted.status).toBe(200);
    expect(await count("inbox_items WHERE batch_id = ? AND state = 'processed'", batchId)).toBe(2);
  });
});

describe("integration.create", () => {
  it("returns the hook path", async () => {
    const s = await setup();
    const body = await s.ok({
      type: "integration.create",
      kind: "slack",
      externalAccountId: "U0BOT",
    });
    expect(body.hookPath).toBe(`/hooks/slack/${body.integrationId}`);
    const row = await db
      .prepare(
        "SELECT kind, enabled, external_account_id FROM integration_installations WHERE id = ?",
      )
      .bind(body.integrationId)
      .first();
    expect(row).toEqual({ kind: "slack", enabled: 1, external_account_id: "U0BOT" });
  });
});
