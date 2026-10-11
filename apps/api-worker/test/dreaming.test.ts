import type { ConversationSummary } from "@hive/contracts";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  call,
  claim,
  count,
  envelope,
  executor,
  type Json,
  login,
  queuedJob,
  setup,
} from "./helpers.ts";

const db = env.DB;

type Claimed = {
  runId: string;
  executionGeneration: number;
  capability: { token: string } | null;
};

type DreamSetup = {
  user: {
    command: (body: unknown) => Promise<Response>;
    get: (path: string) => Promise<Response>;
  };
  workspaceId: string;
  deviceToken: string;
  channelId: string;
  botId: string;
  ok: (command: unknown) => Promise<Json>;
  pump: () => Promise<unknown>;
};

type PinnedFacts = ConversationSummary["pinnedFacts"];

type StoredContextSnapshot = {
  context: RunContext;
  summaryId: string | null;
  messageIds: string[];
  selectedRange: { conversationId: string; coversFromSeq: number; coversToSeq: number } | null;
  memoryRevisions: { id: string; revision: number }[];
};

type RunContext = Json & {
  jobKind: "normal" | "summarize" | "consolidate";
  conversation: { id: string; recent: Json[] } | null;
  summary: { id: string; coversFromSeq: number; coversToSeq: number; revision: number } | null;
  summarization: {
    conversationId: string;
    coversFromSeq: number;
    coversToSeq: number;
    messages: { id: string; seq: number }[];
    previousSummary: { id: string } | null;
  } | null;
  memories: { id: string; revision: number }[];
  consolidation: {
    scopeKind: "bot" | "channel";
    scopeId: string;
    memories: { id: string; revision: number }[];
  } | null;
};

const channelConversation = async (s: DreamSetup) => {
  const { channels } = await (
    await s.user.get(`/v1/channels?workspaceId=${s.workspaceId}`)
  ).json<{ channels: { id: string; conversationId: string }[] }>();
  return channels.find((channel) => channel.id === s.channelId)!.conversationId;
};

const claimContext = async (s: DreamSetup, jobId: string) => {
  const device = executor(s.deviceToken, s.workspaceId);
  const claimed = await device.command(claim(jobId));
  expect(claimed.status).toBe(200);
  const run = await claimed.json<Claimed>();
  expect(run.capability).not.toBeNull();
  const readContext = async () => {
    const response = await device.get(
      `/v1/executor/jobs/${jobId}/context?runId=${run.runId}&executionGeneration=${run.executionGeneration}`,
    );
    expect(response.status).toBe(200);
    return response.json<RunContext>();
  };
  const context = await readContext();
  const command = (body: Json) =>
    call(
      "/v1/run/commands",
      { Authorization: `Bearer ${run.capability!.token}` },
      envelope(s.workspaceId, body),
    );
  const finish = () =>
    device.command({
      type: "run.result.submit",
      runId: run.runId,
      executionGeneration: run.executionGeneration,
      state: "succeeded",
      summary: "finished",
    });
  return { run, context, command, finish, readContext };
};

const summarize = async (s: DreamSetup, conversationId: string) => {
  const response = await s.user.command(
    envelope(s.workspaceId, { type: "conversation.summarize", conversationId }),
  );
  expect(response.status).toBe(200);
  return response.json<{ jobId: string; status: string }>();
};

const post = async (s: DreamSetup, text: string, threadOf?: string) =>
  s.ok({ type: "message.post", channelId: s.channelId, text, ...(threadOf ? { threadOf } : {}) });

describe("DREAM-01 summaries", () => {
  it("queues only after the un-summarized span exceeds the threshold and dedupes automatic and manual requests", async () => {
    const s = await setup();
    const conversationId = await channelConversation(s);
    await s.ok({ type: "channel.join", channelId: s.channelId, botId: s.botId });

    await Promise.all(Array.from({ length: 10 }, (_, index) => post(s, `message-${index}`)));
    await s.pump();
    expect(
      await count(
        "jobs WHERE workspace_id = ? AND conversation_id = ? AND job_kind = 'summarize' AND state = 'queued'",
        s.workspaceId,
        conversationId,
      ),
    ).toBe(0);

    await post(s, "message-over-threshold");
    await s.pump();
    const automatic = await db
      .prepare(
        "SELECT id FROM jobs WHERE workspace_id = ? AND conversation_id = ? AND job_kind = 'summarize' AND state = 'queued'",
      )
      .bind(s.workspaceId, conversationId)
      .first<{ id: string }>();
    expect(automatic).not.toBeNull();

    const manual = await summarize(s, conversationId);
    expect(manual).toMatchObject({ status: "accepted", jobId: automatic!.id });
    await post(s, "message-after-automatic-request");
    await s.pump();
    expect(
      await count(
        "jobs WHERE workspace_id = ? AND conversation_id = ? AND job_kind = 'summarize' AND state IN ('queued', 'waiting_device', 'active', 'waiting_input', 'recovery_required')",
        s.workspaceId,
        conversationId,
      ),
    ).toBe(1);
  });

  it("uses a prior summary for the selected range, validates pinned sources, and shifts normal recent context", async () => {
    const s = await setup();
    const conversationId = await channelConversation(s);
    const { memoryId: baselineMemory } = await s.ok({
      type: "memory.write",
      scopeKind: "bot",
      scopeId: s.botId,
      content: "baseline-memory",
    });
    const first = await post(s, `<@bot:${s.botId}> initial`);
    await post(s, "follow-up");
    const firstJob = await summarize(s, conversationId);
    const firstRun = await claimContext(s, firstJob.jobId);
    expect(firstRun.context).toMatchObject({ jobKind: "summarize" });
    const firstSelection = firstRun.context.summarization!;
    expect(firstSelection).toMatchObject({
      conversationId,
      previousSummary: null,
      coversFromSeq: expect.any(Number),
      coversToSeq: expect.any(Number),
    });
    expect(firstSelection.messages.map((message) => message.id)).toContain(
      first.messageId as string,
    );

    const invalid = await firstRun.command({
      type: "summary.write",
      conversationId,
      coversFromSeq: firstSelection.coversFromSeq,
      coversToSeq: firstSelection.coversToSeq,
      text: "summary",
      pinnedFacts: [{ kind: "decision", text: "fact", sourceMessageIds: [crypto.randomUUID()] }],
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(await count("conversation_summaries WHERE workspace_id = ?", s.workspaceId)).toBe(0);

    const written = await firstRun.command({
      type: "summary.write",
      conversationId,
      coversFromSeq: firstSelection.coversFromSeq,
      coversToSeq: firstSelection.coversToSeq,
      text: "summary",
      pinnedFacts: [
        {
          kind: "decision",
          text: "fact",
          sourceMessageIds: [firstSelection.messages[0]!.id],
        },
      ],
    });
    expect(written.status).toBe(200);
    const { summaryId } = await written.json<{ summaryId: string }>();
    expect(summaryId).toEqual(expect.any(String));
    expect((await firstRun.finish()).status).toBe(200);
    const sharedSource = await post(s, "shared-summary-source");
    const sharedEnd = (await db
      .prepare("SELECT seq FROM messages WHERE workspace_id = ? AND id = ?")
      .bind(s.workspaceId, sharedSource.messageId as string)
      .first<{ seq: number }>())!.seq;
    const sharedJob = await s.ok({ type: "conversation.summarize", conversationId });
    const sharedRun = await claimContext(s, sharedJob.jobId as string);
    const sharedSelection = sharedRun.context.summarization!;
    const sharedWrite = await sharedRun.command({
      type: "summary.write",
      conversationId,
      coversFromSeq: sharedSelection.coversFromSeq,
      coversToSeq: sharedSelection.coversToSeq,
      text: "shared-summary",
      pinnedFacts: [
        {
          kind: "decision",
          text: "shared-fact",
          sourceMessageIds: [firstSelection.messages[0]!.id],
        },
      ],
    });
    expect(sharedWrite.status).toBe(200);
    const { summaryId: sharedSummaryId } = await sharedWrite.json<{ summaryId: string }>();
    expect((await sharedRun.finish()).status).toBe(200);
    // Shared historical summaries use the same producing-Run provenance as per-Bot summaries.
    await db
      .prepare("UPDATE conversation_summaries SET bot_id = NULL WHERE id = ?")
      .bind(sharedSummaryId)
      .run();
    const { botId: otherBotId } = await s.ok({ type: "bot.create", name: "summary-reader" });
    await s.ok({
      type: "channel.member.add",
      channelId: s.channelId,
      botId: otherBotId,
      role: "member",
    });
    const otherWake = await post(s, `<@bot:${otherBotId as string}> shared summary wake`);
    expect(otherWake.inboxItemIds).toHaveLength(1);
    await s.pump();
    const otherJob = await db
      .prepare("SELECT id FROM jobs WHERE workspace_id = ? AND trigger_key = ?")
      .bind(s.workspaceId, `inbox:${(otherWake.inboxItemIds as string[])[0]}`)
      .first<{ id: string }>();
    const otherRun = await claimContext(s, otherJob!.id);
    expect(otherRun.context).toMatchObject({
      jobKind: "normal",
      summary: { id: sharedSummaryId, coversToSeq: sharedEnd },
    });
    expect((await otherRun.finish()).status).toBe(200);

    const wake = await post(s, `<@bot:${s.botId}> wake after summary`);
    expect(wake.inboxItemIds).toHaveLength(1);
    await s.pump();
    const normalJob = await db
      .prepare(
        "SELECT id FROM jobs WHERE workspace_id = ? AND bot_id = ? AND job_kind = 'normal' AND state = 'queued'",
      )
      .bind(s.workspaceId, s.botId)
      .first<{ id: string }>();
    const normalRun = await claimContext(s, normalJob!.id);
    expect(normalRun.context).toMatchObject({
      jobKind: "normal",
      summary: { id: sharedSummaryId, coversToSeq: sharedEnd },
      conversation: { id: conversationId },
    });
    expect(normalRun.context.conversation!.recent).toHaveLength(2);

    const snapshotRow = await db
      .prepare("SELECT context_snapshot FROM runs WHERE workspace_id = ? AND id = ?")
      .bind(s.workspaceId, normalRun.run.runId)
      .first<{ context_snapshot: string }>();
    const snapshot = JSON.parse(snapshotRow!.context_snapshot) as StoredContextSnapshot;
    expect(snapshot).toMatchObject({
      summaryId: sharedSummaryId,
      selectedRange: null,
    });
    expect(snapshot.context.summary).toMatchObject({ id: sharedSummaryId });
    expect(snapshot.memoryRevisions).toContainEqual({ id: baselineMemory as string, revision: 1 });
    expect(snapshot.messageIds).toContain(wake.messageId as string);
    const { memoryId: laterMemory } = await s.ok({
      type: "memory.write",
      scopeKind: "bot",
      scopeId: s.botId,
      content: "later-memory",
    });
    // A separate publisher can update a shared view while this Bot's Run retains its snapshot.
    await s.ok({ type: "channel.join", channelId: s.channelId, botId: otherBotId as string });
    expect(
      (
        await executor(s.deviceToken, s.workspaceId).post("/v1/executor/heartbeat", {
          capacity: { background: 2 },
        })
      ).status,
    ).toBe(200);
    const secondJob = await summarize(s, conversationId);
    await db
      .prepare("UPDATE jobs SET bot_id = ? WHERE id = ?")
      .bind(otherBotId as string, secondJob.jobId)
      .run();
    const secondRun = await claimContext(s, secondJob.jobId);
    expect(secondRun.context).toMatchObject({
      jobKind: "summarize",
      summarization: {
        conversationId,
        previousSummary: { id: sharedSummaryId },
      },
    });
    expect(secondRun.context.summarization!.coversFromSeq).toBeGreaterThan(sharedEnd);
    const secondSelection = secondRun.context.summarization!;
    const carried = await secondRun.command({
      type: "summary.write",
      conversationId,
      coversFromSeq: secondSelection.coversFromSeq,
      coversToSeq: secondSelection.coversToSeq,
      text: "incremental-summary",
      pinnedFacts: [
        {
          kind: "decision",
          text: "fact",
          sourceMessageIds: [secondSelection.messages[0]!.id],
        },
      ],
    });
    expect(carried.status).toBe(200);
    const carriedSummary = await carried.json<{ summaryId: string }>();
    await db
      .prepare("UPDATE conversation_summaries SET bot_id = NULL WHERE id = ?")
      .bind(carriedSummary.summaryId)
      .run();
    const pinned = await db
      .prepare("SELECT pinned_facts FROM conversation_summaries WHERE id = ?")
      .bind(carriedSummary.summaryId)
      .first<{ pinned_facts: string }>();
    const facts = JSON.parse(pinned!.pinned_facts) as PinnedFacts;
    expect(facts).toEqual(
      expect.arrayContaining([
        {
          kind: "decision",
          text: "fact",
          sourceMessageIds: [firstSelection.messages[0]!.id, secondSelection.messages[0]!.id],
        },
        {
          kind: "decision",
          text: "shared-fact",
          sourceMessageIds: [firstSelection.messages[0]!.id],
        },
      ]),
    );
    expect(facts.filter((fact) => fact.kind === "decision" && fact.text === "fact")).toHaveLength(
      1,
    );
    const frozen = await normalRun.readContext();
    expect(frozen).toEqual(normalRun.context);
    expect((await normalRun.finish()).status).toBe(200);
    expect((await secondRun.finish()).status).toBe(200);
    const afterIncremental = await post(s, `<@bot:${s.botId}> wake after incremental summary`);
    await s.pump();
    const afterIncrementalJob = await db
      .prepare("SELECT id FROM jobs WHERE workspace_id = ? AND trigger_key = ?")
      .bind(s.workspaceId, `inbox:${(afterIncremental.inboxItemIds as string[])[0]}`)
      .first<{ id: string }>();
    const afterIncrementalRun = await claimContext(s, afterIncrementalJob!.id);
    expect(afterIncrementalRun.context).toMatchObject({
      jobKind: "normal",
      summary: { id: carriedSummary.summaryId, coversToSeq: secondSelection.coversToSeq },
    });
    expect(afterIncrementalRun.context.conversation!.recent).toHaveLength(1);
    expect(afterIncrementalRun.context.memories.map((memory) => memory.id)).toEqual(
      expect.arrayContaining([baselineMemory as string, laterMemory as string]),
    );
  });
});

describe("DREAM-01 consolidation", () => {
  it("fences consolidation writes to the read scope and revisions captured by its context", async () => {
    const s = await setup();
    const { memoryId: readMemory } = await s.ok({
      type: "memory.write",
      scopeKind: "bot",
      scopeId: s.botId,
      content: "readable",
    });
    const { botId: otherBot } = await s.ok({ type: "bot.create", name: "other" });
    const { memoryId: otherMemory } = await s.ok({
      type: "memory.write",
      scopeKind: "bot",
      scopeId: otherBot as string,
      content: "other-scope",
    });
    const requested = await s.ok({ type: "memory.consolidate", botId: s.botId });
    const run = await claimContext(s, requested.jobId as string);
    expect(run.context).toMatchObject({
      jobKind: "consolidate",
      consolidation: { scopeKind: "bot", scopeId: s.botId },
    });
    expect(run.context.consolidation!.memories).toEqual([
      expect.objectContaining({ id: readMemory, revision: 1 }),
    ]);

    const { memoryId: unreadMemory } = await s.ok({
      type: "memory.write",
      scopeKind: "bot",
      scopeId: s.botId,
      content: "written-after-snapshot",
    });
    const unreadMerge = await run.command({
      type: "memory.write",
      scopeKind: "bot",
      scopeId: s.botId,
      content: "merge-unread",
      source: "consolidation",
      mergedFrom: [{ id: unreadMemory as string, revision: 1 }],
    });
    expect(unreadMerge.status).toBe(403);
    expect(await unreadMerge.json()).toMatchObject({ code: "FORBIDDEN" });

    const unreadDelete = await run.command({
      type: "memory.delete",
      memoryId: unreadMemory as string,
      expectedRevision: 1,
    });
    expect(unreadDelete.status).toBe(403);
    expect(await unreadDelete.json()).toMatchObject({ code: "FORBIDDEN" });

    const unreadSupersede = await run.command({
      type: "memory.write",
      scopeKind: "bot",
      scopeId: s.botId,
      content: "supersede-unread",
      source: "consolidation",
      supersedesId: unreadMemory as string,
      expectedSupersedesRevision: 1,
    });
    expect(unreadSupersede.status).toBe(403);
    expect(await unreadSupersede.json()).toMatchObject({ code: "FORBIDDEN" });

    const outsideScope = await run.command({
      type: "memory.delete",
      memoryId: otherMemory as string,
      expectedRevision: 1,
    });
    expect(outsideScope.status).toBe(403);
    expect(await outsideScope.json()).toMatchObject({ code: "FORBIDDEN" });

    await s.ok({
      type: "memory.write",
      scopeKind: "bot",
      scopeId: s.botId,
      content: "replacement",
      supersedesId: readMemory as string,
      expectedSupersedesRevision: 1,
    });
    const staleMerge = await run.command({
      type: "memory.write",
      scopeKind: "bot",
      scopeId: s.botId,
      content: "merge-stale",
      source: "consolidation",
      mergedFrom: [{ id: readMemory as string, revision: 1 }],
    });
    expect(staleMerge.status).toBe(409);
    expect(await staleMerge.json()).toMatchObject({
      code: "REVISION_CONFLICT",
      reason: "stale_revision",
    });
  });
});

describe("DREAM-01 promotion and nightly schedule", () => {
  it("refuses promotion to a user who cannot read private DM, thread, or bot-pair sources", async () => {
    const s = await setup();
    const { botId: helperBotId } = await s.ok({ type: "bot.create", name: "private-helper" });
    const sourceJob = await queuedJob(s);
    const sourceRun = await claimContext(s, sourceJob.jobId);
    const pair = await sourceRun.command({
      type: "agent.send",
      recipientBotId: helperBotId as string,
      message: { kind: "request", text: "private-bot-pair-source" },
    });
    expect(pair.status).toBe(200);
    const { conversationId: botPairConversationId } = await pair.json<{ conversationId: string }>();
    expect((await sourceRun.finish()).status).toBe(200);
    const { conversationId: dmConversationId } = await s.ok({ type: "dm.open", botId: s.botId });
    await s.ok({
      type: "message.post",
      conversationId: dmConversationId as string,
      text: "dm-source",
    });

    const { channelId: privateChannelId } = await s.ok({ type: "channel.create", name: "private" });
    const root = await s.ok({
      type: "message.post",
      channelId: privateChannelId as string,
      text: "thread-root",
    });
    const thread = await s.ok({
      type: "message.post",
      channelId: privateChannelId as string,
      threadOf: root.messageId as string,
      text: "thread-source",
    });

    const candidates = await Promise.all(
      [dmConversationId as string, thread.conversationId as string].map((conversationId) =>
        s.ok({
          type: "memory.write",
          scopeKind: "bot",
          scopeId: s.botId,
          content: "proposed",
          sourceConversationIds: [conversationId],
          proposedScope: "workspace",
        }),
      ),
    );
    await s.pump();
    const pairJob = await db
      .prepare("SELECT id FROM jobs WHERE workspace_id = ? AND bot_id = ? AND job_kind = 'normal'")
      .bind(s.workspaceId, helperBotId)
      .first<{ id: string }>();
    const pairRun = await claimContext(s, pairJob!.id);
    const pairMemory = await pairRun.command({
      type: "memory.write",
      scopeKind: "bot",
      scopeId: helperBotId as string,
      content: "proposed",
      sourceConversationIds: [botPairConversationId],
      proposedScope: "workspace",
    });
    expect(pairMemory.status).toBe(200);
    candidates.push(await pairMemory.json<{ memoryId: string }>());
    expect((await pairRun.finish()).status).toBe(200);
    const outsider = await login();
    const { userId } = await (await outsider.me()).json<{ userId: string }>();
    await db.batch([
      db
        .prepare(
          "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')",
        )
        .bind(s.workspaceId, userId),
      db
        .prepare(
          "INSERT INTO actors (id, workspace_id, kind, user_id, display_name) VALUES (?, ?, 'user', ?, 'outsider')",
        )
        .bind(crypto.randomUUID(), s.workspaceId, userId),
    ]);

    await Promise.all(
      candidates.map(async (candidate) => {
        const denied = await outsider.command(
          envelope(s.workspaceId, {
            type: "memory.promote",
            memoryId: candidate.memoryId as string,
          }),
        );
        expect(denied.status).toBe(403);
        expect(await denied.json()).toMatchObject({ code: "FORBIDDEN" });
      }),
    );
    expect(
      await count(
        "memories WHERE workspace_id = ? AND scope_kind = 'workspace' AND deleted_at IS NULL",
        s.workspaceId,
      ),
    ).toBe(0);
  });

  it("creates an enabled nightly 03:00 consolidation routine in the workspace timezone and resumes it", async () => {
    const s = await setup();
    await db
      .prepare("UPDATE workspaces SET timezone = ? WHERE id = ?")
      .bind("Asia/Tokyo", s.workspaceId)
      .run();
    const { botId } = await s.ok({ type: "bot.create", name: "nightly" });
    const list = await (
      await s.user.get(`/v1/routines?workspaceId=${s.workspaceId}&botId=${botId as string}`)
    ).json<{ routines: Json[] }>();
    expect(list.routines).toEqual([
      expect.objectContaining({
        botId,
        name: "Nightly memory consolidation",
        inputText: "",
        jobKind: "consolidate",
        enabled: true,
        schedule: { kind: "cron", expr: "0 3 * * *", timezone: "Asia/Tokyo" },
      }),
    ]);
    const routineId = list.routines[0]!.id as string;

    expect(await s.ok({ type: "routine.pause", routineId })).toMatchObject({
      status: "accepted",
      routineId,
    });
    const paused = await (
      await s.user.get(`/v1/routines?workspaceId=${s.workspaceId}&botId=${botId as string}`)
    ).json<{ routines: Json[] }>();
    expect(paused.routines[0]).toMatchObject({ id: routineId, enabled: false });

    const resumed = await s.ok({ type: "routine.resume", routineId });
    expect(resumed).toMatchObject({
      status: "accepted",
      routineId,
      nextFireAt: expect.any(String),
    });
    const enabled = await (
      await s.user.get(`/v1/routines?workspaceId=${s.workspaceId}&botId=${botId as string}`)
    ).json<{ routines: Json[] }>();
    expect(enabled.routines[0]).toMatchObject({ id: routineId, enabled: true });
  });
});
