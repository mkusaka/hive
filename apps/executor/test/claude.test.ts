import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultSuccess,
  SDKSystemMessage,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { claudeAdapter, type QueryFn, userPrompt } from "../src/adapters/claude.ts";
import { type JournalEntry, type LaunchContext, reconcile, runOnce } from "../src/runner.ts";
import { context, fakeCloud, fakeRunApi, memoryJournal } from "./helpers.ts";

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

/** A SessionStore whose `load` answers `entries`, recording the session ids asked for. */
const fakeStore = (entries: SessionStoreEntry[] | null) => {
  const loads: unknown[] = [];
  const store: SessionStore = {
    append: async () => {},
    load: async (key) => {
      loads.push(key.sessionId);
      return entries;
    },
  };
  return { store, loads };
};

const msg = (actorId: string, body: string) => ({
  actorKind: "user",
  actorId,
  body,
  createdAt: "",
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

  it("prompts a Channel Run with the group block: peers, messages since its last turn and the rule", () => {
    const prompt = userPrompt({
      ...context,
      peers: [{ id: "bot-2", name: "reviewer", description: "Reviews code." }],
      since: [
        {
          id: "m-1",
          speakerKind: "bot",
          speakerName: "reviewer",
          isSelf: false,
          body: "LGTM",
          createdAt: "",
          replyTo: { speakerKind: "human", speakerName: "Mina", isSelf: false, quote: "review?" },
        },
      ],
    });
    expect(prompt).toContain(
      "Other member Bots:\n- reviewer: Reviews code.\nNew since your last turn:\n" +
        '[bot reviewer] (replying to human Mina: "review?") LGTM\n' +
        "Reply only if this message is for you or you own the next step; otherwise pass",
    );
    // A DM has no group block.
    const dm = userPrompt({ ...context, conversation: { ...context.conversation!, kind: "dm" } });
    expect(dm).not.toContain("Group conversation");
  });

  it("materializes configured skills for the SDK's native main-session skills option", async () => {
    const dir = await stateDir();
    const skills: NonNullable<LaunchContext["context"]["bot"]["skills"]> = [
      {
        name: "release-notes",
        description: "Prepare concise release notes.",
        instructions: "Group changes by user impact.",
        tools: { tools: { Bash: "allow" }, cwdMode: "run_scratch" },
      },
    ];
    const { calls, queryFn } = fakeQuery([init, result()]);
    const { api } = fakeRunApi();
    const agent = await claudeAdapter({ stateDir: dir, queryFn }).start(
      launch({ context: { ...context, bot: { ...context.bot, skills } }, run: api }),
    );
    await agent.waitForExit();
    const options = calls[0]!.options;
    const configRoot = join(dir, "runs", "run-1", "claude-config");
    expect(options).toMatchObject({
      settingSources: ["project"],
      projectConfigRoot: configRoot,
      skills: ["skill-release-notes"],
    });
    expect(options.tools).toContain("Skill");
    expect(options.tools).not.toContain("Bash");
    expect(options.allowedTools).toContain("mcp__hive__hive_send_request");
    expect(options.allowedTools).not.toContain("mcp__hive__hive_skill_use");
    await expect(
      readFile(join(configRoot, ".claude", "skills", "skill-release-notes", "SKILL.md"), "utf8"),
    ).resolves.toContain("Group changes by user impact.");
  });
  it("prompts a thread Run with the parent's messages before the root, then the thread", () => {
    const prompt = userPrompt({
      ...context,
      conversation: {
        ...context.conversation!,
        kind: "thread",
        recent: [msg("a1", "root"), msg("a2", "reply")],
      },
      parentMessages: [msg("a3", "before")],
    });
    expect(prompt).toContain(
      "Earlier in the channel, before this thread (read-only context):\n[user a3] before\n\n" +
        "Thread (root message first):\n[user a1] root\n[user a2] reply",
    );
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

  describe("session store", () => {
    const earlier = "66666666-6666-4666-8666-666666666666";
    const withEarlier = launch({ context: { ...context, previousProviderSessionId: earlier } });

    it("resumes an earlier Run's session only when the store can load it", async () => {
      const dir = await stateDir();
      const { store, loads } = fakeStore([{ type: "user", uuid: "u1" }]);
      const { calls, queryFn } = fakeQuery([init, result()]);
      await (
        await claudeAdapter({ stateDir: dir, queryFn, sessionStore: store }).start(withEarlier)
      ).waitForExit();
      expect(loads).toEqual([earlier]);
      expect(calls[0]?.options).toMatchObject({
        resume: earlier,
        sessionStore: store,
        sessionStoreFlush: "eager",
      });
      // A successor gets the request again (with any replies), not the restart prompt.
      expect(calls[0]?.prompt).toContain("Request:\nSay hello.");
    });

    it.each([null, []])("starts fresh when the store loads %j", async (missing) => {
      const { calls, queryFn } = fakeQuery([init, result()]);
      const exit = await (
        await claudeAdapter({
          stateDir: await stateDir(),
          queryFn,
          sessionStore: fakeStore(missing).store,
        }).start(withEarlier)
      ).waitForExit();
      expect(exit.code).toBe(0);
      expect(calls[0]?.options.resume).toBeUndefined();
    });

    it("marks the exit summary degraded on mirror_error and journals it", async () => {
      const dir = await stateDir();
      const mirrorError = {
        type: "system",
        subtype: "mirror_error",
        error: "ENOSPC",
        key: { projectKey: "p", sessionId },
        uuid: "77777777-7777-4777-8777-777777777777",
        session_id: sessionId,
      } as SDKMessage;
      const exit = await (
        await claudeAdapter({
          stateDir: dir,
          queryFn: fakeQuery([init, mirrorError, mirrorError, result()]).queryFn,
          sessionStore: fakeStore(null).store,
        }).start(launch())
      ).waitForExit();
      expect(exit).toMatchObject({
        code: 0,
        summary: "Hello, hive!; session mirror degraded: 2 mirror_error",
      });
      expect(await transcriptOf(dir)).toContainEqual(mirrorError);
    });
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
