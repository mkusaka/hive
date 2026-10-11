// Claude provider (docs/architecture.md §13.3, §20.4) over the Claude Agent SDK. Every SDK message is appended to
// `<state-dir>/transcripts/<runId>.jsonl` and fsynced before it is processed: the durable local journal outside
// the SDK config dir. Auth is whatever the SDK subprocess finds (it inherits `process.env`, so
// `CLAUDE_CONFIG_DIR` selects the login); never an automatic switch to an API key.
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Options,
  query,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentAdapter, LaunchContext, RunningAgent } from "../runner.ts";

export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;
type Exit = Awaited<ReturnType<RunningAgent["waitForExit"]>>;

/** UTF-8 prefix of at most `max` bytes, cut on a code point boundary. */
const truncate = (text: string, max: number) => {
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    bytes += Buffer.byteLength(ch);
    if (bytes > max) break;
    out += ch;
  }
  return out;
};
const kib8 = 8 * 1024;

/** System prompt: who the Bot is plus its instructions. */
export const systemPrompt = ({ bot }: LaunchContext["context"]) =>
  [`You are ${bot.name}, a bot in a hive workspace.`, bot.instructions]
    .filter(Boolean)
    .join("\n\n");

/** User message: Task, recent conversation (oldest first), then the trigger item's body or the batch's items. */
export const userPrompt = ({ task, conversation, inboxItem, batch }: LaunchContext["context"]) => {
  const parts: string[] = [];
  if (task) parts.push(`Task ${task.key}: ${task.title}\n${task.description}`.trim());
  if (conversation?.recent.length) {
    const lines = conversation.recent.map((m) => `[${m.actorKind} ${m.actorId}] ${m.body}`);
    parts.push(`Recent conversation:\n${lines.join("\n")}`);
  }
  const request = batch
    ? batch.items.map((i, n) => `[${n + 1}] ${i.body}`).join("\n")
    : (inboxItem?.body ?? "Work on the task above.");
  parts.push(`Request:\n${request}`);
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
}: {
  stateDir: string;
  queryFn?: QueryFn;
  maxTurns?: number;
}): AgentAdapter & { describe(): Promise<Record<string, boolean>> } => ({
  // Honest flags for what this adapter does today (§20.4).
  describe: async () => ({
    resumeSameDevice: true,
    resumeOtherDevice: false,
    externalSessionStore: false,
    steerActiveTurn: false,
    nativeChildIdentity: false,
    enforceToolApproval: false,
  }),
  start: async (ctx) => {
    const transcript = join(stateDir, "transcripts", `${ctx.runId}.jsonl`);
    const cwd = join(stateDir, "runs", ctx.runId);
    await mkdir(join(stateDir, "transcripts"), { recursive: true });
    await mkdir(cwd, { recursive: true });

    const previous = await readTranscript(transcript);
    const done = previous.findLast((m): m is SDKResultMessage => m.type === "result");
    if (done) return { requestStop: async () => {}, waitForExit: async () => toExit(done) };
    const sessionId = previous.find((m) => m.type === "system" && m.subtype === "init")?.session_id;

    const abort = new AbortController();
    let stopReason: string | undefined;
    const run = async (): Promise<Exit> => {
      const file = await open(transcript, "a");
      try {
        let result: SDKResultMessage | undefined;
        const messages = queryFn({
          prompt: sessionId
            ? "Your previous attempt was interrupted. Give your final answer to the last request."
            : userPrompt(ctx.context),
          options: {
            cwd,
            abortController: abort,
            systemPrompt: systemPrompt(ctx.context),
            // No tools and no settings / MCP from the user's Claude config: a plain answering Bot.
            tools: [],
            allowedTools: [],
            permissionMode: "dontAsk",
            settingSources: [],
            mcpServers: {},
            strictMcpConfig: true,
            maxTurns,
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
          if (message.type === "result") result = message;
        }
        if (result) return toExit(result);
        if (stopReason) return { code: null, reason: stopReason, summary: "claude: stopped" };
        return { code: 1, reason: "no result message", summary: "claude: no result" };
      } catch (error) {
        if (stopReason) return { code: null, reason: stopReason, summary: "claude: stopped" };
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        return { code: 1, reason: truncate(message, kib8), summary: "claude: failed" };
      } finally {
        await file.close();
      }
    };
    const exited = run();
    return {
      requestStop: async (reason) => {
        stopReason = reason;
        abort.abort();
      },
      waitForExit: () => exited,
    };
  },
});
