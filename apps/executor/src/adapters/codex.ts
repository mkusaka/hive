// Codex provider (docs/architecture.md §13.4, §20.2, §20.4) over `codex app-server` on stdio (protocol: see
// codexProtocol.ts). One app-server process per Run: initialize → config/read → thread/start → one turn/start, then
// notifications until `turn/completed`. Every inbound and outbound protocol message is appended to
// `<state-dir>/transcripts/<runId>.jsonl` as `{dir: "in" | "out", msg}` (the user's config and credit balance
// redacted, see `journaled`) and fsynced before it is processed or sent;
// `{dir: "local", event: "spawn", pid, spawnedAt}` records the process (§20.2). Auth is the Codex login the process
// finds (`CODEX_HOME`, inherited from `process.env`); hive passes no credentials.
// Tool policy: the thread runs with `approvalPolicy: "untrusted"` and a read-only sandbox, so every command Codex
// does not consider safe and every file change becomes an approval request, answered by the same approval gate as the
// Claude adapter (command → `Bash`, file change → `Edit`). Codex may still run a command it classifies as safe
// without asking, even when Bash is `deny`. The hive tools are experimental `dynamicTools`
// answered in this process (the Run capability never leaves it). The user's MCP servers, hooks, apps, plugins,
// sub-agents and memories are switched off per thread.
import { type ChildProcess, type SpawnOptions, spawn as nodeSpawn } from "node:child_process";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { runCwd } from "../environments.ts";
import type { AgentAdapter, RunningAgent } from "../runner.ts";
import { approvalGate, outsidePath, truncate } from "../toolPolicy.ts";
import { hiveTools } from "../tools.ts";
import { systemPrompt, userPrompt } from "./claude.ts";
import type {
  ApprovalDecision,
  CommandApprovalParams,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  FileChangeApprovalParams,
  InitializeParams,
  ItemNotification,
  RequestId,
  RpcMessage,
  RpcRequest,
  RpcResponse,
  ThreadItem,
  ThreadStartParams,
  ThreadStartResponse,
  Turn,
  TurnCompletedNotification,
  TurnStartParams,
  TurnStartResponse,
} from "./codexProtocol.ts";

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
type Exit = Awaited<ReturnType<RunningAgent["waitForExit"]>>;
type Line =
  | { dir: "in" | "out"; msg: RpcMessage }
  | { dir: "local"; event: string; [key: string]: unknown };

const kib8 = 8 * 1024;
const waitTool = "hive_wait_for_reply";

/** Per-thread `config.toml` overrides: nothing from the user's Codex setup beyond auth and model defaults. */
const isolation = (mcpServers: string[]) => ({
  mcp_servers: Object.fromEntries(mcpServers.map((name) => [name, { enabled: false }])),
  features: {
    hooks: false,
    apps: false,
    plugins: false,
    multi_agent: false,
    computer_use: false,
    browser_use: false,
    memories: false,
  },
});

type AgentMessage = Extract<ThreadItem, { type: "agentMessage" }>;

/** The turn's final answer (else its last agent message, else the last one seen in the stream) as reply. */
const turnExit = (turn: Turn, lastMessage?: string): Exit => {
  if (turn.status !== "completed") {
    return {
      code: 1,
      reason: truncate(`${turn.status}: ${turn.error?.message ?? "no error message"}`, kib8),
      summary: `codex: turn ${turn.status}`,
    };
  }
  const messages = turn.items.filter((i): i is AgentMessage => i.type === "agentMessage");
  const text =
    (messages.findLast((m) => m.phase === "final_answer") ?? messages.at(-1))?.text ??
    lastMessage ??
    "";
  return {
    code: 0,
    reason: "exited",
    summary: truncate(text || "codex: no final message", kib8),
    ...(text ? { replyText: text.slice(0, 64 * 1024) } : {}),
  };
};

const toolReply = (text: string, success: boolean): DynamicToolCallResponse => ({
  contentItems: [{ type: "inputText", text }],
  success,
});

const waitingExit = (requestMessageId: string): Exit => ({
  code: 0,
  reason: "waiting",
  summary: truncate(`codex: waiting for the reply to ${requestMessageId}`, kib8),
  waitingFor: { requestMessageId },
});

const readTranscript = async (path: string) => {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  // A torn last line never completed; skip it like the Local Journal does.
  return text.split("\n").flatMap((line) => {
    try {
      return line ? [JSON.parse(line) as Line] : [];
    } catch {
      return [];
    }
  });
};

/**
 * What the transcript keeps of an inbound message (it is uploaded): the `config/read` result is the user's whole
 * Codex config (MCP server env, headers, ...), so only the MCP server names stay; rate-limit updates carry the
 * account's credit balance and are kept without params.
 */
const journaled = (msg: RpcMessage, configReadId: RequestId | undefined): RpcMessage => {
  if (!("method" in msg) && msg.id === configReadId && msg.result) {
    const servers = (msg.result as { config?: { mcp_servers?: Record<string, unknown> } }).config
      ?.mcp_servers;
    return { id: msg.id, result: { config: { mcp_servers: Object.keys(servers ?? {}) } } };
  }
  if ("method" in msg && msg.method === "account/rateLimits/updated") {
    return { method: msg.method, params: "[redacted]" };
  }
  return msg;
};

const isMethod = (line: Line, dir: "in" | "out", method: string) =>
  line.dir === dir && "method" in line.msg && line.msg.method === method;

/**
 * `start` is restart-safe for reconcile: a transcript that already holds `turn/completed` is reused without spawning;
 * otherwise a fresh app-server and thread are started (no same-device thread resume yet).
 */
export const codexAdapter = ({
  stateDir,
  spawn = nodeSpawn,
  binary = "codex",
  approvalPollMs,
  stopGraceMs = 5000,
}: {
  stateDir: string;
  spawn?: SpawnFn;
  binary?: string;
  approvalPollMs?: number;
  /** How long a stop waits for the turn to end (and the process to exit) before SIGTERM, then SIGKILL. */
  stopGraceMs?: number;
}): AgentAdapter & { describe(): Promise<Record<string, boolean>> } => ({
  // Honest flags (§20.4): approvals are enforced except for Codex's safe read-only commands.
  describe: async () => ({
    resumeSameDevice: false,
    resumeOtherDevice: false,
    externalSessionStore: false,
    steerActiveTurn: false,
    nativeChildIdentity: false,
    enforceToolApproval: false,
  }),
  start: async (ctx) => {
    const transcript = join(stateDir, "transcripts", `${ctx.runId}.jsonl`);
    await mkdir(join(stateDir, "transcripts"), { recursive: true });

    const previous = await readTranscript(transcript);
    const done = previous.findLast((l) => isMethod(l, "in", "turn/completed"));
    if (done && done.dir === "in") {
      const waited = previous.findLast((l) => l.dir === "local" && l.event === "waiting");
      const exit =
        waited?.dir === "local"
          ? waitingExit(String(waited.requestMessageId))
          : turnExit(((done.msg as RpcRequest).params as TurnCompletedNotification).turn);
      return { requestStop: async () => {}, waitForExit: async () => exit };
    }

    const policy = ctx.context.bot.toolPolicy;
    const environment = ctx.context.environment;
    const cwd = await runCwd(stateDir, ctx.runId, ctx.context);
    if (!cwd) {
      const exit: Exit = {
        code: 1,
        reason: "environment_missing",
        summary: truncate(
          `codex: environment ${environment ?? "(none)"} is not on this device`,
          kib8,
        ),
      };
      return { requestStop: async () => {}, waitForExit: async () => exit };
    }
    const roots = [...new Set([cwd, await realpath(cwd)])];

    const file = await open(transcript, "a");
    let writes = Promise.resolve();
    // Serialized and fsynced; a failed write fails every later one, so nothing is processed unjournaled.
    const record = (line: Line) =>
      (writes = writes.then(async () => {
        await file.appendFile(`${JSON.stringify(line)}\n`);
        await file.datasync();
      }));

    // argv array, never a shell string (§20.2). Own process group, so a stop reaches Codex's children too.
    const argv = ["app-server"];
    const child = spawn(binary, argv, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "inherit"],
      detached: true,
    });
    let closed = false;
    // Never after `close`: the PID (and so the group id) may already belong to another process (§20.2).
    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && !closed) process.kill(-child.pid, signal);
      } catch {
        // Already gone.
      }
    };
    child.stdin!.on("error", () => {}); // EPIPE after an exit surfaces as `gone`.

    let fatal: unknown;
    let inbound = Promise.resolve();
    const gone = new Promise<string>((resolve) => {
      child.once("error", (error) => resolve(`spawn failed: ${error.message}`));
      child.once("close", (code, signal) => {
        closed = true;
        // Every line already read is processed first, so a final `turn/completed` is never lost.
        void inbound.then(() =>
          resolve(`codex app-server exited (code ${code}, signal ${signal})`),
        );
      });
    });
    const goneError = () =>
      gone.then((reason) => {
        throw fatal instanceof Error ? fatal : new Error(reason);
      });

    let nextId = 0;
    let configReadId: RequestId | undefined;
    const pending = new Map<RequestId, (response: RpcResponse) => void>();
    const send = async (msg: RpcMessage) => {
      await record({ dir: "out", msg });
      child.stdin!.write(`${JSON.stringify(msg)}\n`);
    };
    const request = async <T>(method: string, params: unknown): Promise<T> => {
      const id = nextId++;
      if (method === "config/read") configReadId = id;
      const response = new Promise<RpcResponse>((resolve) => pending.set(id, resolve));
      await send({ id, method, params });
      const r = await Promise.race([response, goneError()]);
      if (r.error) throw new Error(`${method}: ${r.error.message}`);
      return r.result as T;
    };

    const abort = new AbortController();
    let stopReason: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let waitingFor: string | undefined;
    let lastMessage: string | undefined;
    const items = new Map<string, ThreadItem>();
    let completeTurn!: (turn: Turn) => void;
    const completed = new Promise<Turn>((resolve) => (completeTurn = resolve));

    const stop = async (reason: string) => {
      if (stopReason || closed) return;
      stopReason = reason;
      abort.abort(); // a pending approval poll ends as a decline
      killTimer = setTimeout(() => {
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), stopGraceMs);
      }, stopGraceMs);
      if (threadId && turnId) {
        await request("turn/interrupt", { threadId, turnId }).catch(() => {});
      } else {
        killGroup("SIGTERM");
      }
    };

    let passed = false;
    const tools = ctx.run
      ? hiveTools(ctx.context, ctx.run, {
          signal: abort.signal,
          pollMs: approvalPollMs,
          onPass: () => (passed = true),
        })
      : [];
    const gate = approvalGate({
      policy,
      run: ctx.run,
      cwdLabel: policy.cwdMode === "environment" ? environment! : "run_scratch",
      roots,
      hiveTools: new Set(),
      pollMs: approvalPollMs,
    });
    const decide = async (
      tool: string,
      input: Record<string, unknown>,
      id: RequestId,
    ): Promise<ApprovalDecision> => {
      const result = await gate(tool, input, {
        signal: abort.signal,
        toolUseID: String(id),
        requestId: String(id),
      });
      return result?.behavior === "allow" ? "accept" : "decline";
    };

    const callTool = async (p: DynamicToolCallParams): Promise<DynamicToolCallResponse> => {
      const def = tools.find((t) => t.name === p.tool);
      if (!def) return toolReply(`hive error: unknown tool ${p.tool}`, false);
      const args = z.object(def.inputSchema as z.ZodRawShape).safeParse(p.arguments ?? {});
      if (!args.success) return toolReply(`hive error: ${z.prettifyError(args.error)}`, false);
      const out = await def.handler(args.data, {});
      const text = out.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
      if (p.tool === waitTool && !out.isError) {
        waitingFor = (args.data as { requestMessageId: string }).requestMessageId;
        await record({ dir: "local", event: "waiting", requestMessageId: waitingFor });
      }
      return toolReply(text, !out.isError);
    };

    // Every server request is answered, or the turn would hang.
    const answer = async (req: RpcRequest) => {
      let result: unknown;
      if (req.method === "item/commandExecution/requestApproval") {
        const p = req.params as CommandApprovalParams;
        result = {
          decision: await decide("Bash", { command: p.command ?? "", cwd: p.cwd ?? cwd }, req.id),
        };
      } else if (req.method === "item/fileChange/requestApproval") {
        const item = items.get((req.params as FileChangeApprovalParams).itemId);
        const changes = item?.type === "fileChange" && "changes" in item ? item.changes : [];
        const paths = changes.map((c) => c.path);
        const allowed =
          paths.length > 0 &&
          paths.every((path) => !outsidePath("Edit", { file_path: path }, roots));
        result = {
          decision: allowed
            ? await decide("Edit", { file_path: paths.join("\n"), changes }, req.id)
            : "decline",
        };
      } else if (req.method === "item/tool/call") {
        result = await callTool(req.params as DynamicToolCallParams);
      } else {
        return send({
          id: req.id,
          error: { code: -32601, message: `${req.method} is not supported by hive` },
        });
      }
      await send({ id: req.id, result });
      // The wait tool's result is delivered; end the turn without another model step.
      if (waitingFor) await stop("waiting");
    };

    const dispatch = (msg: RpcMessage) => {
      if (!("method" in msg)) {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
        return;
      }
      if ("id" in msg) {
        void answer(msg).catch((error: unknown) => {
          fatal ??= error;
          killGroup("SIGTERM");
        });
        return;
      }
      if (msg.method === "item/started" || msg.method === "item/completed") {
        const { item } = msg.params as ItemNotification;
        items.set(item.id, item);
        if (msg.method === "item/completed" && item.type === "agentMessage" && "text" in item) {
          lastMessage = item.text;
        }
      }
      if (msg.method === "turn/completed") {
        const params = msg.params as TurnCompletedNotification;
        if (params.threadId === threadId) completeTurn(params.turn);
      }
    };

    createInterface({ input: child.stdout! }).on("line", (text) => {
      inbound = inbound
        .then(async () => {
          let msg: RpcMessage;
          try {
            msg = JSON.parse(text) as RpcMessage;
          } catch {
            return console.error("codex app-server: unparseable line skipped");
          }
          await record({ dir: "in", msg: journaled(msg, configReadId) });
          dispatch(msg);
        })
        .catch((error: unknown) => {
          fatal ??= error;
          killGroup("SIGTERM");
        });
    });

    const shutdown = async () => {
      child.stdin!.end();
      const exited = (ms: number) =>
        Promise.race([gone.then(() => true), sleep(ms, false, { ref: false })]);
      if (!(await exited(stopGraceMs))) {
        killGroup("SIGTERM");
        if (!(await exited(stopGraceMs))) killGroup("SIGKILL");
        await gone;
      }
      clearTimeout(killTimer);
    };

    const run = async (): Promise<Exit> => {
      try {
        await record({
          dir: "local",
          event: "spawn",
          pid: child.pid ?? null,
          spawnedAt: new Date().toISOString(),
          binary,
          argv,
        });
        await request("initialize", {
          clientInfo: { name: "hive-executor", title: null, version: "0.0.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        } satisfies InitializeParams);
        await send({ method: "initialized", params: {} });
        const { config } = await request<{ config: { mcp_servers?: Record<string, unknown> } }>(
          "config/read",
          { cwd },
        );
        const thread = await request<ThreadStartResponse>("thread/start", {
          cwd,
          approvalPolicy: "untrusted",
          sandbox: "read-only",
          developerInstructions: systemPrompt(ctx.context, true),
          config: isolation(Object.keys(config.mcp_servers ?? {})),
          ...(tools.length
            ? {
                dynamicTools: tools.map((t) => ({
                  type: "function" as const,
                  name: t.name,
                  description: t.description,
                  inputSchema: z.toJSONSchema(z.object(t.inputSchema as z.ZodRawShape)),
                })),
              }
            : {}),
        } satisfies ThreadStartParams);
        threadId = thread.thread.id;
        // Losing the observation must not fail the Run; a stale generation surfaces on lease renewal.
        await ctx
          .observe("runtime.run.started", { providerSessionId: threadId })
          .catch((error: unknown) => console.error("runtime.run.started failed", error));
        const started = await request<TurnStartResponse>("turn/start", {
          threadId,
          input: [{ type: "text", text: userPrompt(ctx.context), text_elements: [] }],
        } satisfies TurnStartParams);
        turnId = started.turn.id;
        const turn = await Promise.race([completed, goneError()]);
        if (waitingFor) return waitingExit(waitingFor);
        if (stopReason && turn.status !== "completed") {
          return { code: null, reason: stopReason, summary: "codex: stopped" };
        }
        return turnExit(turn, lastMessage);
      } catch (error) {
        if (waitingFor) return waitingExit(waitingFor);
        if (stopReason) return { code: null, reason: stopReason, summary: "codex: stopped" };
        const message = error instanceof Error ? error.message : String(error);
        return { code: 1, reason: truncate(message, kib8), summary: "codex: failed" };
      } finally {
        await shutdown();
        await writes.catch(() => {});
        await file.close();
      }
    };
    const exited = run().then((exit) => ({ ...exit, ...(passed ? { pass: true } : {}) }));
    return { requestStop: stop, waitForExit: () => exited };
  },
});
