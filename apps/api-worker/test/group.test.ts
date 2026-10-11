// Group chat in a Channel (ROUTE-02): every member Bot reads every post, mentions / Replies narrow, Bot replies fan
// out with hop + 1, busy Bots coalesce, and a Run may pass.
/* oxlint-disable no-await-in-loop */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { claim, count, executor, type Json, setup } from "./helpers.ts";

const db = env.DB;

/** #dev with members coder and reviewer, plus a non-member Bot `lurker`. */
const group = async () => {
  const s = await setup();
  const { botId: reviewerId } = await s.ok({ type: "bot.create", name: "reviewer" });
  const { botId: lurkerId } = await s.ok({ type: "bot.create", name: "lurker" });
  for (const botId of [s.botId, reviewerId]) {
    await s.ok({ type: "channel.join", channelId: s.channelId, botId });
  }
  const device = executor(s.deviceToken, s.workspaceId);
  await device.post("/v1/executor/heartbeat", { capacity: { background: 8 } });
  const post = (text: string, extra: Json = {}) =>
    s.ok({ type: "message.post", channelId: s.channelId, text, ...extra });
  /** The bot ids of queued Jobs, by bot name order of creation. */
  const queued = async () =>
    (
      await db
        .prepare(
          "SELECT id, bot_id FROM jobs WHERE workspace_id = ? AND state = 'queued' ORDER BY created_at, id",
        )
        .bind(s.workspaceId)
        .all<{ id: string; bot_id: string }>()
    ).results;
  /** Claims the Job, reads its context and submits `reply` (text, `pass`, or nothing). */
  const run = async (jobId: string, reply?: string) => {
    const r = await (
      await device.command(claim(jobId))
    ).json<{
      runId: string;
      executionGeneration: number;
    }>();
    const context = await (
      await device.get(
        `/v1/executor/jobs/${jobId}/context?runId=${r.runId}&executionGeneration=${r.executionGeneration}`,
      )
    ).json<Json & { conversation: { id: string } }>();
    const submit = () =>
      device.command({
        type: "run.result.submit",
        runId: r.runId,
        executionGeneration: r.executionGeneration,
        state: "succeeded",
        summary: reply ?? "",
        ...(reply === "pass"
          ? { pass: true }
          : reply
            ? { reply: { conversationId: context.conversation.id, text: reply } }
            : {}),
      });
    return { ...r, context, submit };
  };
  return {
    ...s,
    reviewerId: reviewerId as string,
    lurkerId: lurkerId as string,
    post,
    queued,
    run,
  };
};

describe("group chat routing", () => {
  it("wakes every member Bot without a mention; a mention, <@everyone> and a Reply narrow or widen it", async () => {
    const s = await group();
    const all = await s.post("who handles code review?");
    expect(all.inboxItemIds).toHaveLength(2);
    await s.pump();
    expect((await s.queued()).map((j) => j.bot_id).toSorted()).toEqual(
      [s.botId, s.reviewerId].toSorted(),
    );
    // Both are busy now: a mention still gets its delivery, but no second Job (coalesced).
    const one = await s.post(`<@bot:${s.reviewerId}> you`);
    expect(one.inboxItemIds).toHaveLength(1);
    await s.pump();
    expect(await s.queued()).toHaveLength(2);
    expect(
      await count(
        "inbox_items WHERE id = ? AND bot_id = ?",
        (one.inboxItemIds as string[])[0],
        s.reviewerId,
      ),
    ).toBe(1);

    const everyone = await s.post("<@everyone> say your name");
    expect(everyone.inboxItemIds).toHaveLength(2);
    // A non-member mention joins and narrows to it alone.
    const lurker = await s.post(`<@bot:${s.lurkerId}> hi`);
    expect(lurker.inboxItemIds).toHaveLength(1);
    expect(
      await count(
        "channel_members m JOIN bots b ON b.actor_id = m.actor_id WHERE m.channel_id = ? AND b.id = ?",
        s.channelId,
        s.lurkerId,
      ),
    ).toBe(1);

    // A Reply on reviewer's message addresses reviewer only; a Reply on a human message is a plain post.
    const reviewerJob = (await s.queued()).find((j) => j.bot_id === s.reviewerId);
    const r = await s.run(reviewerJob!.id, "I review code.");
    expect((await r.submit()).status).toBe(200);
    const reviewerMessage = await db
      .prepare("SELECT m.id FROM messages m JOIN bots b ON b.actor_id = m.actor_id WHERE b.id = ?")
      .bind(s.reviewerId)
      .first<{ id: string }>();
    const reply = await s.post("thanks, one more word", {
      replyToMessageId: reviewerMessage!.id,
    });
    const recipients = await db
      .prepare("SELECT bot_id FROM inbox_items WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(reply.inboxItemIds))
      .all<{ bot_id: string }>();
    expect(recipients.results.map((i) => i.bot_id)).toEqual([s.reviewerId]);
    const onHuman = await s.post("and you all", { replyToMessageId: all.messageId });
    expect(onHuman.inboxItemIds).toHaveLength(3);
    const elsewhere = await s.user.command(
      (await import("./helpers.ts")).envelope(s.workspaceId, {
        type: "message.post",
        channelId: s.channelId,
        text: "x",
        replyToMessageId: "nope",
      }),
    );
    expect(elsewhere.status).toBe(404);
  });

  it("a Bot's reply fans out to the other members with hop + 1 and the chain's correlation, and stops at the hop limit", async () => {
    const s = await group();
    await s.post(`<@bot:${s.botId}> ask reviewer something`);
    await s.pump();
    let [job] = await s.queued();
    const hops: number[] = [];
    // coder → reviewer → coder → … : each reply wakes only the other Bot (never itself).
    for (let round = 0; round < 6 && job; round++) {
      const r = await s.run(job.id, round === 0 ? "@reviewer what is 2+2?" : `round ${round}`);
      expect((await r.submit()).status).toBe(200);
      await s.pump();
      const next = await s.queued();
      expect(next.length).toBeLessThanOrEqual(1);
      if (next[0]) {
        expect(next[0].bot_id).not.toBe(job.bot_id);
        const item = await db
          .prepare(
            "SELECT i.hop, j.correlation_id FROM jobs j JOIN inbox_items i ON 'inbox:' || i.id = j.trigger_key WHERE j.id = ?",
          )
          .bind(next[0].id)
          .first<{ hop: number; correlation_id: string }>();
        hops.push(item!.hop);
      }
      job = next[0]!;
    }
    expect(hops).toEqual([1, 2, 3, 4]);
    // The first reply's `@reviewer` became a token; the last reply (hop 5) was posted but woke nobody.
    const bodies = (
      await db
        .prepare(
          `SELECT m.body FROM messages m JOIN conversations c ON c.id = m.conversation_id
            WHERE c.channel_id = ? AND c.kind = 'channel' ORDER BY m.seq`,
        )
        .bind(s.channelId)
        .all<{ body: string }>()
    ).results.map((m) => m.body);
    expect(bodies[1]).toBe(`<@bot:${s.reviewerId}> what is 2+2?`);
    expect(bodies).toHaveLength(6);
    const correlations = await db
      .prepare("SELECT COUNT(DISTINCT correlation_id) AS n FROM jobs WHERE workspace_id = ?")
      .bind(s.workspaceId)
      .first<{ n: number }>();
    expect(correlations!.n).toBe(1);
  });

  it("coalesces: a post while a Bot's Job is active gets no Job; one follow-up after the Run, with the post in since", async () => {
    const s = await group();
    await s.post(`<@bot:${s.botId}> first`);
    await s.pump();
    const [first] = await s.queued();
    const r = await s.run(first!.id);
    expect((r.context.peers as Json[]).map((p) => p.name)).toEqual(["reviewer"]);
    await s.post(`<@bot:${s.botId}> second`);
    await s.post(`<@bot:${s.botId}> third`);
    await s.pump();
    expect(await s.queued()).toEqual([]);
    expect((await r.submit()).status).toBe(200);
    const followUps = await s.queued();
    expect(followUps).toHaveLength(1);
    const next = await s.run(followUps[0]!.id);
    const since = (next.context.since as Json[]).map((m) => [m.speakerKind, m.isSelf, m.body]);
    expect(since).toEqual([
      ["human", false, "@coder second"],
      ["human", false, "@coder third"],
    ]);
    expect((await next.submit()).status).toBe(200);
    // Every delivery was handled by one of the two Runs; nothing more is queued.
    expect(await count("inbox_items WHERE bot_id = ? AND state = 'pending'", s.botId)).toBe(0);
    expect(await s.queued()).toEqual([]);
  });

  it("a pass posts nothing, records runtime.run.passed and shows as outcome pass; presence follows the Jobs", async () => {
    const s = await group();
    await s.post("anyone?");
    await s.pump();
    const presence = async () =>
      (
        await (
          await s.user.get(`/v1/channels/${s.channelId}/presence?workspaceId=${s.workspaceId}`)
        ).json<{ presence: Json[] }>()
      ).presence.map((p) => [p.name, p.state]);
    expect(await presence()).toEqual([
      ["coder", "reading"],
      ["reviewer", "reading"],
    ]);
    const jobs = await s.queued();
    const coder = await s.run(jobs.find((j) => j.bot_id === s.botId)!.id, "pass");
    expect(await presence()).toEqual([
      ["coder", "working"],
      ["reviewer", "reading"],
    ]);
    const before = await count("messages WHERE workspace_id = ?", s.workspaceId);
    expect((await coder.submit()).status).toBe(200);
    expect(await count("messages WHERE workspace_id = ?", s.workspaceId)).toBe(before);
    expect(
      await count("events WHERE type = 'runtime.run.passed' AND subject_id = ?", coder.runId),
    ).toBe(1);
    const job = await (
      await s.user.get(`/v1/jobs/${jobs.find((j) => j.bot_id === s.botId)!.id}`)
    ).json<{
      state: string;
      runs: Json[];
    }>();
    expect(job.state).toBe("succeeded");
    expect(job.runs[0]).toMatchObject({ state: "succeeded", outcome: "pass" });
    expect(await presence()).toEqual([
      ["coder", "idle"],
      ["reviewer", "reading"],
    ]);
    // pass with a reply is rejected.
    const reviewer = await s.run(jobs.find((j) => j.bot_id === s.reviewerId)!.id);
    const bad = await executor(s.deviceToken, s.workspaceId).command({
      type: "run.result.submit",
      runId: reviewer.runId,
      executionGeneration: reviewer.executionGeneration,
      state: "succeeded",
      summary: "",
      pass: true,
      reply: { conversationId: reviewer.context.conversation.id, text: "x" },
    });
    expect(bad.status).toBe(422);
  });
});
