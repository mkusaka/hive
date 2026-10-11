// Phase 1 completion (docs/roadmap.md §7): CLI → Cloud → PC → Cloud result, through the CLI's command
// functions with `fetch` backed by the Hono app.
import { createClient } from "@hive/cli/client";
import * as hive from "@hive/cli/commands";
import { fakeAdapter } from "@hive/executor/adapters/fake";
import { createCloudClient } from "@hive/executor/cloudClient";
import { type JournalEntry, runOnce } from "@hive/executor/runner";
import { expect, it } from "vitest";
import { assertion, call, request as fetch } from "./helpers.ts";
const apiUrl = "https://hive.test";

it("workspace → device → channel → bot → agent send → executor → job succeeded", async () => {
  const client = createClient({ apiUrl, accessJwt: await assertion(crypto.randomUUID()), fetch });
  const workspaceId = crypto.randomUUID();
  const envelope = () => ({
    operationId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    workspaceId,
  });

  await hive.workspaceCreate(client, envelope(), "home");
  const { deviceToken } = await hive.deviceRegister(client, envelope(), {
    name: "pc1",
    os: "darwin",
    agentVersion: "0.0.0",
  });
  const { channelId } = await hive.channelCreate(client, envelope(), "dev");
  const { botId } = await hive.botCreate(client, envelope(), "coder");
  const send = envelope();
  const accepted = await hive.agentSend(client, send, {
    botId: botId as string,
    channelId: channelId as string,
    text: "check PR #123",
    notify: false,
  });
  expect(accepted).toMatchObject({ status: "accepted", jobId: null });

  // The PC: pump the outbox (no Queue consumer yet), then one runner poll.
  const token = deviceToken as string;
  expect((await call("/v1/executor/pump", { Authorization: `Bearer ${token}` }, {})).status).toBe(
    200,
  );
  const entries: JournalEntry[] = [];
  const ran = await runOnce({
    cloud: createCloudClient({ apiUrl, token, fetch }),
    journal: { append: async (e) => void entries.push(e), readAll: async () => entries },
    adapter: fakeAdapter({ delayMs: 10 }),
  });
  expect(ran).toMatchObject({ state: "succeeded" });

  const job = await hive.waitForOperationJob(client, send.operationId, {
    deadline: Date.now() + 5_000,
    pollMs: 10,
  });
  expect(job).toMatchObject({ id: ran!.jobId, botId, state: "succeeded" });
  expect(await hive.getJob(client, ran!.jobId)).toEqual(job);
  const inbox = await hive.listInbox(client, botId as string);
  expect(inbox.items).toEqual([
    expect.objectContaining({ id: accepted.inboxItemId, state: "processed" }),
  ]);
});
