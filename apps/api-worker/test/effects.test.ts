// External effect broker (docs/architecture.md §19; AT-28, AT-40): prepare / approve / perform / reconcile / resolve.
// Providers are faked at the `fetch` boundary with Slack's and GitHub's request and response shapes.
import { env } from "cloudflare:test";
import { decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { createPerformers, githubAppJwt } from "../src/effects.ts";
import { pump } from "../src/pump.ts";
import { call, claim, count, envelope, executor, type Json, queuedJob, setup } from "./helpers.ts";

const db = env.DB;
const { privateKey } = await generateKeyPair("RS256", { extractable: true });
const privateKeyPem = await exportPKCS8(privateKey);

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

type Sent = { method: string; url: URL; headers: Headers; body: Json | null };

/**
 * Slack + GitHub over `fetch`. `post` decides each write: `ok` (stored and answered), `lost` (stored, then the
 * connection drops), `drop` (never arrives), or an HTTP status / Slack error to answer with.
 */
const fakeProviders = () => {
  const sent: Sent[] = [];
  const comments: { id: number; html_url: string; body: string }[] = [];
  const messages: { ts: string; text: string; metadata?: unknown }[] = [];
  const plan: Record<"github" | "slack", (string | number)[]> = { github: [], slack: [] };
  const fetchImpl = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Json) : null;
    sent.push({ method: init.method ?? "GET", url, headers: new Headers(init.headers), body });
    if (url.pathname.endsWith("/access_tokens")) return json({ token: "ghs_fake" }, 201);
    if (init.method === "GET") {
      if (url.host === "api.github.com") return json(comments);
      return json({ ok: true, messages, response_metadata: { next_cursor: "" } });
    }
    const step = plan[url.host === "api.github.com" ? "github" : "slack"].shift() ?? "ok";
    if (step === "drop") throw new TypeError("network connection lost");
    if (typeof step === "number") return json({ message: "nope" }, step);
    if (step !== "ok" && step !== "lost") return json({ ok: false, error: step });
    let reply: Response;
    if (url.host === "api.github.com") {
      const id = 1000 + comments.length;
      const comment = {
        id,
        html_url: `https://github.com/o/r/issues/7#issuecomment-${id}`,
        body: String(body!.body),
      };
      comments.push(comment);
      reply = json(comment, 201);
    } else {
      const ts = `1700000000.${String(100 + messages.length).padStart(6, "0")}`;
      messages.push({ ts, text: String(body!.text), metadata: body!.metadata });
      reply = json({ ok: true, channel: body!.channel, ts });
    }
    if (step === "lost") throw new TypeError("response lost");
    return reply;
  };
  const performers = createPerformers(
    {
      SLACK_BOT_TOKEN: "xoxb-fake",
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: privateKeyPem,
      GITHUB_INSTALLATION_ID: "99",
    },
    fetchImpl,
  );
  const writes = () =>
    sent.filter((r) => r.method === "POST" && !r.url.pathname.endsWith("/access_tokens"));
  return { sent, writes, plan, comments, messages, performers };
};

const slack = { kind: "slack.post", request: { channel: "C0123ABCD", text: "build is green" } };
const github = {
  kind: "github.comment",
  request: { owner: "o", repo: "r", issueNumber: 7, body: "LGTM from hive" },
};

/** A claimed Run of a Bot with `effects` policy, plus a Slack and a GitHub installation. */
const running = async (effects: Json = { "slack.post": "ask", "github.comment": "allow" }) => {
  const s = await setup();
  await s.ok({ type: "bot.update", botId: s.botId, expectedRevision: 1, toolPolicy: { effects } });
  const { integrationId: slackId } = await s.ok({ type: "integration.create", kind: "slack" });
  const { integrationId: githubId } = await s.ok({ type: "integration.create", kind: "github" });
  const device = executor(s.deviceToken, s.workspaceId);
  const { jobId } = await queuedJob(s);
  const run = await (
    await device.command(claim(jobId))
  ).json<{
    runId: string;
    capability: { token: string };
  }>();
  const auth = { Authorization: `Bearer ${run.capability.token}` };
  const providers = fakeProviders();
  const prepare = (command: Json) =>
    call("/v1/run/commands", auth, envelope(s.workspaceId, { type: "effect.prepare", ...command }));
  const prepared = async (command: Json) => {
    const res = await prepare(command);
    expect(res.status).toBe(200);
    return res.json<{ effectId: string; state: string; approvalId: string | null }>();
  };
  const effect = (id: string) => call(`/v1/run/effects/${id}`, auth).then((r) => r.json<Json>());
  const drain = () =>
    pump(db, { owner: "test", limit: 100, r2: env.R2, performers: providers.performers });
  // The reconcile is scheduled 30 s out; make it due.
  const due = () =>
    db
      .prepare(
        `UPDATE outbox SET available_at = ? WHERE state = 'pending' AND topic = 'effect.reconcile'
           AND json_extract(payload, '$.effectId') IN (SELECT id FROM effects WHERE run_id = ?)`,
      )
      .bind(new Date(0).toISOString(), run.runId)
      .run();
  const runState = async () =>
    (await db
      .prepare("SELECT state FROM runs WHERE id = ?")
      .bind(run.runId)
      .first<{ state: string }>())!.state;
  const resolve = (command: Json) =>
    s.user.command(envelope(s.workspaceId, { type: "effect.resolve", ...command }));
  return {
    ...s,
    run,
    auth,
    slackId,
    githubId,
    providers,
    prepare,
    prepared,
    effect,
    drain,
    due,
    runState,
    resolve,
  };
};

describe("effect.prepare", () => {
  it("is denied by default (403) and needs a capability that is still current (401)", async () => {
    const r = await running({});
    const denied = await r.prepare(slack);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ reason: "effect_denied" });

    // A new generation (recovery) invalidates the old Run's capability: no effect without it (AT-40).
    await db
      .prepare("UPDATE runs SET execution_generation = execution_generation + 1 WHERE id = ?")
      .bind(r.run.runId)
      .run();
    expect((await r.prepare(github)).status).toBe(401);
    expect(await count("effects WHERE run_id = ?", r.run.runId)).toBe(0);
  });

  it("checks the installation: wrong kind 422, another workspace 404, several of a kind need an id", async () => {
    const r = await running();
    const wrongKind = await r.prepare({ ...slack, integrationId: r.githubId });
    expect(wrongKind.status).toBe(422);
    expect(await wrongKind.json()).toMatchObject({ reason: "integration_kind" });
    const other = await running();
    expect((await r.prepare({ ...slack, integrationId: other.slackId })).status).toBe(404);
    await r.ok({ type: "integration.create", kind: "slack" });
    const ambiguous = await r.prepare(slack);
    expect(ambiguous.status).toBe(422);
    expect(await ambiguous.json()).toMatchObject({ reason: "integration_ambiguous" });
    // Bad request shapes are 422 before any of that.
    expect(
      (await r.prepare({ ...slack, request: { channel: "#general", text: "x" } })).status,
    ).toBe(422);
  });
});

describe("ask policy", () => {
  it("waits on an approval like a tool call; allow performs it with the marker in the Slack metadata", async () => {
    const r = await running();
    const prepared = await r.prepared(slack);
    expect(prepared).toMatchObject({ state: "prepared" });
    expect(await r.runState()).toBe("waiting_approval");
    const approvals = await (
      await r.user.get(`/v1/approvals?workspaceId=${r.workspaceId}&state=pending`)
    ).json<Json>();
    expect(approvals.approvals).toEqual([
      expect.objectContaining({
        actionKind: "slack.post",
        argsSummary: "C0123ABCD: build is green",
      }),
    ]);
    expect(
      await count(
        "outbox WHERE topic = 'effect.perform' AND payload LIKE ?",
        `%${prepared.effectId}%`,
      ),
    ).toBe(0);

    const ok = await r.user.command(
      envelope(r.workspaceId, {
        type: "approval.resolve",
        approvalId: prepared.approvalId,
        decision: "allow",
      }),
    );
    expect(ok.status).toBe(200);
    expect(await r.effect(prepared.effectId)).toMatchObject({ state: "approved" });
    expect(await r.runState()).toBe("running");
    expect(
      await count(
        "outbox WHERE topic = 'effect.perform' AND payload LIKE ?",
        `%${prepared.effectId}%`,
      ),
    ).toBe(1);

    await r.drain();
    expect(await r.effect(prepared.effectId)).toMatchObject({
      state: "succeeded",
      externalId: "1700000000.000100",
      attempts: 1,
    });
    const [post] = r.providers.writes();
    expect(post!.url.href).toBe("https://slack.com/api/chat.postMessage");
    expect(post!.headers.get("Authorization")).toBe("Bearer xoxb-fake");
    expect(post!.body).toMatchObject({
      channel: "C0123ABCD",
      text: "build is green",
      metadata: {
        event_type: "hive_effect",
        event_payload: { marker: `hive:${prepared.effectId}` },
      },
    });
    // prepared, approved, executing, succeeded.
    expect(
      await count("change_log WHERE entity_kind = 'effect' AND entity_id = ?", prepared.effectId),
    ).toBe(4);
  });

  it("a denied or expired approval fails the effect, which cannot be retried", async () => {
    const r = await running();
    const a = await r.prepared(slack);
    await r.user.command(
      envelope(r.workspaceId, {
        type: "approval.resolve",
        approvalId: a.approvalId,
        decision: "deny",
      }),
    );
    expect(await r.effect(a.effectId)).toMatchObject({
      state: "failed",
      lastError: "approval_denied",
    });
    const retry = await r.resolve({ effectId: a.effectId, action: "retry" });
    expect(retry.status).toBe(409);

    const b = await r.prepared({
      kind: "slack.post",
      request: { ...slack.request, text: "second" },
    });
    await db
      .prepare("UPDATE approvals SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), b.approvalId)
      .run();
    await r.drain();
    expect(await r.effect(b.effectId)).toMatchObject({
      state: "failed",
      lastError: "approval_expired",
    });
    expect(r.providers.writes()).toHaveLength(0);
  });
});

describe("perform", () => {
  it("posts a GitHub comment with an installation token and the marker; the same request is one effect", async () => {
    const r = await running();
    const first = await r.prepared(github);
    expect(first).toMatchObject({ state: "approved", approvalId: null });
    expect(await r.prepared(github)).toMatchObject({ effectId: first.effectId });
    await r.drain();
    expect(await r.effect(first.effectId)).toMatchObject({
      state: "succeeded",
      externalId: "1000",
      externalUrl: "https://github.com/o/r/issues/7#issuecomment-1000",
    });
    const token = r.providers.sent.find(
      (s) => s.url.pathname === "/app/installations/99/access_tokens",
    )!;
    expect(decodeJwt(token.headers.get("Authorization")!.slice("Bearer ".length))).toMatchObject({
      iss: "12345",
    });
    const [post] = r.providers.writes();
    expect(post!.url.pathname).toBe("/repos/o/r/issues/7/comments");
    expect(post!.headers.get("Authorization")).toBe("Bearer ghs_fake");
    expect(post!.body).toEqual({ body: `LGTM from hive\n\n<!-- hive:${first.effectId} -->` });
    // A duplicate perform message is a no-op.
    await r.drain();
    expect(r.providers.writes()).toHaveLength(1);
  });

  it("a definite error fails without retry; 5xx / 429 / Slack ratelimited are unknown", async () => {
    const r = await running({ "slack.post": "allow", "github.comment": "allow" });
    r.providers.plan.github.push(404, 502);
    r.providers.plan.slack.push("channel_not_found", "ratelimited");
    const gh = await r.prepared(github);
    const sl = await r.prepared(slack);
    await r.drain();
    expect(await r.effect(gh.effectId)).toMatchObject({
      state: "failed",
      lastError: "create comment: HTTP 404",
    });
    expect(await r.effect(sl.effectId)).toMatchObject({
      state: "failed",
      lastError: "chat.postMessage: channel_not_found",
    });
    const gh2 = await r.prepared({ ...github, request: { ...github.request, body: "again" } });
    const sl2 = await r.prepared({ ...slack, request: { ...slack.request, text: "again" } });
    await r.drain();
    expect(await r.effect(gh2.effectId)).toMatchObject({ state: "unknown" });
    expect(await r.effect(sl2.effectId)).toMatchObject({
      state: "unknown",
      lastError: "chat.postMessage: ratelimited",
    });
    await r.drain();
    expect(r.providers.writes()).toHaveLength(4);
  });

  it("does not perform for a Run that is no longer current (AT-40)", async () => {
    const r = await running();
    const e = await r.prepared(github);
    await db.prepare("UPDATE runs SET state = 'unknown' WHERE id = ?").bind(r.run.runId).run();
    await r.drain();
    expect(
      await (
        await r.user.get(`/v1/effects?workspaceId=${r.workspaceId}&runId=${r.run.runId}`)
      ).json<Json>(),
    ).toEqual({
      effects: [
        expect.objectContaining({
          id: e.effectId,
          state: "failed",
          lastError: "run_not_current",
          attempts: 0,
        }),
      ],
    });
    expect(r.providers.writes()).toHaveLength(0);
  });
});

describe("unknown and reconcile (AT-28)", () => {
  it("a lost response is reconciled to the existing comment by its marker, never re-sent", async () => {
    const r = await running();
    r.providers.plan.github.push("lost");
    const e = await r.prepared(github);
    await r.drain();
    expect(await r.effect(e.effectId)).toMatchObject({
      state: "unknown",
      lastError: "response lost",
    });
    const reconcile = await db
      .prepare(
        "SELECT available_at FROM outbox WHERE topic = 'effect.reconcile' AND payload LIKE ?",
      )
      .bind(`%${e.effectId}%`)
      .first<{ available_at: string }>();
    expect(Date.parse(reconcile!.available_at)).toBeGreaterThan(Date.now() + 20_000);
    await r.drain();
    expect(r.providers.writes()).toHaveLength(1);

    await r.due();
    await r.drain();
    expect(await r.effect(e.effectId)).toMatchObject({
      state: "succeeded",
      externalId: "1000",
      attempts: 1,
    });
    expect(r.providers.writes()).toHaveLength(1);
    const lookup = r.providers.sent.find((s) => s.method === "GET")!;
    expect(lookup.url.pathname).toBe("/repos/o/r/issues/7/comments");
    expect(lookup.url.searchParams.get("since")).not.toBeNull();
  });

  it("a Slack post is found by its metadata marker in the thread", async () => {
    const r = await running({ "slack.post": "allow" });
    r.providers.plan.slack.push("lost");
    const e = await r.prepared({
      ...slack,
      request: { ...slack.request, threadTs: "1699999999.000001" },
    });
    await r.drain();
    await r.due();
    await r.drain();
    expect(await r.effect(e.effectId)).toMatchObject({
      state: "succeeded",
      externalId: "1700000000.000100",
    });
    const lookup = r.providers.sent.find((s) => s.method === "GET")!;
    expect(lookup.url.pathname).toBe("/api/conversations.replies");
    expect(lookup.url.searchParams.get("include_all_metadata")).toBe("true");
    expect(lookup.url.searchParams.get("ts")).toBe("1699999999.000001");
  });

  it("an absent object is performed again, at most 3 times; then it stays unknown for a human", async () => {
    const r = await running();
    r.providers.plan.github.push("drop", "drop", "drop");
    const e = await r.prepared(github);
    for (let i = 0; i < 3; i++) {
      // oxlint-disable-next-line no-await-in-loop -- rounds are sequential
      await r.drain();
      // oxlint-disable-next-line no-await-in-loop
      await r.due();
      // oxlint-disable-next-line no-await-in-loop
      await r.drain();
    }
    expect(r.providers.writes()).toHaveLength(3);
    expect(await r.effect(e.effectId)).toMatchObject({
      state: "unknown",
      attempts: 3,
      lastError: "not found after 3 attempts; resolve manually",
    });

    const missing = await r.resolve({ effectId: e.effectId, action: "mark_succeeded" });
    expect(missing.status).toBe(422);
    const marked = await r.resolve({
      effectId: e.effectId,
      action: "mark_succeeded",
      externalId: "555",
    });
    expect(marked.status).toBe(200);
    expect(await r.effect(e.effectId)).toMatchObject({ state: "succeeded", externalId: "555" });
    expect((await r.resolve({ effectId: e.effectId, action: "mark_failed" })).status).toBe(409);
  });

  it("once re-performed after an absent lookup, it succeeds; a human may retry a failed effect", async () => {
    const r = await running();
    r.providers.plan.github.push("drop", "ok", 422);
    const e = await r.prepared(github);
    await r.drain();
    await r.due();
    await r.drain(); // absent → approved, perform queued
    await r.drain();
    expect(await r.effect(e.effectId)).toMatchObject({ state: "succeeded", attempts: 2 });

    const f = await r.prepared({ ...github, request: { ...github.request, body: "other" } });
    await r.drain();
    expect(await r.effect(f.effectId)).toMatchObject({ state: "failed" });
    expect((await r.resolve({ effectId: f.effectId, action: "retry" })).status).toBe(200);
    await r.drain();
    expect(await r.effect(f.effectId)).toMatchObject({ state: "succeeded", attempts: 2 });
    expect(
      await (
        await r.user.get(`/v1/effects?workspaceId=${r.workspaceId}&state=succeeded`)
      ).json<Json>(),
    ).toMatchObject({
      effects: [
        expect.objectContaining({ id: f.effectId }),
        expect.objectContaining({ id: e.effectId }),
      ],
    });
  });
});

describe("github app jwt", () => {
  it("is RS256 with iss = app id, iat 60 s back and exp at most 10 min ahead", async () => {
    const now = Date.UTC(2026, 9, 11, 12, 0, 0);
    const jwt = await githubAppJwt("12345", privateKeyPem.replaceAll("\n", "\\n"), now);
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decodeJwt(jwt);
    expect(claims).toEqual({ iss: "12345", iat: now / 1000 - 60, exp: now / 1000 + 540 });
  });
});
