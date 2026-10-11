import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalStatus, ToolPolicy } from "@hive/contracts";
import { describe, expect, it } from "vitest";
import { codexAdapter, type SpawnFn } from "../src/adapters/codex.ts";
import type { LaunchContext } from "../src/runner.ts";
import { context, fakeRunApi } from "./helpers.ts";

const fake = join(import.meta.dirname, "fakeCodex.mjs");
/** Runs test/fakeCodex.mjs (the real spawn: process group, pipes, signals) with `scenario`; records the argv. */
const fakeSpawn = (scenario: string) => {
  const calls: { command: string; args: string[] }[] = [];
  const fn: SpawnFn = (command, args, options) => {
    calls.push({ command, args });
    return spawn(process.execPath, [fake, ...args], {
      ...options,
      env: { ...options.env, FAKE_CODEX: scenario },
    });
  };
  return { calls, fn };
};

type Line = {
  dir: string;
  msg?: { id?: unknown; method?: string; params?: any; result?: any; error?: any };
};
const transcriptOf = async (dir: string) =>
  (await readFile(join(dir, "transcripts", "run-1.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Line & Record<string, unknown>);

const launch = (overrides: Partial<LaunchContext> = {}, policy?: ToolPolicy): LaunchContext => ({
  runId: "run-1",
  jobId: "job-1",
  executionGeneration: 1,
  inboxItemId: "inbox-1",
  context: policy ? { ...context, bot: { ...context.bot, toolPolicy: policy } } : context,
  run: null,
  observe: async () => {},
  ...overrides,
});

const start = async (
  scenario: string,
  overrides: Partial<LaunchContext> = {},
  policy?: ToolPolicy,
) => {
  const dir = await mkdtemp(join(tmpdir(), "hive-codex-"));
  const { calls, fn } = fakeSpawn(scenario);
  const adapter = codexAdapter({ stateDir: dir, spawn: fn, approvalPollMs: 1, stopGraceMs: 200 });
  const agent = await adapter.start(launch(overrides, policy));
  return { dir, calls, agent, adapter };
};

const ask = (tool: "Bash" | "Edit"): ToolPolicy => ({
  tools: { [tool]: "ask" },
  cwdMode: "run_scratch",
});

describe("codexAdapter", () => {
  it("initializes, starts a thread and a turn, and exits with the final answer as reply", async () => {
    const seen: Line[][] = [];
    const { dir, calls, agent } = await start("happy", {
      observe: async (kind, payload) => {
        seen.push(await transcriptOf(dir));
        expect([kind, payload]).toEqual(["runtime.run.started", { providerSessionId: "thr-1" }]);
      },
    });
    expect(await agent.waitForExit()).toEqual({
      code: 0,
      reason: "exited",
      summary: "Hello, hive!",
      replyText: "Hello, hive!",
    });
    expect(calls).toEqual([{ command: "codex", args: ["app-server"] }]);

    const lines = await transcriptOf(dir);
    expect(lines[0]).toMatchObject({ dir: "local", event: "spawn", argv: ["app-server"] });
    expect(lines[0]!.pid).toEqual(expect.any(Number));
    const out = lines
      .filter((l) => l.dir === "out")
      .map((l) => l.msg!.method ?? `response ${l.msg!.id}`);
    expect(out).toEqual([
      "initialize",
      "initialized",
      "config/read",
      "thread/start",
      "turn/start",
      "response u1",
    ]);
    const threadStart = lines.find((l) => l.msg?.method === "thread/start")!.msg!.params;
    expect(threadStart).toMatchObject({
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      developerInstructions:
        "You are coder, a bot in a hive workspace.\n\nReply in one short sentence.",
      config: {
        mcp_servers: { figma: { enabled: false } },
        features: { hooks: false, apps: false },
      },
    });
    expect(threadStart.dynamicTools).toBeUndefined(); // no Run capability, no hive tools
    expect(lines.find((l) => l.msg?.method === "turn/start")!.msg!.params.input[0].text).toContain(
      "Say hello.",
    );
    // The user's Codex config never reaches the (uploaded) transcript: server names only.
    expect(lines.find((l) => l.dir === "in" && l.msg?.id === 1)!.msg!.result).toEqual({
      config: { mcp_servers: ["figma"] },
    });
    expect(JSON.stringify(lines)).not.toContain("secret-1");
    // An unsupported server request is answered with an error, never left hanging.
    expect(lines.find((l) => l.dir === "out" && l.msg?.id === "u1")!.msg!.error.code).toBe(-32601);
    // Journaled before processing: the thread/start response was on disk when the observation ran.
    expect(seen[0]!.some((l) => l.dir === "in" && l.msg?.result?.thread?.id === "thr-1")).toBe(
      true,
    );
    expect(lines.at(-1)).toMatchObject({ dir: "in", msg: { method: "turn/completed" } });
  });

  it("fails maintenance jobs explicitly before starting an app-server", async () => {
    const { calls, agent } = await start("happy", {
      context: {
        ...context,
        jobKind: "summarize",
        summarization: {
          conversationId: "conv-1",
          botId: "bot-1",
          coversFromSeq: 1,
          coversToSeq: 1,
          messages: [],
          previousSummary: null,
        },
      },
    });
    expect(await agent.waitForExit()).toEqual({
      code: 1,
      reason: "unsupported job kind: summarize",
      summary: "codex: maintenance jobs are unsupported",
    });
    expect(calls).toEqual([]);
  });

  it("reuses a transcript that already holds turn/completed without spawning", async () => {
    const { dir } = await start("happy").then(async (s) => (await s.agent.waitForExit(), s));
    const { calls, fn } = fakeSpawn("crash");
    const again = await codexAdapter({ stateDir: dir, spawn: fn }).start(launch());
    expect((await again.waitForExit()).replyText).toBe("Hello, hive!");
    expect(calls).toEqual([]);
  });

  it.each<[string, ApprovalStatus["state"][], string]>([
    ["approved", ["approved"], "accept"],
    ["denied", ["denied"], "decline"],
  ])("asks the cloud for a command approval (%s)", async (_, states, decision) => {
    const { api, calls } = fakeRunApi(undefined, [...states]);
    const { agent } = await start("command", { run: api }, ask("Bash"));
    expect((await agent.waitForExit()).replyText).toBe(`decision: ${decision}`);
    expect(calls[0]).toMatchObject({
      type: "approval.request",
      actionKind: "Bash",
      argsSummary: "touch a.txt",
      cwdLabel: "run_scratch",
    });
  });

  it("asks for a file change approval with its paths; outside the cwd is declined without asking", async () => {
    const { api, calls } = fakeRunApi(undefined, ["approved"]);
    const inside = await start("file", { run: api }, ask("Edit"));
    expect((await inside.agent.waitForExit()).replyText).toBe("decision: accept");
    expect(calls[0]).toMatchObject({ actionKind: "Edit", argsSummary: "<cwd>/b.txt" });

    const outside = fakeRunApi(undefined, ["approved"]);
    const run = await start("file-outside", { run: outside.api }, ask("Edit"));
    expect((await run.agent.waitForExit()).replyText).toBe("decision: decline");
    expect(outside.calls).toEqual([]);
  });

  it("declines a deny tool without the cloud", async () => {
    const { api, calls } = fakeRunApi(undefined, ["approved"]);
    const { agent } = await start(
      "command",
      { run: api },
      { tools: { Bash: "deny" }, cwdMode: "run_scratch" },
    );
    expect((await agent.waitForExit()).replyText).toBe("decision: decline");
    expect(calls).toEqual([]);
  });

  it("stops with turn/interrupt, then ends the process", async () => {
    const { dir, agent } = await start("stop");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await agent.requestStop("cancelled");
    expect(await agent.waitForExit()).toEqual({
      code: null,
      reason: "cancelled",
      summary: "codex: stopped",
    });
    const lines = await transcriptOf(dir);
    expect(lines.some((l) => l.dir === "out" && l.msg?.method === "turn/interrupt")).toBe(true);
    expect(lines.at(-1)).toMatchObject({
      msg: { method: "turn/completed", params: { turn: { status: "interrupted" } } },
    });
  });

  it("kills the process group when the turn ignores the interrupt", async () => {
    const { agent } = await start("stubborn");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await agent.requestStop("stale_generation");
    expect(await agent.waitForExit()).toEqual({
      code: null,
      reason: "stale_generation",
      summary: "codex: stopped",
    });
  });

  it("fails with a reason when the app-server dies mid-turn", async () => {
    const { agent } = await start("crash");
    expect(await agent.waitForExit()).toEqual({
      code: 1,
      reason: "codex app-server exited (code 3, signal null)",
      summary: "codex: failed",
    });
  });

  it("answers hive tools in-process and ends as waiting after hive_wait_for_reply", async () => {
    const { api } = fakeRunApi();
    const { dir, agent } = await start("wait", { run: api });
    expect(await agent.waitForExit()).toMatchObject({
      code: 0,
      reason: "waiting",
      waitingFor: { requestMessageId: "m-9" },
    });
    const lines = await transcriptOf(dir);
    const tools = lines.find((l) => l.msg?.method === "thread/start")!.msg!.params.dynamicTools;
    expect(tools.map((t: { name: string }) => t.name)).toContain("hive_wait_for_reply");
    expect(tools[0].inputSchema).toMatchObject({ type: "object" });
    expect(lines.find((l) => l.dir === "out" && l.msg?.id === "t1")!.msg!.result).toEqual({
      contentItems: [{ type: "inputText", text: '{"waiting":true}' }],
      success: true,
    });
    expect(lines.some((l) => l.dir === "out" && l.msg?.method === "turn/interrupt")).toBe(true);
  });
});
