// Run capability and bot-to-bot request / response (docs/architecture.md §8, §18.2; AT-03, AT-26, AT-29).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashSecret } from "../src/auth/device.ts";
import { call, claim, count, envelope, executor, type Json, queuedJob, setup } from "./helpers.ts";

const db = env.DB;
type Claimed = {
  runId: string;
  executionGeneration: number;
  capability: { token: string; expiresAt: string } | null;
};

/** A request to the `helper` Bot. */
const request = (text = "what is 2+2?") => ({
  type: "agent.send",
  recipientBotName: "helper",
  message: { kind: "request", text },
});

/** setup() plus a second Bot `helper`, and helpers to act as a claimed Run. */
const bots = async () => {
  const s = await setup();
  const { botId: helperId } = await s.ok({ type: "bot.create", name: "helper" });
  const device = executor(s.deviceToken, s.workspaceId);
  // Several Runs at once on the one device.
  await device.post("/v1/executor/heartbeat", { capacity: { background: 8 } });
  const claimJob = async (jobId: string, expectedRevision = 1) => {
    const res = await device.command(claim(jobId, expectedRevision));
    expect(res.status).toBe(200);
    return res.json<Claimed>();
  };
  /** A Run of a fresh user agent.send to `botId`. */
  const runOf = async (botId: string) => {
    const { jobId, inboxItemId } = await queuedJob(s, botId);
    return { jobId, inboxItemId, ...(await claimJob(jobId)) };
  };
  const as = (token: string) => {
    const auth = { Authorization: `Bearer ${token}` };
    return {
      get: (path: string) => call(path, auth),
      command: (command: Json) => call("/v1/run/commands", auth, envelope(s.workspaceId, command)),
    };
  };
  const submit = (run: Claimed, body: Json) =>
    device.command({
      type: "run.result.submit",
      runId: run.runId,
      executionGeneration: run.executionGeneration,
      summary: "done",
      ...body,
    });
  const job = async (id: string) => (await s.user.get(`/v1/jobs/${id}`)).json<Json>();
  const context = async (jobId: string, run: Claimed) =>
    (
      await device.get(
        `/v1/executor/jobs/${jobId}/context?runId=${run.runId}&executionGeneration=${run.executionGeneration}`,
      )
    ).json<Json>();
  return {
    ...s,
    helperId: helperId as string,
    device,
    claimJob,
    runOf,
    as,
    request,
    submit,
    job,
    context,
  };
};

const errorOf = async (res: Response) => ({ status: res.status, ...(await res.json<Json>()) });

describe("run capability", () => {
  it("is issued on claim, stored hashed, and authenticates the Run as its Bot", async () => {
    const s = await bots();
    const run = await s.runOf(s.botId);
    const token = run.capability!.token;
    expect(token).toMatch(new RegExp(`^cap\\.${run.runId}\\.[0-9a-f]{64}$`));
    const row = await db
      .prepare("SELECT token_hash, scopes, expires_at FROM run_capabilities WHERE run_id = ?")
      .bind(run.runId)
      .first<{ token_hash: string; scopes: string; expires_at: string }>();
    expect(row!.token_hash).toBe(await hashSecret(token.split(".")[2]!));
    expect(JSON.parse(row!.scopes)).toEqual([
      "agent.send",
      "agent.reply",
      "task.read",
      "memory.write",
      "search.read",
    ]);

    const me = await s.as(token).get("/v1/run/me");
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      kind: "run",
      runId: run.runId,
      botId: s.botId,
      hop: 0,
      taskId: null,
    });
    // Not a user or device credential.
    expect((await call("/v1/run/me", { Authorization: `Bearer ${s.deviceToken}` })).status).toBe(
      401,
    );
    expect((await s.as(`cap.${run.runId}.${"0".repeat(64)}`).get("/v1/run/me")).status).toBe(401);

    // Renewal extends the capability with the lease.
    await db
      .prepare("UPDATE run_capabilities SET expires_at = ? WHERE run_id = ?")
      .bind(new Date(Date.now() + 1000).toISOString(), run.runId)
      .run();
    const renew = await s.device.command({
      type: "run.lease.renew",
      runId: run.runId,
      executionGeneration: run.executionGeneration,
    });
    expect(renew.status).toBe(200);
    const renewed = await db
      .prepare("SELECT expires_at FROM run_capabilities WHERE run_id = ?")
      .bind(run.runId)
      .first<{ expires_at: string }>();
    expect(Date.parse(renewed!.expires_at) - Date.now()).toBeGreaterThan(80_000 + 4 * 60_000);
  });

  it("rejects expired, revoked and stale-generation capabilities (401)", async () => {
    const s = await bots();
    const expired = await s.runOf(s.botId);
    await db
      .prepare("UPDATE run_capabilities SET expires_at = ? WHERE run_id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), expired.runId)
      .run();
    expect((await s.as(expired.capability!.token).get("/v1/run/me")).status).toBe(401);

    const revoked = await s.runOf(s.helperId);
    await db
      .prepare("UPDATE run_capabilities SET revoked_at = ? WHERE run_id = ?")
      .bind(new Date().toISOString(), revoked.runId)
      .run();
    expect((await s.as(revoked.capability!.token).get("/v1/run/me")).status).toBe(401);

    // A finished Run's capability is revoked with its result; an older generation never authenticates.
    const s2 = await bots();
    const done = await s2.runOf(s2.botId);
    expect((await s2.submit(done, { state: "succeeded" })).status).toBe(200);
    expect((await s2.as(done.capability!.token).get("/v1/run/me")).status).toBe(401);
    expect(
      await count("run_capabilities WHERE run_id = ? AND revoked_at IS NOT NULL", done.runId),
    ).toBe(1);
    const other = await s2.runOf(s2.helperId);
    await db
      .prepare("UPDATE runs SET execution_generation = 2 WHERE id = ?")
      .bind(other.runId)
      .run();
    expect((await s2.as(other.capability!.token).get("/v1/run/me")).status).toBe(401);
  });
});

describe("bot-to-bot agent.send from a run", () => {
  it("records the Bot's message, the recipient's Inbox item and a Job with hop + 1 and the correlation", async () => {
    const s = await bots();
    const a = await s.runOf(s.botId);
    const res = await s.as(a.capability!.token).command(s.request());
    expect(res.status).toBe(200);
    const sent = await res.json<Json>();
    const pair = `botpair:${[s.botId, s.helperId].toSorted().join(":")}`;
    expect(sent).toMatchObject({ conversationId: pair, hop: 1 });

    const message = await db
      .prepare(
        `SELECT m.kind, m.hop, m.job_id, a.kind AS actor_kind, b.id AS bot_id, c.kind AS conversation_kind
           FROM messages m JOIN actors a ON a.id = m.actor_id JOIN bots b ON b.actor_id = a.id
           JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?`,
      )
      .bind(sent.messageId)
      .first();
    expect(message).toEqual({
      kind: "request",
      hop: 1,
      job_id: a.jobId,
      actor_kind: "bot",
      bot_id: s.botId,
      conversation_kind: "bot_pair",
    });
    // The pair's backing channel has no members, so it is in no user's channel list.
    const channels = await (
      await s.user.get(`/v1/channels?workspaceId=${s.workspaceId}`)
    ).json<{
      channels: Json[];
    }>();
    expect(channels.channels.map((c) => c.id)).not.toContain(pair);

    await s.pump();
    const jobB = await db
      .prepare(
        `SELECT j.id, j.correlation_id, i.hop, i.lane, i.purpose FROM jobs j
           JOIN inbox_items i ON 'inbox:' || i.id = j.trigger_key WHERE i.id = ?`,
      )
      .bind(sent.inboxItemId)
      .first<Json>();
    const correlation = await db
      .prepare("SELECT correlation_id FROM jobs WHERE id = ?")
      .bind(a.jobId)
      .first<{ correlation_id: string }>();
    expect(correlation!.correlation_id).toEqual(expect.any(String));
    expect(jobB).toMatchObject({
      correlation_id: correlation!.correlation_id,
      hop: 1,
      lane: pair,
      purpose: "agent.send",
    });

    // A notification is only recorded: no Job.
    const note = await (
      await s.as(a.capability!.token).command({
        type: "agent.send",
        recipientBotId: s.helperId,
        message: { kind: "notification", text: "fyi" },
      })
    ).json<Json>();
    await s.pump();
    expect(await count("jobs WHERE trigger_key = ?", `inbox:${note.inboxItemId}`)).toBe(0);

    const listed = await (
      await s.user.get(`/v1/bot-conversations?workspaceId=${s.workspaceId}`)
    ).json<{ conversations: Json[] }>();
    expect(listed.conversations).toEqual([
      expect.objectContaining({
        id: pair,
        bots: expect.arrayContaining([{ id: s.helperId, name: "helper" }]),
        messages: [
          expect.objectContaining({ bot: "coder", kind: "request", hop: 1 }),
          expect.objectContaining({ bot: "coder", kind: "notification", body: "fyi" }),
        ],
      }),
    ]);
  });

  it("enforces self-send, hop limit and chain budget (422, AT-26)", async () => {
    const s = await bots();
    const a = await s.runOf(s.botId);
    const as = s.as(a.capability!.token);

    expect(
      await errorOf(
        await as.command({ ...s.request(), recipientBotName: undefined, recipientBotId: s.botId }),
      ),
    ).toMatchObject({ status: 422, reason: "self_send" });

    // The Run inherits its trigger item's hop: at 4 a further request would be hop 5.
    await db.prepare("UPDATE inbox_items SET hop = 4 WHERE id = ?").bind(a.inboxItemId).run();
    expect(await errorOf(await as.command(s.request()))).toMatchObject({
      status: 422,
      reason: "hop_limit",
    });
    await db.prepare("UPDATE inbox_items SET hop = 3 WHERE id = ?").bind(a.inboxItemId).run();
    expect((await as.command(s.request())).status).toBe(200);

    // 20 Jobs in the chain: no more requests.
    const { correlation_id: correlation } = (await db
      .prepare("SELECT correlation_id FROM jobs WHERE id = ?")
      .bind(a.jobId)
      .first<{ correlation_id: string }>())!;
    await db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 19)
         INSERT INTO jobs (id, workspace_id, bot_id, state, trigger_key, placement, correlation_id)
         SELECT ? || i, ?, ?, 'succeeded', ? || i, '{}', ? FROM n`,
      )
      .bind(`filler-${a.jobId}-`, s.workspaceId, s.helperId, `filler-${a.jobId}-`, correlation)
      .run();
    expect(await errorOf(await as.command(s.request()))).toMatchObject({
      status: 422,
      reason: "budget_exceeded",
    });
  });

  it("lets a Task Job's Run read and write Tasks of its own Project only", async () => {
    const s = await bots();
    await s.ok({ type: "project.create", key: "APP", name: "app" });
    await s.ok({ type: "project.create", key: "OPS", name: "ops" });
    const { taskId } = await s.ok({ type: "task.create", projectKey: "APP", title: "build" });
    const { taskId: opsTask } = await s.ok({ type: "task.create", projectKey: "OPS", title: "x" });
    const { jobId } = await s.ok({ type: "job.start", taskId, botId: s.botId });
    const run = await s.claimJob(jobId as string);
    const as = s.as(run.capability!.token);

    const task = await (await as.get(`/v1/run/tasks/${taskId}`)).json<Json>();
    expect(task).toMatchObject({ id: taskId, status: "in_progress" });
    expect((await as.get(`/v1/run/tasks/${opsTask}`)).status).toBe(403);
    const created = await as.command({ type: "task.create", projectKey: "APP", title: "sub" });
    expect(created.status).toBe(200);
    expect((await as.command({ type: "task.create", projectKey: "OPS", title: "no" })).status).toBe(
      403,
    );
    const assign = await as.command({
      type: "task.assign",
      taskId,
      assignee: { kind: "bot", id: s.helperId },
      expectedRevision: task.revision,
    });
    expect(assign.status).toBe(200);
    expect(
      await count(
        "operation_receipts WHERE actor_id = ? AND workspace_id = ?",
        run.runId,
        s.workspaceId,
      ),
    ).toBe(2);

    // A Run without a Task has no task.write.
    const plain = await s.runOf(s.helperId);
    const denied = await s
      .as(plain.capability!.token)
      .command({ type: "task.create", projectKey: "APP", title: "no" });
    expect(denied.status).toBe(403);
  });
});

describe("request / response between Bots (AT-03, AT-29)", () => {
  it("A waits without holding a slot; B's reply queues A's Job, whose successor Run sees the reply", async () => {
    const s = await bots();
    const a = await s.runOf(s.botId);
    const sent = await (await s.as(a.capability!.token).command(s.request())).json<Json>();

    // An unknown request id is refused; the Run is still active.
    expect(
      await errorOf(
        await s.submit(a, { state: "waiting", waitingFor: { requestMessageId: "nope" } }),
      ),
    ).toMatchObject({ status: 422, reason: "unknown_request" });
    expect(
      (await s.submit(a, { state: "waiting", waitingFor: { requestMessageId: sent.messageId } }))
        .status,
    ).toBe(200);
    expect(await s.job(a.jobId)).toMatchObject({
      state: "waiting_input",
      runs: [expect.objectContaining({ state: "succeeded" })],
    });
    expect(
      await count("resource_reservations WHERE run_id = ? AND released_at IS NULL", a.runId),
    ).toBe(0);
    expect(await count("executions WHERE run_id = ? AND state = 'finished'", a.runId)).toBe(1);
    // The trigger item waits for the successor Run.
    expect(await count("inbox_items WHERE id = ? AND state = 'pending'", a.inboxItemId)).toBe(1);

    // B runs: its context names the requesting Bot and the request message.
    await s.pump();
    const jobB = (await db
      .prepare("SELECT id FROM jobs WHERE trigger_key = ?")
      .bind(`inbox:${sent.inboxItemId}`)
      .first<{ id: string }>())!.id;
    const b = await s.claimJob(jobB);
    expect(await s.context(jobB, b)).toMatchObject({
      inboxItem: {
        body: "what is 2+2?",
        messageId: sent.messageId,
        kind: "request",
        fromBot: { id: s.botId, name: "coder" },
      },
      conversation: { id: sent.conversationId, kind: "bot_pair" },
    });
    const reply = await s.as(b.capability!.token).command({
      type: "agent.reply",
      requestMessageId: sent.messageId,
      text: "4",
    });
    expect(reply.status).toBe(200);
    const replied = await reply.json<Json>();
    expect(
      await db
        .prepare(
          "SELECT kind, hop, reply_to_message_id, conversation_id FROM messages WHERE id = ?",
        )
        .bind(replied.messageId)
        .first(),
    ).toEqual({
      kind: "response",
      hop: 1,
      reply_to_message_id: sent.messageId,
      conversation_id: sent.conversationId,
    });
    expect(
      await count(
        "inbox_items WHERE id = ? AND bot_id = ? AND purpose = 'agent.reply' AND hop = 1",
        replied.inboxItemId,
        s.botId,
      ),
    ).toBe(1);
    // Only the recipient of a request may answer it.
    expect(
      (
        await s
          .as(b.capability!.token)
          .command({ type: "agent.reply", requestMessageId: replied.messageId, text: "x" })
      ).status,
    ).toBe(404);

    // A's Job is claimable again at its new revision; the successor Run sees the request item and the reply.
    const queued = await s.job(a.jobId);
    expect(queued).toMatchObject({ state: "queued" });
    const listed = await (
      await s.device.get("/v1/executor/jobs?state=queued")
    ).json<{
      jobs: Json[];
    }>();
    expect(listed.jobs.map((j) => j.id)).toContain(a.jobId);
    const a2 = await s.claimJob(a.jobId, queued.revision as number);
    expect(a2.executionGeneration).toBe(2);
    // Waiting again for an answered request would loop (AT-29): refused, the Run stays active.
    expect(
      await errorOf(
        await s.submit(a2, { state: "waiting", waitingFor: { requestMessageId: sent.messageId } }),
      ),
    ).toMatchObject({ status: 422, reason: "already_replied" });
    expect(await s.job(a.jobId)).toMatchObject({ state: "active" });
    expect(await s.context(a.jobId, a2)).toMatchObject({
      inboxItem: { id: a.inboxItemId, body: "check PR #123", fromBot: null },
      replies: [
        {
          messageId: replied.messageId,
          requestMessageId: sent.messageId,
          fromBot: { id: s.helperId, name: "helper" },
          body: "4",
        },
      ],
    });
    expect((await s.submit(a2, { state: "succeeded" })).status).toBe(200);
    expect(await s.job(a.jobId)).toMatchObject({ state: "succeeded" });
    expect(
      await count(
        "inbox_items WHERE id IN (?, ?) AND state = 'processed'",
        a.inboxItemId,
        replied.inboxItemId,
      ),
    ).toBe(2);
  });

  it("a reply that arrives before A's Run ends queues A's Job at once", async () => {
    const s = await bots();
    const a = await s.runOf(s.botId);
    const sent = await (await s.as(a.capability!.token).command(s.request())).json<Json>();
    await s.pump();
    const jobB = (await db
      .prepare("SELECT id FROM jobs WHERE trigger_key = ?")
      .bind(`inbox:${sent.inboxItemId}`)
      .first<{ id: string }>())!.id;
    const b = await s.claimJob(jobB);
    await s
      .as(b.capability!.token)
      .command({ type: "agent.reply", requestMessageId: sent.messageId, text: "4" });
    expect(await s.job(a.jobId)).toMatchObject({ state: "active" });

    await s.submit(a, { state: "waiting", waitingFor: { requestMessageId: sent.messageId } });
    expect(await s.job(a.jobId)).toMatchObject({ state: "queued" });
  });
});
