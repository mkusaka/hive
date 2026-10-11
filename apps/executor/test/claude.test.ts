import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultSuccess,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { claudeAdapter, type QueryFn } from "../src/adapters/claude.ts";
import { type JournalEntry, type LaunchContext, reconcile, runOnce } from "../src/runner.ts";
import { context, fakeCloud, memoryJournal } from "./helpers.ts";

// Fake SDK stream: the fields the adapter reads, shaped like the real 0.3.x message types.
const sessionId = "11111111-1111-4111-8111-111111111111";
const init = {
  type: "system",
  subtype: "init",
  session_id: sessionId,
  apiKeySource: "none",
  tools: [],
  model: "claude-test",
} as Partial<SDKSystemMessage> as SDKMessage;
const assistant = {
  type: "assistant",
  session_id: sessionId,
  parent_tool_use_id: null,
  message: { role: "assistant", content: [{ type: "text", text: "Hello, hive!" }] },
} as Partial<SDKAssistantMessage> as SDKMessage;
const result = (text = "Hello, hive!", isError = false) =>
  ({
    type: "result",
    subtype: "success",
    is_error: isError,
    result: text,
    session_id: sessionId,
    num_turns: 1,
  }) as Partial<SDKResultSuccess> as SDKMessage;

const stateDir = () => mkdtemp(join(tmpdir(), "hive-claude-"));
const transcriptOf = async (dir: string, runId = "run-1") =>
  (await readFile(join(dir, "transcripts", `${runId}.jsonl`), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SDKMessage);

/** Records each call's params and replays `messages`. */
const fakeQuery = (messages: SDKMessage[]) => {
  const calls: { prompt: string; options: Options }[] = [];
  const queryFn: QueryFn = async function* (params) {
    calls.push(params);
    yield* messages;
  };
  return { calls, queryFn };
};

const journalTranscript = async (dir: string, messages: SDKMessage[]) => {
  await mkdir(join(dir, "transcripts"), { recursive: true });
  await writeFile(
    join(dir, "transcripts", "run-1.jsonl"),
    messages.map((m) => `${JSON.stringify(m)}\n`).join(""),
  );
};
const unreachable: QueryFn = () => {
  throw new Error("SDK must not be called");
};

const launch = (overrides: Partial<LaunchContext> = {}): LaunchContext => ({
  runId: "run-1",
  jobId: "job-1",
  executionGeneration: 1,
  inboxItemId: "inbox-1",
  context,
  run: null,
  observe: async () => {},
  ...overrides,
});

describe("claudeAdapter", () => {
  it("runs a Claude turn: observation, transcript, summary and Bot reply", async () => {
    const dir = await stateDir();
    const { cloud, submitted, observed } = fakeCloud();
    const { calls, queryFn } = fakeQuery([init, assistant, result()]);

    const run = await runOnce({
      cloud,
      journal: memoryJournal(),
      adapter: claudeAdapter({ stateDir: dir, queryFn }),
    });

    expect(run?.state).toBe("succeeded");
    expect(observed).toEqual([
      {
        runId: "run-1",
        executionGeneration: 1,
        kind: "runtime.run.started",
        payload: { providerSessionId: sessionId },
      },
    ]);
    expect(submitted).toEqual([
      {
        runId: "run-1",
        executionGeneration: 1,
        state: "succeeded",
        summary: "Hello, hive!",
        reply: { conversationId: "conv-1", text: "Hello, hive!" },
      },
    ]);
    expect(await transcriptOf(dir)).toEqual([init, assistant, result()]);
    // Instructions go to the system prompt; the request and recent conversation to the user message. No tools.
    const [{ prompt, options }] = calls as [(typeof calls)[number]];
    expect(options.systemPrompt).toContain("Reply in one short sentence.");
    expect(prompt).toContain("Request:\nSay hello.");
    expect(prompt).toContain("[user actor-1] Say hello.");
    expect(options).toMatchObject({
      // The default policy: no native tool exists, every one is disallowed too.
      tools: [],
      allowedTools: [],
      disallowedTools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
      permissionMode: "default",
      settingSources: [],
      cwd: join(dir, "runs", "run-1"),
    });
    expect(options.resume).toBeUndefined();
  });

  it("journals each message before processing it", async () => {
    const dir = await stateDir();
    const seen: SDKMessage[][] = [];
    const agent = await claudeAdapter({
      stateDir: dir,
      queryFn: fakeQuery([init, result()]).queryFn,
    }).start(launch({ observe: async () => void seen.push(await transcriptOf(dir)) }));
    await agent.waitForExit();
    expect(seen).toEqual([[init]]);
  });

  it("fails without a reply on an error result", async () => {
    const dir = await stateDir();
    const queryFn = fakeQuery([init, result("authentication_failed", true)]).queryFn;
    const exit = await (
      await claudeAdapter({ stateDir: dir, queryFn }).start(launch())
    ).waitForExit();
    expect(exit).toEqual({
      code: 1,
      reason: "success: authentication_failed",
      summary: "claude: success",
    });
  });

  it("aborts the SDK query on requestStop", async () => {
    const dir = await stateDir();
    let signal: AbortSignal | undefined;
    const queryFn: QueryFn = async function* ({ options }) {
      signal = options.abortController!.signal;
      // Listen before yielding: an abort that lands first must still be observed.
      const aborted = new Promise((_, reject) =>
        signal!.addEventListener("abort", () => reject(new Error("aborted"))),
      );
      aborted.catch(() => undefined); // handled by the await below, or superseded by the throw
      yield init;
      if (signal.aborted) throw new Error("aborted");
      await aborted;
    };
    const agent = await claudeAdapter({ stateDir: dir, queryFn }).start(launch());
    await new Promise((resolve) => setTimeout(resolve, 10));
    await agent.requestStop("stale_generation");
    expect(await agent.waitForExit()).toEqual({
      code: null,
      reason: "stale_generation",
      summary: "claude: stopped",
    });
    expect(signal?.aborted).toBe(true);
  });

  describe("reconcile", () => {
    const claimed: JournalEntry = {
      kind: "claim",
      runId: "run-1",
      jobId: "job-1",
      executionGeneration: 1,
      inboxItemId: "inbox-1",
    };
    it("reuses a journaled result instead of calling the SDK again", async () => {
      const dir = await stateDir();
      await journalTranscript(dir, [init, result("Already answered.")]);
      const { cloud, submitted } = fakeCloud();
      const resumed = await reconcile({
        cloud,
        journal: memoryJournal([claimed, { kind: "intent", runId: "run-1" }]),
        adapter: claudeAdapter({ stateDir: dir, queryFn: unreachable }),
      });
      expect(resumed).toEqual([{ runId: "run-1", jobId: "job-1", state: "succeeded" }]);
      expect(submitted).toEqual([
        expect.objectContaining({
          summary: "Already answered.",
          reply: { conversationId: "conv-1", text: "Already answered." },
        }),
      ]);
    });

    it("resumes the journaled session when the run was interrupted mid-turn", async () => {
      const dir = await stateDir();
      await journalTranscript(dir, [init]);
      const { cloud, submitted } = fakeCloud();
      const { calls, queryFn } = fakeQuery([init, result()]);
      await reconcile({
        cloud,
        journal: memoryJournal([claimed]),
        adapter: claudeAdapter({ stateDir: dir, queryFn }),
      });
      expect(calls[0]?.options.resume).toBe(sessionId);
      expect(submitted).toEqual([expect.objectContaining({ state: "succeeded" })]);
    });
  });
});
