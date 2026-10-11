// message.post: one channel message, one waking delivery per `<@bot:ID>` mention (MENTION-01; ROUTE-02 in group.test.ts).
import { describe, expect, it } from "vitest";
import { claim, count, envelope, executor, type Json, setup } from "./helpers.ts";

const posted = async () => {
  const s = await setup();
  const { botId: reviewerId } = await s.ok({ type: "bot.create", name: "reviewer" });
  const post = (text: string, mentions?: string[]) =>
    envelope(s.workspaceId, {
      type: "message.post",
      channelId: s.channelId,
      text,
      ...(mentions ? { mentions } : {}),
    });
  return { ...s, reviewerId: reviewerId as string, post };
};

describe("message.post", () => {
  it("delivers to each mentioned Bot once and the pump queues one Job per Bot", async () => {
    const s = await posted();
    const text = `<@bot:${s.botId}> <@bot:${s.reviewerId}> say hi, <@bot:${s.botId}>`;
    const request = s.post(text, [s.reviewerId, s.botId]);
    const res = await s.user.command(request);
    expect(res.status).toBe(200);
    const body = await res.json<{ messageId: string; inboxItemIds: string[] }>();
    expect(body.inboxItemIds).toHaveLength(2);
    expect(await count("messages WHERE id = ? AND body = ?", body.messageId, text)).toBe(1);
    expect(
      await count(
        "inbox_items WHERE id IN (?, ?) AND purpose = 'agent.send' AND delivery_mode = 'wake'",
        ...body.inboxItemIds,
      ),
    ).toBe(2);

    await s.pump();
    const op = await (await s.user.get(`/v1/operations/${request.operationId}`)).json<Json>();
    expect(op.routingStatus).toBe("routed");
    const jobIds = op.jobIds as string[];
    expect(jobIds).toHaveLength(2);
    const bots = await Promise.all(
      jobIds.map(async (id) => (await (await s.user.get(`/v1/jobs/${id}`)).json<Json>()).botId),
    );
    expect(bots).toEqual([s.botId, s.reviewerId]);

    // The Run reads names, not tokens.
    const device = executor(s.deviceToken, s.workspaceId);
    const run = await (await device.command(claim(jobIds[0]!))).json<Json>();
    const context = await (
      await device.get(
        `/v1/executor/jobs/${jobIds[0]}/context?runId=${run.runId}&executionGeneration=${run.executionGeneration}`,
      )
    ).json<{ inboxItem: { body: string }; conversation: { recent: { body: string }[] } }>();
    expect(context.inboxItem.body).toBe("@coder @reviewer say hi, @coder");
    expect(context.conversation.recent.at(-1)!.body).toBe("@coder @reviewer say hi, @coder");
  });

  it("only posts a message in a channel with no member Bots", async () => {
    const s = await posted();
    const request = s.post("no mention here");
    const res = await s.user.command(request);
    expect(res.status).toBe(200);
    const body = await res.json<{ messageId: string; inboxItemIds: string[] }>();
    expect(body.inboxItemIds).toEqual([]);
    expect(await count("messages WHERE id = ?", body.messageId)).toBe(1);
    expect(await count("inbox_items WHERE workspace_id = ?", s.workspaceId)).toBe(0);
    expect(await count("events WHERE subject_id = ?", body.messageId)).toBe(0);
    const op = await (await s.user.get(`/v1/operations/${request.operationId}`)).json<Json>();
    expect(op).toMatchObject({ routingStatus: "routed", jobIds: [] });
  });

  it("rejects a token naming no Bot of the Workspace, and mentions that differ from the tokens", async () => {
    const s = await posted();
    const unknown = await s.user.command(s.post(`<@bot:${s.botId}> <@bot:nope> hi`));
    expect(unknown.status).toBe(422);
    expect(await unknown.json<Json>()).toMatchObject({ code: "INVALID_INPUT" });
    const mismatch = await s.user.command(s.post(`<@bot:${s.botId}> hi`, [s.reviewerId]));
    expect(mismatch.status).toBe(422);
    expect(
      await count(
        "messages WHERE conversation_id IN (SELECT id FROM conversations WHERE channel_id = ?)",
        s.channelId,
      ),
    ).toBe(0);
  });
});
