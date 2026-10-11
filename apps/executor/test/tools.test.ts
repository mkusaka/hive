import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunContext } from "@hive/contracts";
import { describe, expect, it } from "vitest";
import { claudeAdapter, type QueryFn } from "../src/adapters/claude.ts";
import { CloudError, createCloudClient } from "../src/cloudClient.ts";
import { runOnce } from "../src/runner.ts";
import { hiveTools } from "../src/tools.ts";
import { context, fakeCloud, fakeRunApi, memoryJournal } from "./helpers.ts";

const handler = (tools: ReturnType<typeof hiveTools>, name: string) => {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return (args: Record<string, unknown>) => found.handler(args as never, {});
};
const textOf = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((c) => c.text).join("");

const fromBot: RunContext = {
  ...context,
  inboxItem: {
    id: "inbox-2",
    body: "what is 2+2?",
    messageId: "req-1",
    kind: "request",
    fromBot: { id: "bot-a", name: "asker" },
  },
};

const names = (ctx: RunContext) => hiveTools(ctx, fakeRunApi().api).map((t) => t.name);

describe("hive tools", () => {
  it("call /v1/run/commands with the capability, never the device token", async () => {
    const requests: { url: string; auth: string | null; body: unknown }[] = [];
    const cloud = createCloudClient({
      apiUrl: "http://cloud.test",
      token: "device-1.device-secret",
      fetch: async (url, init) => {
        const auth = new Headers(init.headers).get("Authorization");
        requests.push({
          url: url.pathname,
          auth,
          body: init.body ? JSON.parse(init.body as string) : null,
        });
        const body = url.pathname.endsWith("/me")
          ? { workspaceIds: ["ws-1"] }
          : { status: "accepted", messageId: "m-1" };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
    const tools = hiveTools(context, cloud.forRun("cap.run-1.secret"));
    const result = await handler(tools, "hive_send_request")({ botName: "helper", text: "2+2?" });

    expect(textOf(result)).toContain('"messageId":"m-1"');
    const sent = requests.find((r) => r.url === "/v1/run/commands")!;
    expect(sent.auth).toBe("Bearer cap.run-1.secret");
    expect(sent.body).toMatchObject({
      workspaceId: "ws-1",
      command: {
        type: "agent.send",
        recipientBotName: "helper",
        message: { kind: "request", text: "2+2?" },
      },
    });
  });

  it("returns cloud errors and bad input to the model as tool text", async () => {
    const { api } = fakeRunApi(
      new CloudError(422, "INVALID_INPUT", "bot-to-bot chain exceeds 4 hops", "hop_limit"),
    );
    const tools = hiveTools(context, api);
    const failed = await handler(tools, "hive_send_request")({ botId: "b", text: "x" });
    expect(failed).toMatchObject({ isError: true });
    expect(textOf(failed)).toBe(
      "hive error: INVALID_INPUT (hop_limit): bot-to-bot chain exceeds 4 hops",
    );
    const both = await handler(tools, "hive_notify")({ botId: "b", botName: "c", text: "x" });
    expect(both).toMatchObject({ isError: true });
  });

  it("offers hive_reply only for a request from another Bot, and task tools only for a Task", async () => {
    expect(names(context)).toEqual(["hive_send_request", "hive_notify", "hive_wait_for_reply"]);
    expect(names(fromBot)).toContain("hive_reply");

    const { api, calls } = fakeRunApi();
    await handler(hiveTools(fromBot, api), "hive_reply")({ text: "4" });
    expect(calls).toEqual([{ type: "agent.reply", requestMessageId: "req-1", text: "4" }]);

    const withTask = {
      ...context,
      task: { id: "task-1", key: "APP-1", title: "t", description: "" },
    };
    const task = fakeRunApi();
    const tools = hiveTools(withTask, task.api);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["hive_task_get", "hive_task_update"]),
    );
    await handler(tools, "hive_task_update")({ status: "completed" });
    expect(task.calls).toEqual([
      { getTask: "task-1" },
      { type: "task.complete", taskId: "task-1", expectedRevision: 3 },
    ]);
  });
});

// hive_send_request then hive_wait_for_reply, then a turn that must never be consumed.
const sessionId = "22222222-2222-4222-8222-222222222222";
const stream = [
  { type: "system", subtype: "init", session_id: sessionId, apiKeySource: "none", tools: [] },
  {
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tu-1",
          name: "mcp__hive__hive_wait_for_reply",
          input: { requestMessageId: "req-9" },
        },
      ],
    },
  },
  {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: [{ type: "text", text: '{"waiting":true}' }],
        },
      ],
    },
  },
  {
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text: "should not happen" }] },
  },
] as unknown as SDKMessage[];

describe("claudeAdapter with hive tools", () => {
  it("ends the Run as waiting after hive_wait_for_reply; the token is in no prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hive-tools-"));
    const calls: { prompt: string; options: Options }[] = [];
    let consumed = 0;
    const queryFn: QueryFn = async function* (params) {
      calls.push(params);
      for (const message of stream) {
        consumed += 1;
        yield message;
      }
    };
    const { cloud, submitted } = fakeCloud({
      claim: async () => ({
        runId: "run-1",
        executionId: "exec-1",
        executionGeneration: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        capability: { token: "cap.run-1.TOPSECRET", expiresAt: "" },
        job: { id: "job-1", botId: "bot-1", inboxItemId: "inbox-1", placement: {} as never },
      }),
    });

    const run = await runOnce({
      cloud,
      journal: memoryJournal(),
      adapter: claudeAdapter({ stateDir: dir, queryFn }),
    });

    expect(run?.state).toBe("waiting");
    expect(submitted).toEqual([
      {
        runId: "run-1",
        executionGeneration: 1,
        state: "waiting",
        waitingFor: { requestMessageId: "req-9" },
        summary: "claude: waiting for the reply to req-9",
      },
    ]);
    // Stopped right after the tool result: the next turn was never read nor journaled.
    expect(consumed).toBe(3);
    const transcript = await readFile(join(dir, "transcripts", "run-1.jsonl"), "utf8");
    expect(transcript.trim().split("\n")).toHaveLength(3);
    const [{ prompt, options }] = calls as [(typeof calls)[number]];
    expect(options.abortController?.signal.aborted).toBe(true);
    expect(options.allowedTools).toEqual([
      "mcp__hive__hive_send_request",
      "mcp__hive__hive_notify",
      "mcp__hive__hive_wait_for_reply",
    ]);
    expect(options).toMatchObject({ tools: [], permissionMode: "dontAsk", strictMcpConfig: true });
    expect(Object.keys(options.mcpServers ?? {})).toEqual(["hive"]);
    expect(`${prompt}\n${String(options.systemPrompt)}`).not.toContain("TOPSECRET");
  });

  it("puts the sender Bot and earlier replies in the prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hive-tools-"));
    const calls: { prompt: string }[] = [];
    const queryFn: QueryFn = async function* (params) {
      calls.push(params);
      yield* [] as SDKMessage[];
    };
    const agent = await claudeAdapter({ stateDir: dir, queryFn }).start({
      runId: "run-2",
      jobId: "job-2",
      executionGeneration: 1,
      inboxItemId: "inbox-2",
      context: {
        ...fromBot,
        replies: [
          {
            messageId: "r-1",
            requestMessageId: "q-1",
            fromBot: { id: "bot-c", name: "math" },
            body: "4",
            createdAt: "",
          },
        ],
      },
      run: null,
      observe: async () => {},
    });
    await agent.waitForExit();
    expect(calls[0]!.prompt).toContain("Request from bot asker (request):\nwhat is 2+2?");
    expect(calls[0]!.prompt).toContain("Replies to your requests:\n[bot math] 4");
  });
});
