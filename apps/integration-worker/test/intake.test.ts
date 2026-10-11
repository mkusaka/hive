import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app, maxPayloadBytes } from "../src/index.ts";

const db = env.DB;
const encoder = new TextEncoder();
const count = async (from: string, ...params: unknown[]) =>
  (await db
    .prepare(`SELECT COUNT(*) AS n FROM ${from}`)
    .bind(...params)
    .first<{ n: number }>())!.n;

const hmacHex = async (secret: string, data: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/** A fresh Workspace with one installation, seeded directly (the command lives in api-worker). */
const install = async (kind: "github" | "slack", externalAccountId: string | null = null) => {
  const workspaceId = crypto.randomUUID();
  const integrationId = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO workspaces (id, name) VALUES (?, 'ws')").bind(workspaceId),
    db
      .prepare(
        "INSERT INTO integration_installations (id, workspace_id, kind, external_account_id) VALUES (?, ?, ?, ?)",
      )
      .bind(integrationId, workspaceId, kind, externalAccountId),
  ]);
  return { workspaceId, integrationId };
};

const post = (path: string, body: string, headers: Record<string, string>) =>
  app.request(path, { method: "POST", body, headers }, env);

const github = async (
  integrationId: string,
  payload: unknown,
  {
    delivery = crypto.randomUUID(),
    event = "pull_request",
    secret = env.GITHUB_WEBHOOK_SECRET,
  } = {},
) => {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return post(`/hooks/github/${integrationId}`, body, {
    "X-GitHub-Event": event,
    "X-GitHub-Delivery": delivery,
    "X-Hub-Signature-256": `sha256=${await hmacHex(secret, body)}`,
  });
};

const slack = async (
  integrationId: string,
  payload: unknown,
  { timestamp = Math.floor(Date.now() / 1000) } = {},
) => {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const signature = await hmacHex(env.SLACK_SIGNING_SECRET, `v0:${timestamp}:${body}`);
  return post(`/hooks/slack/${integrationId}`, body, {
    "X-Slack-Request-Timestamp": String(timestamp),
    "X-Slack-Signature": `v0=${signature}`,
  });
};

const pullRequestOpened = {
  action: "opened",
  repository: { id: 42 },
  sender: { login: "octocat" },
  pull_request: {
    number: 7,
    labels: [{ name: "bug" }],
    head: { ref: "feat/x", sha: "abc123" },
  },
};

describe("GitHub intake", () => {
  it("verifies the signature and commits the normalized event with its outbox row", async () => {
    const { workspaceId, integrationId } = await install("github");
    const delivery = crypto.randomUUID();
    const res = await github(integrationId, pullRequestOpened, { delivery });
    expect(res.status).toBe(200);
    const { eventId } = await res.json<{ eventId: string }>();
    const event = await db
      .prepare(
        `SELECT workspace_id, type, source_kind, integration_id, external_event_id, actor_kind, actor_id,
                subject_kind, subject_id, data, logical_key FROM events WHERE id = ?`,
      )
      .bind(eventId)
      .first<{ data: string }>();
    expect(event).toMatchObject({
      workspace_id: workspaceId,
      type: "github.pull_request.opened",
      source_kind: "github",
      integration_id: integrationId,
      external_event_id: delivery,
      actor_kind: "integration",
      actor_id: integrationId,
      subject_kind: "pull_request",
      subject_id: "42#7",
      logical_key: null,
    });
    expect(JSON.parse(event!.data)).toEqual({
      repositoryId: 42,
      number: 7,
      action: "opened",
      sender: "octocat",
      labels: ["bug"],
      branch: "feat/x",
      headSha: "abc123",
    });
    expect(
      await count(
        "outbox WHERE topic = 'event.route' AND json_extract(payload, '$.eventId') = ?",
        eventId,
      ),
    ).toBe(1);
  });

  it("rejects a bad signature with 401 and stores nothing", async () => {
    const { workspaceId, integrationId } = await install("github");
    const res = await github(integrationId, pullRequestOpened, { secret: "wrong" });
    expect(res.status).toBe(401);
    expect(await count("events WHERE workspace_id = ?", workspaceId)).toBe(0);
  });

  it("answers a redelivery with duplicate: true and keeps one event", async () => {
    const { workspaceId, integrationId } = await install("github");
    const delivery = crypto.randomUUID();
    const first = await (await github(integrationId, pullRequestOpened, { delivery })).json();
    const again = await github(integrationId, pullRequestOpened, { delivery });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      ok: true,
      duplicate: true,
      eventId: (first as { eventId: string }).eventId,
    });
    expect(await count("events WHERE workspace_id = ?", workspaceId)).toBe(1);
    expect(await count("outbox WHERE workspace_id = ?", workspaceId)).toBe(1);
  });

  it("refuses an oversized payload with 413 and records the coverage gap", async () => {
    const { workspaceId, integrationId } = await install("github");
    const big = JSON.stringify({ ...pullRequestOpened, pad: "x".repeat(maxPayloadBytes) });
    const res = await github(integrationId, big);
    expect(res.status).toBe(413);
    expect(await count("events WHERE workspace_id = ?", workspaceId)).toBe(0);
    const audit = await db
      .prepare("SELECT action, target_id, data FROM audit_log WHERE workspace_id = ?")
      .bind(workspaceId)
      .first<{ data: string }>();
    expect(audit).toMatchObject({ action: "integration.coverage_gap", target_id: integrationId });
    expect(JSON.parse(audit!.data)).toMatchObject({ reason: "payload_too_large" });
  });

  it("404s an unknown installation or one of the other kind", async () => {
    const { integrationId } = await install("slack");
    expect((await github(integrationId, pullRequestOpened)).status).toBe(404);
    expect((await github(crypto.randomUUID(), pullRequestOpened)).status).toBe(404);
  });
});

const botUser = "U0BOT";
const callback = (eventId: string, event: Record<string, unknown>) => ({
  type: "event_callback",
  token: "deprecated-verification-token",
  team_id: "T1",
  event_id: eventId,
  event: { channel: "C1", ts: "1700000000.000100", user: "U1", ...event },
});

describe("Slack intake", () => {
  it("answers url_verification after verifying the signature", async () => {
    const { integrationId } = await install("slack");
    const res = await slack(integrationId, { type: "url_verification", challenge: "c-123" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "c-123" });
  });

  it("rejects a stale timestamp with 401", async () => {
    const { integrationId } = await install("slack");
    const stale = Math.floor(Date.now() / 1000) - 6 * 60;
    const res = await slack(integrationId, callback("Ev1", { type: "app_mention" }), {
      timestamp: stale,
    });
    expect(res.status).toBe(401);
  });

  it("collapses app_mention and message of one post into one event (AT-23)", async () => {
    const { workspaceId, integrationId } = await install("slack", botUser);
    const text = `<@${botUser}> please deploy`;
    // `message` first: it is typed app_mention too, so the stored event does not depend on arrival order.
    const message = await slack(integrationId, callback("Ev-msg", { type: "message", text }));
    const mention = await slack(
      integrationId,
      callback("Ev-mention", { type: "app_mention", text }),
    );
    expect(message.status).toBe(200);
    expect(await mention.json()).toMatchObject({ duplicate: true });
    const rows = await db
      .prepare("SELECT type, logical_key, subject_id, data FROM events WHERE workspace_id = ?")
      .bind(workspaceId)
      .all<{ data: string }>();
    expect(rows.results).toEqual([
      expect.objectContaining({
        type: "slack.app_mention",
        logical_key: "slack:T1:C1:1700000000.000100",
        subject_id: "T1:C1:1700000000.000100",
      }),
    ]);
    const data = JSON.parse(rows.results[0]!.data);
    expect(data).toMatchObject({ slackChannelId: "C1", slackUserId: "U1", text });
    // Normalized fields only: no verification token is stored.
    expect(rows.results[0]!.data).not.toContain("deprecated-verification-token");
    expect(await count("outbox WHERE workspace_id = ?", workspaceId)).toBe(1);
  });

  it("stores the app's own post but never routes it (AT-27)", async () => {
    const { workspaceId, integrationId } = await install("slack", botUser);
    const res = await slack(
      integrationId,
      callback("Ev-echo", { type: "message", user: botUser, text: "done" }),
    );
    expect(await res.json()).toMatchObject({ ok: true, routed: false });
    const event = await db
      .prepare("SELECT id FROM events WHERE workspace_id = ?")
      .bind(workspaceId)
      .first<{ id: string }>();
    expect(event).not.toBeNull();
    expect(await count("outbox WHERE workspace_id = ?", workspaceId)).toBe(0);
    expect(await count("event_receipts WHERE event_id = ?", event!.id)).toBe(1);
  });

  it("caps text at 8 KiB of UTF-8", async () => {
    const { workspaceId, integrationId } = await install("slack");
    await slack(integrationId, callback("Ev-long", { type: "message", text: "あ".repeat(4000) }));
    const row = await db
      .prepare("SELECT json_extract(data, '$.text') AS text FROM events WHERE workspace_id = ?")
      .bind(workspaceId)
      .first<{ text: string }>();
    expect(encoder.encode(row!.text).length).toBeLessThanOrEqual(8 * 1024);
    expect(row!.text).toMatch(/^あ+$/);
  });
});
