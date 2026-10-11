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

const managementTools = (context: RunContext, run: RunApi) => {
  const manage = context.bot.toolPolicy.manage ?? {};
  const tools: SdkMcpToolDefinition<any>[] = [];
  const command = (value: RunCommand) => cloud(() => run.command(value));
  const botId = z.string().min(1).optional().describe("Bot id; omit for this Bot");
  const conversationId = z
    .string()
    .min(1)
    .optional()
    .describe("Conversation id; omit for this conversation when one exists");
  if (manage.subscriptions) {
    tools.push(
      tool(
        "hive_subscription_create",
        "Create a Subscription for this Bot or a child Bot.",
        {
          botId,
          integrationId: z.string().min(1).optional(),
          eventTypes: z.array(z.string().min(1)).min(1).max(20),
          filter: z.unknown().optional(),
          conversationId,
          projectId: z.string().min(1).optional(),
          taskId: z.string().min(1).optional(),
          delivery: z.unknown().optional(),
          expiresAt: z.iso.datetime().nullable().optional(),
        },
        async (args) => {
          const destinationConversationId = args.conversationId ?? context.conversation?.id;
          if (!destinationConversationId) {
            return result("hive error: conversationId is required outside a conversation", true);
          }
          return command({
            type: "subscription.create",
            botId: args.botId ?? context.bot.id,
            ...(args.integrationId ? { integrationId: args.integrationId } : {}),
            eventTypes: args.eventTypes,
            ...(args.filter === undefined ? {} : { filter: args.filter }),
            destination: {
              conversationId: destinationConversationId,
              ...(args.projectId ? { projectId: args.projectId } : {}),
              ...(args.taskId ? { taskId: args.taskId } : {}),
            },
            ...(args.delivery === undefined ? {} : { delivery: args.delivery }),
            ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
          } as RunCommand);
        },
      ),
      tool(
        "hive_subscription_update",
        "Update a Subscription this Bot or a child Bot owns.",
        {
          subscriptionId: z.string().min(1),
          expectedRevision: z.number().int().min(1),
          eventTypes: z.array(z.string().min(1)).min(1).max(20).optional(),
          filter: z.unknown().optional(),
          destination: z.unknown().optional(),
          delivery: z.unknown().optional(),
          expiresAt: z.iso.datetime().nullable().optional(),
          enabled: z.boolean().optional(),
        },
        async (args) => command({ type: "subscription.update", ...args } as RunCommand),
      ),
      tool(
        "hive_subscription_delete",
        "Delete a Subscription this Bot or a child Bot owns.",
        { subscriptionId: z.string().min(1) },
        async (args) => command({ type: "subscription.delete", ...args } as RunCommand),
      ),
    );
  }
  if (manage.routines) {
    const schedule = z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("cron"),
        expr: z.string().min(1).max(200),
        timezone: z.string().min(1),
      }),
      z.object({ kind: z.literal("once"), at: z.iso.datetime() }),
    ]);
    tools.push(
      tool(
        "hive_routine_create",
        "Create a Routine for this Bot or a child Bot.",
        {
          botId,
          name: z.string().min(1).max(200),
          schedule,
          inputText: z
            .string()
            .min(1)
            .max(64 * 1024),
          misfire: z.enum(["skip", "coalesce"]).optional(),
          conversationId,
          taskId: z.string().min(1).optional(),
        },
        async (args) => {
          const routineConversationId = args.conversationId ?? context.conversation?.id;
          return command({
            type: "routine.create",
            botId: args.botId ?? context.bot.id,
            name: args.name,
            schedule: args.schedule,
            inputText: args.inputText,
            ...(args.misfire ? { misfire: args.misfire } : {}),
            ...(routineConversationId ? { conversationId: routineConversationId } : {}),
            ...(args.taskId ? { taskId: args.taskId } : {}),
          } as RunCommand);
        },
      ),
      tool(
        "hive_routine_update",
        "Update a Routine this Bot or a child Bot owns.",
        {
          routineId: z.string().min(1),
          expectedRevision: z.number().int().min(1),
          name: z.string().min(1).max(200).optional(),
          schedule: z
            .discriminatedUnion("kind", [
              z.object({
                kind: z.literal("cron"),
                expr: z.string().min(1).max(200),
                timezone: z.string().min(1),
              }),
              z.object({ kind: z.literal("once"), at: z.iso.datetime() }),
            ])
            .optional(),
          inputText: z
            .string()
            .min(1)
            .max(64 * 1024)
            .optional(),
          misfire: z.enum(["skip", "coalesce"]).optional(),
        },
        async (args) => command({ type: "routine.update", ...args } as RunCommand),
      ),
      ...(["pause", "resume", "delete"] as const).map((action) =>
        tool(
          `hive_routine_${action}`,
          `${action[0]!.toUpperCase()}${action.slice(1)} a Routine this Bot or a child Bot owns.`,
          { routineId: z.string().min(1) },
          async (args) => command({ type: `routine.${action}`, ...args } as RunCommand),
        ),
      ),
    );
  }
  if (manage.channels) {
    tools.push(
      tool(
        "hive_channel_create",
        "Create a Channel. This Bot and the workspace owner become owners.",
        { name: z.string().min(1).max(200) },
        async (args) => command({ type: "channel.create", ...args } as RunCommand),
      ),
    );
  }
  if (manage.bots) {
    tools.push(
      tool(
        "hive_bot_create",
        "Create a child Bot. Its tool policy cannot exceed this Bot's policy.",
        {
          name: z.string().min(1).max(200),
          instructions: z
            .string()
            .max(64 * 1024)
            .optional(),
          toolPolicy: z.unknown().optional(),
        },
        async (args) => command({ type: "bot.create", ...args } as RunCommand),
      ),
    );
  }
  return tools;
};

/**
 * The tools this Run may use: `hive_reply` only for a request from another Bot, `hive_pass` only in a Channel, thread
 * or DM, task tools only for a Task Job, effect tools only for kinds the Bot's policy does not deny. `signal` (the Run's
 * stop) ends an effect tool's wait; `onPass` is told when the Bot passed (the adapter marks its exit, ROUTE-02).
 */
export const hiveTools = (
  context: RunContext,
  run: RunApi,
  opts: { signal?: AbortSignal; pollMs?: number; onPass?: () => void; skillUse?: boolean } = {},
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
  if (opts.skillUse !== false && context.bot.skills?.length) {
    tools.push(
      tool(
        "hive_skill_use",
        "Load the instructions for one of this Bot's configured skills by name.",
        { name: z.string().min(1) },
        async ({ name }) => {
          const skill = context.bot.skills?.find((candidate) => candidate.name === name);
          return skill
            ? result({ name: skill.name, instructions: skill.instructions })
            : result(`hive error: unknown skill ${name}`, true);
        },
      ),
    );
  }
  tools.push(...managementTools(context, run));

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
