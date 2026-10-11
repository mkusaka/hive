// In-run hive tools (docs/architecture.md §8, §18.2): an in-process MCP server whose handlers call the cloud with the
// Run's capability (`RunApi`). The token never enters a prompt or a tool result. Input schemas are Zod because the SDK
// derives the model-facing JSON Schema from them and validates calls before a handler runs. A cloud error is returned
// to the model as tool text with `isError`; nothing is thrown into the SDK loop.
import {
  createSdkMcpServer,
  type SdkMcpToolDefinition,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { setTimeout as sleep } from "node:timers/promises";
import type { EffectKind, RunCommand, RunContext } from "@hive/contracts";
import { z } from "zod";
import { CloudError, type RunApi } from "./cloudClient.ts";

const server = "hive";
/** The SDK's name for a tool of this server, as `allowedTools` and `tool_use` blocks spell it. */
export const toolName = (name: string) => `mcp__${server}__${name}`;
/** The adapter ends the Run as `waiting` once this tool returned (adapters/claude.ts). */
export const waitForReplyTool = toolName("hive_wait_for_reply");

const result = (value: unknown, isError = false) => ({
  content: [
    { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) },
  ],
  ...(isError ? { isError: true } : {}),
});

const cloud = async (call: () => Promise<unknown>) => {
  try {
    return result(await call());
  } catch (error) {
    const detail =
      error instanceof CloudError
        ? `${error.code}${error.reason ? ` (${error.reason})` : ""}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return result(`hive error: ${detail}`, true);
  }
};

const recipient = {
  botId: z.string().min(1).optional().describe("Recipient Bot id"),
  botName: z.string().min(1).optional().describe("Recipient Bot name (instead of botId)"),
};
const text = z
  .string()
  .min(1)
  .max(64 * 1024);

const send =
  (run: RunApi, kind: "request" | "notification") =>
  async (args: { botId?: string; botName?: string; text: string }) => {
    if ((args.botId === undefined) === (args.botName === undefined)) {
      return result("hive error: give exactly one of botId or botName", true);
    }
    return cloud(() =>
      run.command({
        type: "agent.send",
        ...(args.botId ? { recipientBotId: args.botId } : { recipientBotName: args.botName }),
        message: { kind, text: args.text },
      }),
    );
  };

/**
 * External write through the cloud's effect broker (§19): prepare, then poll every `pollMs` until the effect settles.
 * A pending approval keeps it `prepared` (the Run is `waiting_approval` meanwhile). The provider response never reaches
 * the model: only the effect id, state and URL.
 */
const effect =
  (run: RunApi, kind: EffectKind, opts: { signal?: AbortSignal; pollMs?: number }) =>
  async ({ integrationId, ...request }: Record<string, unknown>) =>
    cloud(async () => {
      const { effectId } = (await run.command({
        type: "effect.prepare",
        kind,
        ...(integrationId ? { integrationId } : {}),
        request,
      } as RunCommand)) as { effectId: string };
      for (;;) {
        opts.signal?.throwIfAborted();
        // oxlint-disable-next-line no-await-in-loop -- one poll at a time
        const e = await run.getEffect(effectId);
        if (e.state === "failed")
          throw new Error(`effect ${effectId} failed: ${e.lastError ?? ""}`);
        if (e.state === "succeeded") {
          return {
            effectId,
            state: e.state,
            ...(e.externalUrl ? { externalUrl: e.externalUrl } : {}),
          };
        }
        if (e.state === "unknown") {
          return {
            effectId,
            state: e.state,
            note: "the outcome is unknown; hive reconciles it. Do not post the same thing again.",
          };
        }
        // oxlint-disable-next-line no-await-in-loop -- one poll at a time
        await sleep(opts.pollMs ?? 2000, undefined, { signal: opts.signal });
      }
    });

const integrationId = z
  .string()
  .min(1)
  .optional()
  .describe("Integration id; omit when the workspace has one of this kind");

/**
 * The tools this Run may use: `hive_reply` only for a request from another Bot, `hive_pass` only in a Channel, thread
 * or DM, task tools only for a Task Job, effect tools only for kinds the Bot's policy does not deny. `signal` (the Run's
 * stop) ends an effect tool's wait; `onPass` is told when the Bot passed (the adapter marks its exit, ROUTE-02).
 */
export const hiveTools = (
  context: RunContext,
  run: RunApi,
  opts: { signal?: AbortSignal; pollMs?: number; onPass?: () => void } = {},
) => {
  const tools: SdkMcpToolDefinition<any>[] = [
    tool(
      "hive_send_request",
      "Ask another hive Bot something. Returns requestMessageId. To get the answer, call hive_wait_for_reply " +
        "with it and end your turn; you continue in a new run once the reply arrives.",
      { ...recipient, text },
      send(run, "request"),
    ),
    tool(
      "hive_notify",
      "Tell another hive Bot something. Notifications are recorded in its inbox and never answered.",
      { ...recipient, text },
      send(run, "notification"),
    ),
    tool(
      "hive_wait_for_reply",
      "Wait for the reply to a request you sent. Call it last and end your turn: this run stops and you resume " +
        "in a new run with the reply.",
      { requestMessageId: z.string().min(1) },
      async () => result({ waiting: true }),
    ),
  ];
  if (context.conversation && context.conversation.kind !== "bot_pair") {
    tools.push(
      tool(
        "hive_pass",
        "Stay silent in this conversation: nothing you write afterwards is posted. Call it when the message is not " +
          "for you or another member owns the next step, then end your turn.",
        {},
        async () => {
          opts.onPass?.();
          return result({ passed: true });
        },
      ),
    );
  }
  const item = context.inboxItem;
  if (item?.kind === "request" && item.fromBot && item.messageId) {
    const requestMessageId = item.messageId;
    tools.push(
      tool(
        "hive_reply",
        `Answer the request from Bot ${item.fromBot.name}. Your final text is not sent to it; only this tool is.`,
        { text },
        async (args) =>
          cloud(() => run.command({ type: "agent.reply", requestMessageId, text: args.text })),
      ),
    );
  }
  const task = context.task;
  if (task) {
    tools.push(
      tool(
        "hive_task_get",
        "Read a Task of this run's Project.",
        { taskId: z.string().min(1) },
        async (args) => cloud(() => run.getTask(args.taskId)),
      ),
      tool(
        "hive_task_update",
        `Update this run's Task ${task.key}: assign it (assignee null unassigns) and/or mark it completed.`,
        {
          status: z.enum(["completed"]).optional(),
          assignee: z
            .object({ kind: z.enum(["user", "bot"]), id: z.string().min(1) })
            .nullable()
            .optional(),
        },
        async (args) =>
          cloud(async () => {
            if (args.status === undefined && args.assignee === undefined) {
              throw new Error("nothing to update: give status and/or assignee");
            }
            const revision = async () =>
              ((await run.getTask(task.id)) as { revision: number }).revision;
            const done: unknown[] = [];
            if (args.assignee !== undefined) {
              done.push(
                await run.command({
                  type: "task.assign",
                  taskId: task.id,
                  assignee: args.assignee,
                  expectedRevision: await revision(),
                }),
              );
            }
            if (args.status === "completed") {
              done.push(
                await run.command({
                  type: "task.complete",
                  taskId: task.id,
                  expectedRevision: await revision(),
                }),
              );
            }
            return done;
          }),
      ),
      tool(
        "hive_task_delegate",
        `Delegate this run's Task ${task.key} to another Bot: it gets its own run with your instructions, read or ` +
          "write access to the Task, and you are notified of the outcome. You stay responsible for the Task.",
        {
          botId: z.string().min(1).describe("Receiving Bot id"),
          mode: z.enum(["read", "write"]),
          instructions: z
            .string()
            .min(1)
            .max(8 * 1024),
          deadline: z.iso.datetime().optional().describe("ISO 8601 deadline"),
        },
        async (args) =>
          cloud(async () =>
            run.command({
              type: "task.delegate",
              taskId: task.id,
              toBotId: args.botId,
              mode: args.mode,
              instructions: args.instructions,
              ...(args.deadline ? { deadline: args.deadline } : {}),
              expectedRevision: ((await run.getTask(task.id)) as { revision: number }).revision,
            }),
          ),
      ),
    );
  }
  // Memory (§13.6): only the Run's own scopes; Workspace scope is a promotion the Run cannot make (AT-33).
  const scopes: Record<string, string> = { bot: context.bot.id };
  if (task) scopes.task = task.id;
  if (context.conversation) scopes.channel = context.conversation.channelId;
  const scopeKinds = Object.keys(scopes) as [string, ...string[]];
  tools.push(
    tool(
      "hive_memory_write",
      `Remember a fact for later runs, in scope ${scopeKinds.join(" / ")}: bot = only you, task = this Task, ` +
        "channel = everyone in this conversation's channel.",
      {
        content: z
          .string()
          .min(1)
          .max(16 * 1024),
        scope: z.enum(scopeKinds),
      },
      async (args) =>
        cloud(() =>
          run.command({
            type: "memory.write",
            scopeKind: args.scope as "bot" | "task" | "channel",
            scopeId: scopes[args.scope]!,
            content: args.content,
          }),
        ),
    ),
    tool(
      "hive_memory_search",
      "Search memories, messages and tasks you may read (3+ characters for full-text search).",
      { q: z.string().min(1).max(200) },
      async (args) => cloud(() => run.search(args.q)),
    ),
  );
  const effects = context.bot.toolPolicy.effects ?? {};
  const offered = (kind: EffectKind) => effects[kind] === "allow" || effects[kind] === "ask";
  if (offered("slack.post")) {
    tools.push(
      tool(
        "hive_slack_post",
        "Post a Slack message as the hive app, in a channel or a thread. May wait for a human approval.",
        {
          integrationId,
          channel: z.string().min(1).describe("Slack conversation id, e.g. C0123ABCD"),
          text: z.string().min(1).max(40_000),
          threadTs: z
            .string()
            .min(1)
            .optional()
            .describe("Parent message ts to reply in its thread"),
        },
        effect(run, "slack.post", opts),
      ),
    );
  }
  if (offered("github.comment")) {
    tools.push(
      tool(
        "hive_github_comment",
        "Comment on a GitHub issue or pull request as the hive GitHub App. May wait for a human approval.",
        {
          integrationId,
          owner: z.string().min(1),
          repo: z.string().min(1),
          issueNumber: z.number().int().min(1).describe("Issue or pull request number"),
          body: z.string().min(1).max(65_536),
        },
        effect(run, "github.comment", opts),
      ),
    );
  }
  return tools;
};

export const hiveMcpServer = (tools: SdkMcpToolDefinition<any>[]) =>
  createSdkMcpServer({ name: server, version: "1.0.0", tools });
