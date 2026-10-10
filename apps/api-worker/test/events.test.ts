import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { routeEvent } from "../src/pump.ts";
import { call, envelope, login, register, withWorkspace } from "./helpers.ts";

const db = env.DB;
const count = async (from: string, ...params: unknown[]) =>
  (await db
    .prepare(`SELECT COUNT(*) AS n FROM ${from}`)
    .bind(...params)
    .first<{ n: number }>())!.n;

type Json = Record<string, unknown>;

// Workspace + device + channel + bot, all fresh per test.
const setup = async () => {
  const { user, workspaceId } = await withWorkspace();
  const ok = async (command: unknown) => {
    const res = await user.command(envelope(workspaceId, command));
    expect(res.status).toBe(200);
    return res.json<Json>();
  };
  const { deviceToken } = await ok(register);
  const { channelId } = await ok({ type: "channel.create", name: "dev" });
  const { botId } = await ok({ type: "bot.create", name: "coder" });
  const pump = async () => {
    const res = await call("/v1/executor/pump", { Authorization: `Bearer ${deviceToken}` }, {});
    expect(res.status).toBe(200);
    return res.json<{ processed: number; dead: number }>();
  };
  const send = (delivery = "wake", idempotencyKey?: string) =>
    envelope(
      workspaceId,
      {
        type: "agent.send",
        recipientBotId: botId,
        channelId,
        message: { kind: "request", text: "check PR #123" },
        delivery,
      },
      idempotencyKey,
    );
  return { user, workspaceId, channelId: channelId as string, botId: botId as string, pump, send };
};

const jobsFor = (inboxItemId: string) =>
  count("jobs WHERE trigger_key = ?", `inbox:${inboxItemId}`);

describe("agent.send", () => {
  it("commits message, event, inbox item and outbox; the pump creates a queued Job", async () => {
    const s = await setup();
    const request = s.send();
    const res = await s.user.command(request);
    expect(res.status).toBe(200);
    const body = await res.json<{ messageId: string; inboxItemId: string }>();
    expect(body).toMatchObject({
      operationId: request.operationId,
      status: "accepted",
      jobId: null,
      routingStatus: "pending",
    });

    const message = await db
      .prepare("SELECT seq, body FROM messages WHERE id = ?")
      .bind(body.messageId)
      .first();
    expect(message).toEqual({ seq: 1, body: "check PR #123" });
    const item = await db
      .prepare("SELECT input_id, lane, purpose, delivery_mode, state FROM inbox_items WHERE id = ?")
      .bind(body.inboxItemId)
      .first<{ input_id: string }>();
    expect(item).toMatchObject({
      lane: s.channelId,
      purpose: "agent.send",
      delivery_mode: "wake",
      state: "pending",
    });
    const eventId = item!.input_id;
    expect(await count("events WHERE id = ? AND type = 'agent.message.sent'", eventId)).toBe(1);
    expect(
      await count(
        "outbox WHERE topic = 'event.route' AND json_extract(payload, '$.eventId') = ?",
        eventId,
      ),
    ).toBe(1);
    expect(await jobsFor(body.inboxItemId)).toBe(0);

    const pending = await (await s.user.get(`/v1/operations/${request.operationId}`)).json();
    expect(pending).toMatchObject({ routingStatus: "pending", jobId: null });

    await s.pump();
    const op = await (
      await s.user.get(`/v1/operations/${request.operationId}`)
    ).json<{ jobId: string; inboxItem: { deliveryId: string } }>();
    expect(op).toMatchObject({ routingStatus: "routed", response: body });
    expect(op.inboxItem.deliveryId).toBeTruthy();
    expect(
      await count("event_deliveries WHERE event_id = ? AND bot_id = ?", eventId, s.botId),
    ).toBe(1);

    const job = await s.user.get(`/v1/jobs/${op.jobId}`);
    expect(job.status).toBe(200);
    expect(await job.json()).toMatchObject({
      botId: s.botId,
      state: "queued",
      triggerKey: `inbox:${body.inboxItemId}`,
      placement: { mode: "any", allowedDeviceIds: [] },
    });
    const inbox = await (await s.user.get(`/v1/inbox?botId=${s.botId}`)).json<{ items: Json[] }>();
    expect(inbox.items).toEqual([
      expect.objectContaining({ id: body.inboxItemId, deliveryId: op.inboxItem.deliveryId }),
    ]);
    // Another user cannot read the Job.
    expect((await (await login()).get(`/v1/jobs/${op.jobId}`)).status).toBe(404);
  });

  it("routes each event once when the outbox row is pumped again (AT-04, AT-10)", async () => {
    const s = await setup();
    const body = await (await s.user.command(s.send())).json<{ inboxItemId: string }>();
    await s.pump();
    const { input_id: eventId } = (await db
      .prepare("SELECT input_id FROM inbox_items WHERE id = ?")
      .bind(body.inboxItemId)
      .first<{ input_id: string }>())!;

    // The ACK was "lost": the row becomes ready again and is pumped a second time.
    await db
      .prepare(
        "UPDATE outbox SET state = 'pending', lease_owner = NULL WHERE json_extract(payload, '$.eventId') = ?",
      )
      .bind(eventId)
      .run();
    await s.pump();
    await routeEvent(db, eventId);

    expect(await count("event_receipts WHERE event_id = ?", eventId)).toBe(1);
    expect(await count("event_deliveries WHERE event_id = ?", eventId)).toBe(1);
    expect(await jobsFor(body.inboxItemId)).toBe(1);
    expect(
      await count(
        "outbox WHERE json_extract(payload, '$.eventId') = ? AND state = 'sent'",
        eventId,
      ),
    ).toBe(1);
  });

  it("replays the same key and rejects a different payload with 409 (AT-05)", async () => {
    const s = await setup();
    const request = s.send("wake", "send-1");
    const first = await (await s.user.command(request)).json();
    const replay = await s.user.command(request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(first);
    const conflict = await s.user.command(s.send("notify", "send-1"));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await count("messages WHERE client_message_id = 'send-1'")).toBe(1);
  });

  it("delivers notify to the inbox without a Job", async () => {
    const s = await setup();
    const body = await (await s.user.command(s.send("notify"))).json<{ inboxItemId: string }>();
    await s.pump();
    const item = await db
      .prepare("SELECT delivery_mode, delivery_id FROM inbox_items WHERE id = ?")
      .bind(body.inboxItemId)
      .first<{ delivery_mode: string; delivery_id: string | null }>();
    expect(item?.delivery_mode).toBe("notify");
    expect(item?.delivery_id).toBeTruthy();
    expect(await jobsFor(body.inboxItemId)).toBe(0);
  });

  it("forbids a workspace member who is not in the channel", async () => {
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
          "INSERT INTO actors (id, workspace_id, kind, user_id, display_name) VALUES (?, ?, 'user', ?, 'other')",
        )
        .bind(crypto.randomUUID(), s.workspaceId, userId),
    ]);
    const res = await other.command(s.send());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects an unknown bot and a duplicate channel name", async () => {
    const s = await setup();
    const unknownBot = s.send();
    (unknownBot.command as Json).recipientBotId = crypto.randomUUID();
    expect((await s.user.command(unknownBot)).status).toBe(404);
    const dup = await s.user.command(
      envelope(s.workspaceId, { type: "channel.create", name: "dev" }),
    );
    expect(dup.status).toBe(422);
  });
});

const emit = (workspaceId: string, type: string) =>
  envelope(workspaceId, { type: "event.emit", event: { type, data: { ok: true } } });

describe("event.emit", () => {
  it("stores a custom event; with no subscribers routing writes only a receipt (AT-06)", async () => {
    const s = await setup();
    const request = emit(s.workspaceId, "custom.build.failed");
    const res = await s.user.command(request);
    expect(res.status).toBe(200);
    const { eventId } = await res.json<{ eventId: string }>();
    expect(await count("events WHERE id = ? AND source_kind = 'cli'", eventId)).toBe(1);

    await s.pump();
    expect(await count("event_receipts WHERE event_id = ?", eventId)).toBe(1);
    expect(await count("event_deliveries WHERE event_id = ?", eventId)).toBe(0);
    expect(await count("inbox_items WHERE input_id = ?", eventId)).toBe(0);
    expect(await count("jobs WHERE workspace_id = ?", s.workspaceId)).toBe(0);
    expect(await (await s.user.get(`/v1/operations/${request.operationId}`)).json()).toMatchObject({
      response: { eventId, status: "accepted" },
    });
  });

  it("forbids a user from emitting outside custom.*", async () => {
    const { user, workspaceId } = await withWorkspace();
    const res = await user.command(emit(workspaceId, "task.completed"));
    expect(res.status).toBe(403);
    expect(await count("events WHERE workspace_id = ?", workspaceId)).toBe(0);
  });
});

describe("pump", () => {
  it("marks a row dead after the last failed attempt", async () => {
    const s = await setup();
    const id = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO outbox (id, workspace_id, topic, payload, attempt) VALUES (?, ?, 'event.route', ?, 4)",
      )
      .bind(id, s.workspaceId, JSON.stringify({ eventId: "missing" }))
      .run();
    const { dead } = await s.pump();
    expect(dead).toBeGreaterThanOrEqual(1);
    expect(await count("outbox WHERE id = ? AND state = 'dead' AND attempt = 5", id)).toBe(1);
  });
});
