// In-run hive tools (docs/architecture.md §8, §18.2): an in-process MCP server whose handlers call the cloud with the
// Run's capability (`RunApi`). The token never enters a prompt or a tool result. Input schemas are Zod because the SDK
// derives the model-facing JSON Schema from them and validates calls before a handler runs. A cloud error is returned
// to the model as tool text with `isError`; nothing is thrown into the SDK loop.
import {
  createSdkMcpServer,
  type SdkMcpToolDefinition,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { RunContext } from "@hive/contracts";
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

/** The tools this Run may use: `hive_reply` only for a request from another Bot, task tools only for a Task Job. */
export const hiveTools = (context: RunContext, run: RunApi) => {
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
  return tools;
};

export const hiveMcpServer = (tools: SdkMcpToolDefinition<any>[]) =>
  createSdkMcpServer({ name: server, version: "1.0.0", tools });
