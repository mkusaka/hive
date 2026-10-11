// Claude provider (docs/architecture.md §13.3, §20.4) over the Claude Agent SDK. Every SDK message is appended to
// `<state-dir>/transcripts/<runId>.jsonl` and fsynced before it is processed: the durable local journal outside
// the SDK config dir. Auth is whatever the SDK subprocess finds (it inherits `process.env`, so
// `CLAUDE_CONFIG_DIR` selects the login); never an automatic switch to an API key.
// Tools: the in-run hive tools (tools.ts, only with a Run capability) plus the native tools the Bot's tool policy
// allows or asks for (toolPolicy.ts: PreToolUse hook + `canUseTool` approval broker). The cwd is a per-run scratch
// directory, or the environment's checkout root from `<state-dir>/environments.json` (`cwdMode: environment`).
// `hive_wait_for_reply` ends the Run: once its tool result appears in the stream, the adapter aborts the query (no
// further model turn) and exits with `waitingFor`, which the runner submits as a `waiting` result (§8.2).
// With a `sessionStore` (sessionStore.ts) the SDK mirrors the native session to it, and a Run resumes the session an
// earlier Run of the Job left (`previousProviderSessionId`) only when the store can load it; otherwise it starts
// fresh. A `mirror_error` is journaled like every message and marks the exit summary degraded.
import { mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type Options,
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SessionStore,
} from "@anthropic-ai/claude-agent-sdk";
import type { BotSkill } from "@hive/contracts";
import { runCwd } from "../environments.ts";
import type { AgentAdapter, LaunchContext, RunningAgent } from "../runner.ts";
import { approvalGate, preToolUse, toolOptions, truncate } from "../toolPolicy.ts";
import { hiveMcpServer, hiveTools, toolName, waitForReplyTool } from "../tools.ts";

export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;
type Exit = Awaited<ReturnType<RunningAgent["waitForExit"]>>;

const kib8 = 8 * 1024;

const skillsPrompt = (skills: BotSkill[]) =>
  skills.length
    ? `Skills:\n${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}\n\n` +
      "Call hive_skill_use with a skill name to load its instructions."
    : "";

/** System prompt: who the Bot is plus its instructions and, for providers without native skills, skill discovery. */
export const systemPrompt = ({ bot }: LaunchContext["context"], includeSkills = false) =>
  [
    `You are ${bot.name}, a bot in a hive workspace.`,
    bot.instructions,
    ...(includeSkills ? [skillsPrompt(bot.skills ?? [])] : []),
  ]
    .filter(Boolean)
    .join("\n\n");

const nativeSkills = async (stateDir: string, runId: string, skills: BotSkill[]) => {
  const projectConfigRoot = join(stateDir, "runs", runId, "claude-config");
  await Promise.all(
    skills.map(async (skill) => {
      const path = join(
        projectConfigRoot,
        ".claude",
        "skills",
        `skill-${encodeURIComponent(skill.name)}`,
        "SKILL.md",
      );
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`,
      );
    }),
  );
  return {
    projectConfigRoot,
    names: skills.map((skill) => `skill-${encodeURIComponent(skill.name)}`),
  };
};

/** One conversation line of the prompt. */
const promptLine = (m: { actorKind: string; actorId: string; body: string }) =>
  `[${m.actorKind} ${m.actorId}] ${m.body}`;

const speaker = (m: { speakerKind: string; speakerName: string; isSelf: boolean }) =>
  `${m.speakerKind} ${m.speakerName}${m.isSelf ? " (you)" : ""}`;

/** The group chat rule every member Bot of a Channel gets (ROUTE-02). */
export const groupRule =
  "Reply only if this message is for you or you own the next step; otherwise pass (call hive_pass and end your " +
  "turn). Prefer a single owner. Do not repeat what a peer already said.";

/**
 * User message: Task, a thread's parent messages, recent conversation (oldest first), in a Channel the group block
 * (peers, messages since your last turn, the group rule), Memory, Related search hits, then the trigger item's body
 * (naming the sending Bot), the batch's items or a Delegation's instructions, then replies to this Job's earlier
 * requests.
 */
export const userPrompt = ({
  task,
  conversation,
  parentMessages,
  peers,
  since,
  inboxItem,
  batch,
  replies,
  memories,
  related,
  delegation,
}: LaunchContext["context"]) => {
  const parts: string[] = [];
  if (task) parts.push(`Task ${task.key}: ${task.title}\n${task.description}`.trim());
  if (conversation?.counterpart) {
    parts.push(`Direct message with user ${conversation.counterpart.name}.`);
  }
  if (parentMessages.length) {
    parts.push(
      `Earlier in the channel, before this thread (read-only context):\n${parentMessages.map(promptLine).join("\n")}`,
    );
  }
  if (conversation?.recent.length) {
    const lines = conversation.recent.map(promptLine);
    parts.push(
      `${conversation.kind === "thread" ? "Thread (root message first)" : "Recent conversation"}:\n${lines.join("\n")}`,
    );
  }
  if (conversation?.kind === "channel") {
    const lines = [
      "Group conversation. Every member Bot reads every post in this channel.",
      `Other member Bots:${peers.length ? "" : " none"}`,
      ...peers.map((p) => `- ${p.name}${p.description ? `: ${p.description}` : ""}`),
    ];
    if (since.length) {
      lines.push(
        "New since your last turn:",
        ...since.map(
          (m) =>
            `[${speaker(m)}]${m.replyTo ? ` (replying to ${speaker(m.replyTo)}: "${m.replyTo.quote}")` : ""} ${m.body}`,
        ),
      );
    }
    parts.push([...lines, groupRule].join("\n"));
  }
  if (memories.length) {
    parts.push(`Memory:\n${memories.map((m) => `- (${m.scopeKind}) ${m.content}`).join("\n")}`);
  }
  if (related.length) {
    const lines = related.map(
      (r) => `- (${r.sourceKind}) ${[r.title, r.snippet].filter(Boolean).join(": ")}`,
    );
    parts.push(`Related:\n${lines.join("\n")}`);
  }
  const request = batch
    ? batch.items.map((i, n) => `[${n + 1}] ${i.body}`).join("\n")
    : (delegation?.instructions ?? inboxItem?.body ?? "Work on the task above.");
  const from = delegation
    ? ` delegated by ${delegation.fromBot ? `bot ${delegation.fromBot.name}` : `user ${delegation.fromUser?.id}`}` +
      ` (${delegation.mode} access${delegation.deadline ? `, deadline ${delegation.deadline}` : ""})`
    : inboxItem?.fromBot
      ? ` from bot ${inboxItem.fromBot.name} (${inboxItem.kind})`
      : "";
  parts.push(`Request${from}:\n${request}`);
  if (replies.length) {
    const lines = replies.map((r) => `[bot ${r.fromBot.name}] ${r.body}`);
    parts.push(`Replies to your requests:\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
};

const toExit = (result: SDKResultMessage): Exit => {
  if (result.subtype === "success" && !result.is_error) {
    return {
      code: 0,
      reason: "exited",
      summary: truncate(result.result, kib8),
      replyText: result.result.slice(0, 64 * 1024),
    };
  }
  const detail = result.subtype === "success" ? result.result : result.errors.join("; ");
  return {
    code: 1,
    reason: truncate(`${result.subtype}: ${detail}`, kib8),
    summary: truncate(`claude: ${result.subtype}`, kib8),
  };
};

const readTranscript = async (path: string) => {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  // A torn last line never completed; skip it like the Local Journal does.
  return text.split("\n").flatMap((line) => {
    try {
      return line ? [JSON.parse(line) as SDKMessage] : [];
    } catch {
      return [];
    }
  });
};

/**
 * `start` is restart-safe for reconcile: a transcript that already holds a `result` is reused without calling
 * the SDK; one with a `system/init` resumes that session on this device; otherwise the run starts fresh.
 */
export const claudeAdapter = ({
  stateDir,
  queryFn = query,
  maxTurns = 4,
  approvalPollMs,
  sessionStore,
}: {
  stateDir: string;
  queryFn?: QueryFn;
  maxTurns?: number;
  approvalPollMs?: number;
  sessionStore?: SessionStore;
}): AgentAdapter & { describe(): Promise<Record<string, boolean>> } => ({
  // Honest flags for what this adapter does today (§20.4).
  describe: async () => ({
    resumeSameDevice: true,
    resumeOtherDevice: false,
    externalSessionStore: false,
    steerActiveTurn: false,
    nativeChildIdentity: false,
    enforceToolApproval: true,
  }),
  start: async (ctx) => {
    const transcript = join(stateDir, "transcripts", `${ctx.runId}.jsonl`);
    await mkdir(join(stateDir, "transcripts"), { recursive: true });

    const previous = await readTranscript(transcript);
    const done = previous.findLast((m): m is SDKResultMessage => m.type === "result");
    if (done) return { requestStop: async () => {}, waitForExit: async () => toExit(done) };
    // This Run restarted on this device: resume its own session (the SDK's local files are here).
    const restarted = previous.find((m) => m.type === "system" && m.subtype === "init")?.session_id;

    // Preflight: an environment run needs the environment's checkout on this device.
    const policy = ctx.context.bot.toolPolicy;
    const environment = ctx.context.environment;
    const cwd = await runCwd(stateDir, ctx.runId, ctx.context);
    if (!cwd) {
      const exit: Exit = {
        code: 1,
        reason: "environment_missing",
        summary: truncate(
          `claude: environment ${environment ?? "(none)"} is not on this device`,
          kib8,
        ),
      };
      return { requestStop: async () => {}, waitForExit: async () => exit };
    }
    const roots = [...new Set([cwd, await realpath(cwd)])];
    // An earlier Run's session, possibly from another device: only when the store holds it complete.
    const earlier = ctx.context.previousProviderSessionId;
    const loaded = earlier
      ? await sessionStore
          ?.load({ projectKey: cwd, sessionId: earlier })
          .catch((error: unknown) => {
            console.error(`loading session ${earlier} failed; starting fresh`, error);
            return null;
          })
      : null;
    const sessionId = restarted ?? (loaded?.length ? earlier! : undefined);
    const skillConfig = ctx.context.bot.skills?.length
      ? await nativeSkills(stateDir, ctx.runId, ctx.context.bot.skills)
      : undefined;
    const skillNames = skillConfig ? new Set(skillConfig.names) : undefined;
    let mirrorErrors = 0;

    const abort = new AbortController();
    let stopReason: string | undefined;
    // ponytail: a pass is known only in this process; a Run resumed from a finished transcript posts its text.
    let passed = false;
    const tools = ctx.run
      ? hiveTools(ctx.context, ctx.run, {
          signal: abort.signal,
          pollMs: approvalPollMs,
          onPass: () => (passed = true),
          skillUse: false,
        })
      : [];
    const hive = tools.map((t) => toolName(t.name));
    // tool_use id → requestMessageId of `hive_wait_for_reply` calls not yet answered.
    const waits = new Map<string, string>();
    let waitingFor: string | undefined;
    const waiting = (): Exit => ({
      code: 0,
      reason: "waiting",
      summary: truncate(`claude: waiting for the reply to ${waitingFor}`, kib8),
      waitingFor: { requestMessageId: waitingFor! },
    });
    const run = async (): Promise<Exit> => {
      const file = await open(transcript, "a");
      try {
        let result: SDKResultMessage | undefined;
        const messages = queryFn({
          prompt: restarted
            ? "Your previous attempt was interrupted. Give your final answer to the last request."
            : userPrompt(ctx.context),
          options: {
            cwd,
            abortController: abort,
            systemPrompt: systemPrompt(ctx.context),
            // Only generated per-Run project settings are loaded; user and checkout settings stay isolated.
            ...toolOptions(policy, hive, skillNames),
            hooks: {
              PreToolUse: [{ hooks: [preToolUse(policy, roots, new Set(hive), skillNames)] }],
            },
            canUseTool: approvalGate({
              policy,
              run: ctx.run,
              cwdLabel: policy.cwdMode === "environment" ? environment! : "run_scratch",
              roots,
              hiveTools: new Set(hive),
              pollMs: approvalPollMs,
              skillNames,
            }),
            settingSources: skillConfig ? ["project"] : [],
            ...(skillConfig
              ? { projectConfigRoot: skillConfig.projectConfigRoot, skills: skillConfig.names }
              : {}),
            mcpServers: tools.length ? { hive: hiveMcpServer(tools) } : {},
            strictMcpConfig: true,
            maxTurns,
            // Eager: each batch reaches the fsynced journal as it lands, not only at end of turn.
            ...(sessionStore ? { sessionStore, sessionStoreFlush: "eager" as const } : {}),
            ...(sessionId ? { resume: sessionId } : {}),
          },
        });
        for await (const message of messages) {
          await file.appendFile(`${JSON.stringify(message)}\n`);
          await file.datasync();
          if (message.type === "system" && message.subtype === "init") {
            // Losing the observation must not fail the Run; a stale generation surfaces on lease renewal.
            await ctx
              .observe("runtime.run.started", { providerSessionId: message.session_id })
              .catch((error: unknown) => console.error("runtime.run.started failed", error));
          }
          if (message.type === "system" && message.subtype === "mirror_error") {
            mirrorErrors++;
            console.error(`session mirror error for run ${ctx.runId}: ${message.error}`);
          }
          if (message.type === "result") result = message;
          if (message.type === "assistant") {
            for (const block of message.message.content) {
              if (block.type === "tool_use" && block.name === waitForReplyTool) {
                waits.set(block.id, (block.input as { requestMessageId: string }).requestMessageId);
              }
            }
          }
          if (message.type === "user" && Array.isArray(message.message.content)) {
            for (const block of message.message.content) {
              if (block.type === "tool_result" && !block.is_error && waits.has(block.tool_use_id)) {
                waitingFor = waits.get(block.tool_use_id);
              }
            }
          }
          if (waitingFor) {
            stopReason = "waiting";
            abort.abort();
            break;
          }
        }
        if (waitingFor) return waiting();
        if (result) return toExit(result);
        if (stopReason) return { code: null, reason: stopReason, summary: "claude: stopped" };
        return { code: 1, reason: "no result message", summary: "claude: no result" };
      } catch (error) {
        if (waitingFor) return waiting();
        if (stopReason) return { code: null, reason: stopReason, summary: "claude: stopped" };
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return { code: 1, reason: truncate(message, kib8), summary: "claude: failed" };
      } finally {
        await file.close();
      }
    };
    const exited = run()
      .then((exit) => ({ ...exit, ...(passed ? { pass: true } : {}) }))
      .then((exit) =>
        mirrorErrors
          ? {
              ...exit,
              summary: truncate(
                `${exit.summary}; session mirror degraded: ${mirrorErrors} mirror_error`,
                kib8,
              ),
            }
          : exit,
      );
    return {
      requestStop: async (reason) => {
        stopReason = reason;
        abort.abort();
      },
      waitForExit: () => exited,
    };
  },
});
