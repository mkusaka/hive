import * as v from "valibot";
import { isTimeZone, nextCron, parseCron } from "./cron.ts";
import { EventTypePattern, FilterExpression } from "./filter.ts";

export * from "./cron.ts";
export * from "./filter.ts";

const id = <const Name extends string>(name: Name) =>
  v.pipe(v.string(), v.minLength(1), v.brand(name));

export const WorkspaceId = id("WorkspaceId");
export const UserId = id("UserId");
export const DeviceId = id("DeviceId");
export const BotId = id("BotId");
export const ChannelId = id("ChannelId");
export const JobId = id("JobId");
export const RunId = id("RunId");
export const TaskId = id("TaskId");
export type WorkspaceId = v.InferOutput<typeof WorkspaceId>;
export type UserId = v.InferOutput<typeof UserId>;
export type DeviceId = v.InferOutput<typeof DeviceId>;
export type BotId = v.InferOutput<typeof BotId>;
export type ChannelId = v.InferOutput<typeof ChannelId>;
export type JobId = v.InferOutput<typeof JobId>;
export type RunId = v.InferOutput<typeof RunId>;
export type TaskId = v.InferOutput<typeof TaskId>;

// Scoped by workspace + authenticated actor on the server (docs/architecture.md §6.2).
export const IdempotencyKey = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(255),
  v.brand("IdempotencyKey"),
);
export type IdempotencyKey = v.InferOutput<typeof IdempotencyKey>;

const Timestamp = v.pipe(v.string(), v.isoTimestamp());

// docs/architecture.md §5.2. `actor`, `source` and `receivedAt` are server-assigned.
export const eventEnvelope = <TData extends v.GenericSchema>(data: TData) =>
  v.strictObject({
    id: v.pipe(v.string(), v.minLength(1)),
    workspaceId: WorkspaceId,
    type: v.pipe(v.string(), v.minLength(1)),
    schemaVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
    source: v.strictObject({
      kind: v.picklist(["github", "slack", "cli", "routine", "bot", "system"]),
      integrationId: v.optional(v.string()),
      externalEventId: v.optional(v.string()),
      deviceId: v.optional(DeviceId),
    }),
    actor: v.strictObject({
      kind: v.picklist(["user", "bot", "integration", "system"]),
      id: v.pipe(v.string(), v.minLength(1)),
    }),
    subject: v.nullable(v.strictObject({ kind: v.string(), id: v.string() })),
    data,
    correlationId: v.pipe(v.string(), v.minLength(1)),
    causationId: v.nullable(v.string()),
    occurredAt: Timestamp,
    receivedAt: Timestamp,
    expiresAt: v.nullable(Timestamp),
  });
export type EventEnvelope<TData> = Omit<
  v.InferOutput<ReturnType<typeof eventEnvelope<v.UnknownSchema>>>,
  "data"
> & { data: TData };

// docs/architecture.md §22.1, §22.4. The server checks `workspaceId` against membership.
export const commandEnvelope = <TCommand extends v.GenericSchema>(command: TCommand) =>
  v.strictObject({
    operationId: v.pipe(v.string(), v.minLength(1)),
    idempotencyKey: IdempotencyKey,
    workspaceId: WorkspaceId,
    command,
  });

const Name = v.pipe(v.string(), v.minLength(1), v.maxLength(200));

/** Dev bootstrap: creates the envelope's `workspaceId` with the caller as owner. */
export const WorkspaceCreate = v.strictObject({ type: v.literal("workspace.create"), name: Name });

export const DeviceRegister = v.strictObject({
  type: v.literal("device.register"),
  name: Name,
  os: Name,
  agentVersion: Name,
});

export const DeviceRevoke = v.strictObject({
  type: v.literal("device.revoke"),
  deviceId: DeviceId,
});

export const ChannelCreate = v.strictObject({ type: v.literal("channel.create"), name: Name });
/** Sets the Channel's topic; an empty string clears it. Members only. */
export const ChannelUpdate = v.strictObject({
  type: v.literal("channel.update"),
  channelId: ChannelId,
  topic: v.pipe(v.string(), v.maxLength(250)),
});
/** Adds a Bot as a member; Channel / Workspace owners only. */
export const ChannelJoin = v.strictObject({
  type: v.literal("channel.join"),
  channelId: ChannelId,
  botId: BotId,
});
/** Removes a Bot's membership; Channel / Workspace owners only. */
export const ChannelLeave = v.strictObject({
  type: v.literal("channel.leave"),
  channelId: ChannelId,
  botId: BotId,
});
export const ChannelRole = v.picklist(["owner", "member", "viewer"]);
export type ChannelRole = v.InferOutput<typeof ChannelRole>;
const ChannelMemberFields = {
  channelId: ChannelId,
  userId: v.optional(UserId),
  botId: v.optional(BotId),
};
/** Adds one user or Bot to a Channel. Only Channel / Workspace owners may manage membership. */
export const ChannelMemberAdd = v.pipe(
  v.strictObject({
    type: v.literal("channel.member.add"),
    ...ChannelMemberFields,
    role: ChannelRole,
  }),
  v.check(
    (input) => (input.userId === undefined) !== (input.botId === undefined),
    "provide exactly one userId or botId",
  ),
);
/** Changes one member's role. The last owner cannot be demoted. */
export const ChannelMemberUpdate = v.pipe(
  v.strictObject({
    type: v.literal("channel.member.update"),
    ...ChannelMemberFields,
    role: ChannelRole,
  }),
  v.check(
    (input) => (input.userId === undefined) !== (input.botId === undefined),
    "provide exactly one userId or botId",
  ),
);
/** Removes one member. The last owner cannot be removed. */
export const ChannelMemberRemove = v.pipe(
  v.strictObject({ type: v.literal("channel.member.remove"), ...ChannelMemberFields }),
  v.check(
    (input) => (input.userId === undefined) !== (input.botId === undefined),
    "provide exactly one userId or botId",
  ),
);
/** The caller's direct messages with the Bot: the existing conversation, or a new one. */
export const DmOpen = v.strictObject({ type: v.literal("dm.open"), botId: BotId });

const DeviceIds = v.optional(v.array(DeviceId), []);

// docs/architecture.md §3.2, §10.2. Every field defaults, so `{}` means "any eligible device". `preferred` ranks
// `preferredDeviceIds` in order; `pinned` runs only on its single `preferredDeviceIds` entry.
export const PlacementPolicy = v.pipe(
  v.strictObject({
    mode: v.optional(v.picklist(["pinned", "preferred", "any"]), "any"),
    allowedDeviceIds: DeviceIds,
    preferredDeviceIds: DeviceIds,
    fallbackOnUnavailable: v.optional(v.boolean(), true),
    overflowToFallback: v.optional(v.boolean(), false),
    environmentId: v.optional(Name),
    requiredCapabilities: v.optional(v.array(Name), []),
    recovery: v.optional(v.picklist(["manual", "safe_auto"]), "manual"),
  }),
  v.check(
    (p) =>
      p.allowedDeviceIds.length === 0 ||
      p.preferredDeviceIds.every((d) => p.allowedDeviceIds.includes(d)),
    "preferredDeviceIds must be a subset of allowedDeviceIds",
  ),
  v.check(
    (p) => p.mode !== "pinned" || p.preferredDeviceIds.length === 1,
    "pinned placement needs exactly one preferredDeviceIds entry",
  ),
);
export type PlacementPolicy = v.InferOutput<typeof PlacementPolicy>;

const MessageText = v.pipe(v.string(), v.minLength(1), v.maxLength(64 * 1024));

/** Claude's native tools a Bot may be given (TOOLS-01). */
export const toolNames = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"] as const;
export const ToolName = v.picklist(toolNames);
export type ToolName = v.InferOutput<typeof ToolName>;

/**
 * Which native tools a Bot's runs may use (docs/architecture.md §19, §20.3). A tool not listed is `deny`; `ask` needs a
 * human approval per call. `cwdMode: environment` runs in the checkout root of the placement's `environmentId` on the
 * device; `run_scratch` in an empty per-run directory.
 */
/** External writes the cloud performs for a Bot (docs/architecture.md §19). */
export const effectKinds = ["slack.post", "github.comment"] as const;
export type EffectKind = (typeof effectKinds)[number];

export const ToolPolicyManage = v.strictObject({
  subscriptions: v.optional(v.boolean()),
  routines: v.optional(v.boolean()),
  channels: v.optional(v.boolean()),
  bots: v.optional(v.boolean()),
});
export type ToolPolicyManage = v.InferOutput<typeof ToolPolicyManage>;

export const ToolPolicy = v.strictObject({
  tools: v.optional(v.record(ToolName, v.picklist(["allow", "ask", "deny"])), {}),
  cwdMode: v.optional(v.picklist(["run_scratch", "environment"]), "run_scratch"),
  /** Per effect kind; a kind not listed is `deny`. Absent on Bots created before EFFECT-01. */
  effects: v.optional(v.record(v.picklist(effectKinds), v.picklist(["allow", "ask", "deny"]))),
  /** Bot self-service permissions. Every absent flag is false. */
  manage: v.optional(ToolPolicyManage),
});
export type ToolPolicy = v.InferOutput<typeof ToolPolicy>;

const Instructions = v.pipe(v.string(), v.maxLength(64 * 1024));
const SkillInstructions = v.pipe(
  v.string(),
  v.check((text) => utf8Bytes(text) <= 8192, "instructions must be at most 8 KiB"),
);
export const BotSkill = v.strictObject({
  name: Name,
  description: v.pipe(v.string(), v.maxLength(8192)),
  instructions: SkillInstructions,
  tools: v.optional(ToolPolicy),
});
export type BotSkill = v.InferOutput<typeof BotSkill>;
export const BotSkills = v.pipe(v.array(BotSkill), v.maxLength(20));
const Revision = v.pipe(v.number(), v.integer(), v.minValue(1));

export const BotCreate = v.strictObject({
  type: v.literal("bot.create"),
  name: Name,
  placementPolicy: v.optional(PlacementPolicy, {}),
  /** The Bot's system prompt for its runs. */
  instructions: v.optional(Instructions, ""),
  toolPolicy: v.optional(ToolPolicy, {}),
  skills: v.optional(BotSkills, []),
});

/** Replaces the given fields; `expectedRevision` is the Bot's `config_revision`. Running Runs keep what they read. */
export const BotUpdate = v.strictObject({
  type: v.literal("bot.update"),
  botId: BotId,
  expectedRevision: Revision,
  instructions: v.optional(Instructions),
  toolPolicy: v.optional(ToolPolicy),
  placementPolicy: v.optional(PlacementPolicy),
  skills: v.optional(BotSkills),
});

/**
 * `POST /v1/executor/heartbeat` body (§10.1). Capabilities name what the executor can run (`claude`, `codex`, `bash`,
 * `env:<environment>`); `capacity.background` is how many background root Runs it runs at once. An omitted field
 * keeps the stored value.
 */
export const ExecutorHeartbeat = v.strictObject({
  capabilities: v.optional(v.pipe(v.array(Name), v.maxLength(100))),
  capacity: v.optional(
    v.strictObject({
      background: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(64)),
    }),
  ),
});
export type ExecutorHeartbeat = v.InferInput<typeof ExecutorHeartbeat>;

/** Registers (or updates the repository of) an environment on one of the caller's devices (§10.1). */
export const DeviceEnvironmentRegister = v.strictObject({
  type: v.literal("device.environment.register"),
  deviceId: DeviceId,
  name: Name,
  /** Repository identity, e.g. the git remote URL. Never a local path. */
  repository: Name,
});

// docs/architecture.md §5.3, §7.2. Direct delivery to a Bot's Inbox; lane = channel.
export const AgentSend = v.strictObject({
  type: v.literal("agent.send"),
  recipientBotId: BotId,
  channelId: ChannelId,
  message: v.strictObject({
    kind: v.picklist(["request", "notification"]),
    text: MessageText,
  }),
  delivery: v.picklist(["wake", "notify"]),
});

/** A Bot mention inside a message body (Slack's `<@U123>`, namespaced): stored by id, shown by name. */
export const mentionToken = (botId: string) => `<@bot:${botId}>`;
const mentionPattern = /<@bot:([^>\s]+)>/g;
/** The mentioned Bot ids, each once, in order of first appearance. */
export const mentionedBotIds = (text: string) => [
  ...new Set(Array.from(text.matchAll(mentionPattern), (m) => m[1]!)),
];
/** Addresses every member Bot of the Channel (ROUTE-02); `@everyone` / `@all` in the composer. */
export const everyoneToken = "<@everyone>";
/** Tokens → `@name`, `@unknown` for an id `names` does not know; `<@everyone>` → `@everyone`. */
export const renderMentions = (text: string, names: ReadonlyMap<string, string>) =>
  text
    .replaceAll(mentionPattern, (_, botId: string) => `@${names.get(botId) ?? "unknown"}`)
    .replaceAll(everyoneToken, "@everyone");
const escapeRegExp = (s: string) => s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * `@name` of a known Bot (longest names first, not followed by a name character) → its token; `@everyone` / `@all`
 * → `<@everyone>`. What a Run writes (it reads names) and what the CLI's `--resolve-names` sends.
 */
export const tokenizeMentions = (text: string, bots: readonly { id: string; name: string }[]) => {
  let out = text.replaceAll(/(?<!\w)@(?:everyone|all)(?![\w-])/g, everyoneToken);
  for (const bot of bots.toSorted((a, b) => b.name.length - a.name.length)) {
    out = out.replaceAll(
      new RegExp(`(?<!\\w)@${escapeRegExp(bot.name)}(?![\\w-])`, "g"),
      mentionToken(bot.id),
    );
  }
  return out;
};

/**
 * A user's Channel message (docs/architecture.md §7.2). In a Channel's main conversation every member Bot gets the
 * Inbox item + Job that `agent.send` with `request` / `wake` gives (ROUTE-02, group chat); a `<@bot:ID>` mention or a
 * Reply on a Bot's message narrows that to the addressed Bots (a mentioned non-member joins), `<@everyone>` is every
 * member; a Bot with a queued or active Job there gets no second Job. `mentions`, when given, must equal the tokens. With `conversationId` (a DM) instead of `channelId`, the DM's Bot is always the recipient.
 * `threadOf` (a message of that Channel / DM) posts the reply in the message's thread, created on the first reply;
 * in a Channel thread every Bot that already took part in it is woken too, mentioned or not.
 */
export const MessagePost = v.pipe(
  v.strictObject({
    type: v.literal("message.post"),
    channelId: v.optional(ChannelId),
    conversationId: v.optional(v.pipe(v.string(), v.minLength(1))),
    threadOf: v.optional(v.pipe(v.string(), v.minLength(1))),
    text: MessageText,
    mentions: v.optional(v.array(BotId)),
    /** A Reply on a message of this conversation: on a Bot's message, it addresses that Bot (ROUTE-02). */
    replyToMessageId: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.check(
    (c) => (c.channelId === undefined) !== (c.conversationId === undefined),
    "exactly one of channelId / conversationId is required",
  ),
);

// --------------------------------------------- Run commands (docs/architecture.md §8, §18.2)
// `POST /v1/run/commands` with a Run capability: the sender is the Run's Bot, never a declared one.

/**
 * Bot-to-bot message into the private `bot_pair` conversation. A `request` wakes the recipient (a Job); a
 * `notification` is only recorded in its Inbox (§7.2 notify, never auto-answered). Exactly one recipient field.
 */
export const RunAgentSend = v.pipe(
  v.strictObject({
    type: v.literal("agent.send"),
    recipientBotId: v.optional(BotId),
    recipientBotName: v.optional(Name),
    message: v.strictObject({ kind: v.picklist(["request", "notification"]), text: MessageText }),
    /** A message of the same conversation this one follows up on. */
    replyToMessageId: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.check(
    (c) => (c.recipientBotId === undefined) !== (c.recipientBotName === undefined),
    "exactly one of recipientBotId / recipientBotName is required",
  ),
);

/** The response to a request delivered to this Run's Bot; re-queues the requester's waiting Job. */
export const AgentReply = v.strictObject({
  type: v.literal("agent.reply"),
  requestMessageId: v.pipe(v.string(), v.minLength(1)),
  text: MessageText,
});

export type RunAgentSendAccepted = {
  operationId: string;
  status: "accepted";
  messageId: string;
  conversationId: string;
  inboxItemId: string;
  hop: number;
};
export type AgentReplyAccepted = {
  operationId: string;
  status: "accepted";
  messageId: string;
  inboxItemId: string;
};

/** `GET /v1/run/me`: the Run principal behind a capability. */
export type RunPrincipal = {
  kind: "run";
  runId: string;
  jobId: string;
  botId: string;
  workspaceId: string;
  executionGeneration: number;
  conversationId: string | null;
  taskId: string | null;
  hop: number;
  correlationId: string;
  scopes: string[];
};

// ---------------------------------------------------- Work (docs/architecture.md §4)
// Task edits carry the Task's `expectedRevision`; a stale one is 409 REVISION_CONFLICT.

/** Display-key prefix: Task keys are `<projectKey>-<n>`. */
export const ProjectKey = v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9]{1,9}$/));

export const ProjectCreate = v.strictObject({
  type: v.literal("project.create"),
  key: ProjectKey,
  name: Name,
});

/** Needs `projectKey` or `parentTaskId`; a subtask stays in its parent's Project (§2.1). */
export const TaskCreate = v.strictObject({
  type: v.literal("task.create"),
  projectKey: v.optional(ProjectKey),
  parentTaskId: v.optional(TaskId),
  title: Name,
  description: v.optional(v.pipe(v.string(), v.maxLength(64 * 1024)), ""),
  priority: v.optional(v.pipe(v.number(), v.integer()), 0),
  completionPolicy: v.optional(
    v.picklist(["declaration", "human", "checks", "children"]),
    "declaration",
  ),
});

export const TaskAssign = v.strictObject({
  type: v.literal("task.assign"),
  taskId: TaskId,
  assignee: v.nullable(v.strictObject({ kind: v.picklist(["user", "bot"]), id: Name })),
  expectedRevision: Revision,
});

/** Edits start dependencies; bumps `scope_revision`. A cycle is 422 INVALID_INPUT (AT-18). */
export const TaskPlan = v.strictObject({
  type: v.literal("task.plan"),
  taskId: TaskId,
  addPrerequisites: v.optional(v.array(TaskId), []),
  removePrerequisites: v.optional(v.array(TaskId), []),
  expectedRevision: Revision,
});

export const TaskComplete = v.strictObject({
  type: v.literal("task.complete"),
  taskId: TaskId,
  expectedRevision: Revision,
});

export const TaskCancel = v.strictObject({
  type: v.literal("task.cancel"),
  taskId: TaskId,
  expectedRevision: Revision,
});

/**
 * Formal delegation (§8.1): the Bot `toBotId` gets its own Job on the Task, bounded by `mode`; the Task's assignee does
 * not change. A user must be a member; a Bot (from a Run) must be the Task's assignee or hold an active `write`
 * delegation on it. Returns `{ delegationId, jobId }`.
 */
export const TaskDelegate = v.strictObject({
  type: v.literal("task.delegate"),
  taskId: TaskId,
  toBotId: BotId,
  mode: v.picklist(["read", "write"]),
  instructions: v.pipe(
    v.string(),
    v.minLength(1),
    v.check((s) => utf8Bytes(s) <= 8 * 1024, "instructions must be at most 8 KiB"),
  ),
  deadline: v.optional(Timestamp),
  expectedRevision: Revision,
});

/** Closes an active Delegation `revoked`; its Job is cancelled unless already terminal (an active one is asked to stop). */
export const TaskDelegateRevoke = v.strictObject({
  type: v.literal("task.delegate.revoke"),
  delegationId: v.pipe(v.string(), v.minLength(1)),
});

/** Explicit Task execution (§23): a queued Job for the Bot, optionally pinned to one device. */
export const JobStart = v.strictObject({
  type: v.literal("job.start"),
  taskId: TaskId,
  botId: BotId,
  deviceId: v.optional(DeviceId),
});

// ----------------------------------------- Subscriptions and integrations (§17)
// Users only for now: there is no Bot principal yet.

export const SubscriptionId = id("SubscriptionId");
export const IntegrationId = id("IntegrationId");

/** docs/roadmap.md §1: Slack/GitHub debounce 10 s, max 30 items per batch. */
export const SubscriptionDelivery = v.strictObject({
  mode: v.optional(v.picklist(["notify", "wake", "batch"]), "wake"),
  debounceMs: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(3_600_000)),
    10_000,
  ),
  maxBatchItems: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)), 30),
  /** Stored; inbox expiry is not enforced yet. */
  ttlSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 86_400),
});

const SubscriptionSpec = {
  eventTypes: v.pipe(v.array(EventTypePattern), v.minLength(1), v.maxLength(20)),
  /** Defaults to "match every event of `eventTypes`". */
  filter: v.optional(FilterExpression, { op: "and", nodes: [] }),
  destination: v.strictObject({
    conversationId: v.pipe(v.string(), v.minLength(1)),
    projectId: v.optional(v.pipe(v.string(), v.minLength(1))),
    taskId: v.optional(TaskId),
  }),
  delivery: v.optional(SubscriptionDelivery, {}),
  expiresAt: v.optional(v.nullable(Timestamp)),
};

export const SubscriptionCreate = v.strictObject({
  type: v.literal("subscription.create"),
  botId: BotId,
  /** Only events from this integration; omitted means any source. */
  integrationId: v.optional(IntegrationId),
  ...SubscriptionSpec,
});

/** Replaces the given fields; `enabled: true` resumes a paused Subscription. */
export const SubscriptionUpdate = v.strictObject({
  type: v.literal("subscription.update"),
  subscriptionId: SubscriptionId,
  expectedRevision: Revision,
  eventTypes: v.optional(SubscriptionSpec.eventTypes),
  filter: v.optional(FilterExpression),
  destination: v.optional(SubscriptionSpec.destination),
  delivery: v.optional(SubscriptionDelivery),
  expiresAt: SubscriptionSpec.expiresAt,
  enabled: v.optional(v.boolean()),
});

export const SubscriptionPause = v.strictObject({
  type: v.literal("subscription.pause"),
  subscriptionId: SubscriptionId,
});

/** Stops new Deliveries; pending Inbox items and Jobs are kept (§6.4). */
export const SubscriptionDelete = v.strictObject({
  type: v.literal("subscription.delete"),
  subscriptionId: SubscriptionId,
});

/** Dry-run over the Workspace's last `limit` events: creates nothing, not even a receipt. */
export const SubscriptionTest = v.strictObject({
  type: v.literal("subscription.test"),
  subscriptionId: SubscriptionId,
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200)), 50),
});

/** Returns the hook path. Secrets are environment-level for now (no per-installation secret). */
export const IntegrationCreate = v.strictObject({
  type: v.literal("integration.create"),
  kind: v.picklist(["github", "slack"]),
  /** The app's own account on the provider (Slack bot user id): its posts are not routed (AT-27). */
  externalAccountId: v.optional(Name),
});

// ------------------------------------------------- Routines (§17.2)

export const RoutineId = id("RoutineId");

const isCron = (expr: string) => {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
};

export const RoutineSchedule = v.variant("kind", [
  v.strictObject({
    kind: v.literal("cron"),
    expr: v.pipe(v.string(), v.maxLength(200), v.check(isCron, "invalid cron expression")),
    timezone: v.pipe(v.string(), v.check(isTimeZone, "unknown IANA timezone")),
  }),
  v.strictObject({ kind: v.literal("once"), at: Timestamp }),
  v.strictObject({ kind: v.literal("webhook") }),
  v.strictObject({ kind: v.literal("event"), filter: FilterExpression }),
]);
export type RoutineSchedule = v.InferOutput<typeof RoutineSchedule>;

/**
 * `next_fire_at` when a timed schedule is set or resumed at `now` (ms): a `once` keeps its `at` even if past (it fires
 * on the next tick, subject to misfire); a cron gets its first occurrence after `now`. Non-timed triggers have none.
 */
export const firstFireAt = (schedule: RoutineSchedule, now: number) => {
  if (schedule.kind === "once") return new Date(schedule.at).toISOString();
  if (schedule.kind === "cron") {
    const at = nextCron(parseCron(schedule.expr), schedule.timezone, now);
    return at === null ? null : new Date(at).toISOString();
  }
  return null;
};

const RoutineSpec = {
  name: Name,
  schedule: RoutineSchedule,
  inputText: v.pipe(v.string(), v.minLength(1), v.maxLength(64 * 1024)),
  /** `skip` drops occurrences more than 5 minutes late; `coalesce` runs the latest missed one. */
  misfire: v.optional(v.picklist(["skip", "coalesce"]), "coalesce"),
};

/** A Routine creates Inbox items and Jobs on its schedule; it never calls a model itself (§17.2). */
export const RoutineCreate = v.strictObject({
  type: v.literal("routine.create"),
  botId: BotId,
  ...RoutineSpec,
  /** Inbox lane and reply target; without it the lane is `routine:<id>` and the Bot cannot reply. */
  conversationId: v.optional(v.pipe(v.string(), v.minLength(1))),
  taskId: v.optional(TaskId),
});

/** Replaces the given fields; a new `schedule` bumps `schedule_revision` and restarts from now. */
export const RoutineUpdate = v.strictObject({
  type: v.literal("routine.update"),
  routineId: RoutineId,
  expectedRevision: Revision,
  name: v.optional(RoutineSpec.name),
  schedule: v.optional(RoutineSchedule),
  inputText: v.optional(RoutineSpec.inputText),
  misfire: v.optional(v.picklist(["skip", "coalesce"])),
});

export const RoutinePause = v.strictObject({
  type: v.literal("routine.pause"),
  routineId: RoutineId,
});
/** Restarts from now: occurrences missed while paused are not created. */
export const RoutineResume = v.strictObject({
  type: v.literal("routine.resume"),
  routineId: RoutineId,
});
/** Manual run: an occurrence at now through the same Inbox item + Job path; the schedule is not advanced. */
export const RoutineRun = v.strictObject({ type: v.literal("routine.run"), routineId: RoutineId });
/** Replaces a webhook secret; the new secret is returned once and is never stored in an operation receipt. */
export const RoutineRotateSecret = v.strictObject({
  type: v.literal("routine.rotate_secret"),
  routineId: RoutineId,
});
/** Deletes the Routine and its occurrence history; Jobs it already created stay. */
export const RoutineDelete = v.strictObject({
  type: v.literal("routine.delete"),
  routineId: RoutineId,
});

// ------------------------------------------------- Job control (§9.3, §10.4)

/** Queued / waiting Jobs are cancelled at once; an active Job is asked to stop (`cancelRequested` on renew). */
export const JobCancel = v.strictObject({ type: v.literal("job.cancel"), jobId: JobId });

/**
 * A `recovery_required` Job (§10.4). `retry` needs the old Run's stop to be confirmed (`runtime.run.stopped`), else
 * 409 RESOURCE_BUSY `unconfirmed_stop`; it queues the Job again and the next claim gets a new generation.
 */
export const JobResolve = v.strictObject({
  type: v.literal("job.resolve"),
  jobId: JobId,
  action: v.picklist(["retry", "cancel", "mark_failed"]),
});

/** Attach an externally collected Run to a Task in the same Workspace. */
export const RunLinkTask = v.strictObject({
  type: v.literal("run.link_task"),
  runId: RunId,
  taskId: TaskId,
});

// UTF-8 size. No TextEncoder: contracts stay runtime-neutral (`types: []`). A lone surrogate counts 3,
// as TextEncoder would encode it (U+FFFD).
const utf8Bytes = (text: string) => {
  let bytes = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return bytes;
};
const jsonBytes = (value: unknown) => utf8Bytes(JSON.stringify(value) ?? "");

/** Namespaced event type. Which namespaces an actor may publish is checked by the server (§5.1). */
export const EventType = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/));
/** The only namespace a user may emit (docs/architecture.md §5.1). */
export const userEventType = /^custom\.[a-z0-9_.]+$/;

// docs/architecture.md §5.3. Pub/sub: with no subscribers nothing starts.
export const EventEmit = v.strictObject({
  type: v.literal("event.emit"),
  event: v.strictObject({
    type: EventType,
    subject: v.optional(v.strictObject({ kind: Name, id: Name })),
    data: v.pipe(
      v.unknown(),
      v.check((data) => data !== undefined, "data is required"),
      v.check((data) => jsonBytes(data) <= 64 * 1024, "data must be at most 64 KiB of JSON"),
    ),
    occurredAt: v.optional(Timestamp),
  }),
});

// docs/architecture.md §22.4. A Job id is never invented at intake: routing creates it later.
export type AgentSendAccepted = {
  operationId: string;
  status: "accepted";
  messageId: string;
  inboxItemId: string;
  jobId: null;
  routingStatus: "pending";
  receivedAt: string;
};
export type MessagePostAccepted = {
  operationId: string;
  status: "accepted";
  messageId: string;
  /** Where the message landed: the Channel's / DM's conversation, or the thread's. */
  conversationId: string;
  /** One per woken Bot (mentioned ones in mention order); empty when nobody was woken. */
  inboxItemIds: string[];
  receivedAt: string;
};
export type EventEmitAccepted = {
  operationId: string;
  status: "accepted";
  eventId: string;
  receivedAt: string;
};

// ------------------------------------------------- Executor (§9.2, §10.3)
// Device principal only, same envelope as user commands (`commandEnvelope`).

/** Defaults to `["bot:<botId>"]` on the server: one Job Run per Bot at a time. */
export const JobClaim = v.strictObject({
  type: v.literal("job.claim"),
  jobId: JobId,
  expectedRevision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  resourceKeys: v.optional(v.array(Name)),
});

const Generation = v.pipe(v.number(), v.integer(), v.minValue(1));

export const RunLeaseRenew = v.strictObject({
  type: v.literal("run.lease.renew"),
  runId: RunId,
  executionGeneration: Generation,
});

export const RunResultSubmit = v.strictObject({
  type: v.literal("run.result.submit"),
  runId: RunId,
  executionGeneration: Generation,
  /**
   * `waiting` (§8.2, AT-29): the Run stopped at a safe checkpoint to wait for the reply to `waitingFor`. The Run
   * succeeds, the Job goes `waiting_input` and the reply queues it again for a successor Run.
   */
  state: v.picklist(["succeeded", "failed", "waiting"]),
  waitingFor: v.optional(v.strictObject({ requestMessageId: v.pipe(v.string(), v.minLength(1)) })),
  summary: v.pipe(
    v.string(),
    v.check((s) => utf8Bytes(s) <= 8 * 1024, "summary must be at most 8 KiB"),
  ),
  error: v.optional(v.pipe(v.string(), v.maxLength(8 * 1024))),
  /** Posted as a message from the Bot in the trigger item's Conversation, in the same batch. */
  reply: v.optional(
    v.strictObject({ conversationId: v.pipe(v.string(), v.minLength(1)), text: MessageText }),
  ),
  /**
   * The Bot chose not to answer (`hive_pass`, or a Run without final text; ROUTE-02): a `succeeded` Run with no
   * reply. The cloud records `runtime.run.passed` and posts nothing.
   */
  pass: v.optional(v.boolean()),
});

/** Metadata for a CLI session observed on a registered device, never a managed Job or Execution. */
export const ExternalRunInput = v.strictObject({
  provider: v.picklist(["claude", "codex"]),
  externalSessionId: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  cwd: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
  startedAt: Timestamp,
  lastActivityAt: Timestamp,
  repository: v.pipe(v.string(), v.maxLength(300)),
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  firstUserMessage: v.optional(v.pipe(v.string(), v.maxLength(4096))),
});
export type ExternalRunInput = v.InferOutput<typeof ExternalRunInput>;

export const ExecutorCommand = v.variant("type", [JobClaim, RunLeaseRenew, RunResultSubmit]);
export type ExecutorCommand = v.InferInput<typeof ExecutorCommand>;

// ------------------------------------------------- Approvals (docs/architecture.md §19)

/**
 * A Run asks a human before an `ask` tool runs. `argsHash` is SHA-256 (hex) of the canonical JSON of the tool input,
 * computed on the device; only `argsSummary` (the Bash command or the file path, at most 2 KiB) leaves it.
 */
export const ApprovalRequest = v.strictObject({
  type: v.literal("approval.request"),
  actionKind: ToolName,
  argsHash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  argsSummary: v.pipe(
    v.string(),
    v.check((s) => utf8Bytes(s) <= 2 * 1024, "argsSummary must be at most 2 KiB"),
  ),
  /** The environment name, or `run_scratch`. */
  cwdLabel: Name,
});

/** Resolves a pending approval once; any later resolve is 409 (AT-35). */
export const ApprovalResolve = v.strictObject({
  type: v.literal("approval.resolve"),
  approvalId: v.pipe(v.string(), v.minLength(1)),
  decision: v.picklist(["allow", "deny"]),
  reason: v.optional(v.pipe(v.string(), v.maxLength(1024))),
});

// ------------------------------------------------- External effects (docs/architecture.md §19)

const effectRequestBytes = 32 * 1024;
const effectCommand = <K extends EffectKind, R extends v.GenericSchema>(kind: K, request: R) =>
  v.strictObject({
    type: v.literal("effect.prepare"),
    kind: v.literal(kind),
    /** Omitted: the Workspace's only enabled installation of the kind's provider. */
    integrationId: v.optional(v.pipe(v.string(), v.minLength(1))),
    request: v.pipe(
      request,
      v.check((r) => jsonBytes(r) <= effectRequestBytes, "request must be at most 32 KiB"),
    ),
  });

/** Slack `chat.postMessage`: `channel` is a conversation id (reconcile reads its history by id). */
export const SlackPostRequest = v.strictObject({
  channel: v.pipe(
    v.string(),
    v.regex(/^[CDG][A-Z0-9]{2,}$/, "channel must be a Slack conversation id"),
  ),
  text: v.pipe(v.string(), v.minLength(1), v.maxLength(40_000)),
  threadTs: v.optional(v.pipe(v.string(), v.regex(/^\d+\.\d+$/))),
});
/** GitHub issue / pull request comment. */
export const GithubCommentRequest = v.strictObject({
  owner: v.pipe(v.string(), v.regex(/^[A-Za-z0-9-]{1,39}$/)),
  repo: v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]{1,100}$/)),
  issueNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  body: v.pipe(v.string(), v.minLength(1), v.maxLength(65_536)),
});

/**
 * A Run asks the cloud to write externally. The Bot's `toolPolicy.effects` decides: `deny` → 403, `ask` → a pending
 * approval (the Run waits like for a tool approval), `allow` → performed at once. The same request twice from one Run
 * returns the same effect.
 */
export const EffectPrepare = v.variant("kind", [
  effectCommand("slack.post", SlackPostRequest),
  effectCommand("github.comment", GithubCommentRequest),
]);

/**
 * Manual recovery: `mark_succeeded` (with the external object's id) / `mark_failed` settle an `unknown` effect; `retry`
 * performs an `unknown` or `failed` effect that was performed before (an effect never approved cannot be retried).
 */
export const EffectResolve = v.pipe(
  v.strictObject({
    type: v.literal("effect.resolve"),
    effectId: v.pipe(v.string(), v.minLength(1)),
    action: v.picklist(["mark_succeeded", "mark_failed", "retry"]),
    externalId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(255))),
    externalUrl: v.optional(v.pipe(v.string(), v.url(), v.maxLength(2048))),
  }),
  v.check(
    (c) => (c.action === "mark_succeeded") === (c.externalId !== undefined),
    "externalId is required for mark_succeeded and only for it",
  ),
);

export const effectStates = [
  "prepared",
  "approved",
  "executing",
  "succeeded",
  "failed",
  "unknown",
] as const;
export type EffectState = (typeof effectStates)[number];

/** `GET /v1/run/effects/:id` (what the waiting tool polls) and the items of `GET /v1/effects`. */
export type Effect = {
  id: string;
  runId: string;
  botId: string;
  integrationId: string;
  kind: EffectKind;
  state: EffectState;
  /** The redacted request a human approves (at most 2 KiB). */
  summary: string;
  approvalId: string | null;
  externalId: string | null;
  externalUrl: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

/** `GET /v1/run/approvals/:id`: what the waiting executor polls. `expired` and `denied` both mean deny. */
export type ApprovalStatus = {
  id: string;
  state: "pending" | "approved" | "denied" | "expired";
  argsHash: string;
  expiresAt: string;
  decisionReason: string | null;
};

// ------------------------------------------------- Memory and search (docs/architecture.md §13.6, §14)

export const memoryScopeKinds = ["workspace", "channel", "project", "bot", "task"] as const;

/**
 * Explicit knowledge in one scope; `scopeId` is the Workspace / Channel / Project / Bot / Task id. A Run may write only
 * to its own Bot, its Task or its Conversation's Channel: Workspace scope is a promotion and needs policy (AT-33).
 * `supersedesId` tombstones a memory of the same scope in the same batch.
 */
export const MemoryWrite = v.strictObject({
  type: v.literal("memory.write"),
  scopeKind: v.picklist(memoryScopeKinds),
  scopeId: v.pipe(v.string(), v.minLength(1)),
  content: v.pipe(
    v.string(),
    v.minLength(1),
    v.check((s) => utf8Bytes(s) <= 16 * 1024, "content must be at most 16 KiB"),
  ),
  supersedesId: v.optional(v.pipe(v.string(), v.minLength(1))),
});

/** Tombstone; a memory's content never changes, so a live memory is at revision 1 unless superseded. */
export const MemoryDelete = v.strictObject({
  type: v.literal("memory.delete"),
  memoryId: v.pipe(v.string(), v.minLength(1)),
  expectedRevision: Revision,
});

// ------------------------------------------------- Sidebar (UI-04)

const SidebarItem = v.strictObject({
  /** `dm`: the DM's conversation id. */
  kind: v.picklist(["channel", "bot", "dm"]),
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
});
/**
 * A user's own sidebar in one Workspace: pinned items (in order), hidden items and named groups (each in order).
 * Ids of deleted Channels / Bots may linger; clients skip them.
 */
export const SidebarPrefs = v.pipe(
  v.strictObject({
    pinned: v.array(SidebarItem),
    hidden: v.array(SidebarItem),
    groups: v.array(
      v.strictObject({ name: v.pipe(Name, v.maxLength(80)), items: v.array(SidebarItem) }),
    ),
  }),
  v.check((p) => jsonBytes(p) <= 64 * 1024, "prefs must be at most 64 KiB of JSON"),
);
export type SidebarPrefs = v.InferOutput<typeof SidebarPrefs>;
export const defaultSidebarPrefs: SidebarPrefs = { pinned: [], hidden: [], groups: [] };

/** Replaces the caller's document; `expectedRevision` 0 creates it. A stale revision is 409 REVISION_CONFLICT. */
export const SidebarUpdate = v.strictObject({
  type: v.literal("sidebar.update"),
  prefs: SidebarPrefs,
  expectedRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export type Memory = {
  id: string;
  scopeKind: (typeof memoryScopeKinds)[number];
  scopeId: string;
  content: string;
  sourceKind: "user" | "bot" | "system";
  sourceId: string;
  revision: number;
  supersedesId: string | null;
  createdAt: string;
};

export const searchKinds = ["message", "task", "memory", "run"] as const;
export type SearchKind = (typeof searchKinds)[number];
export type SearchHit = {
  sourceKind: SearchKind;
  sourceId: string;
  title: string;
  /** At most 200 characters; matches are wrapped in `[` `]`. */
  snippet: string;
  scope: string;
  sourceRevision: number;
};
/**
 * `GET /v1/search` / `GET /v1/run/search`. `indexedThrough` is the newest `indexed_at` of the Workspace's index (null
 * when empty): search is a lagging projection (AT-32); Task / Job state comes from the normal queries.
 */
export type SearchResult = {
  hits: SearchHit[];
  indexedThrough: string | null;
  cursor: string | null;
};

/** Task writes need the `task.write` scope and a target in the Run's Task's Project. */
export const RunCommand = v.variant("type", [
  RunAgentSend,
  AgentReply,
  ApprovalRequest,
  TaskCreate,
  TaskAssign,
  TaskPlan,
  TaskComplete,
  TaskDelegate,
  MemoryWrite,
  EffectPrepare,
  SubscriptionCreate,
  SubscriptionUpdate,
  SubscriptionDelete,
  RoutineCreate,
  RoutineUpdate,
  RoutinePause,
  RoutineResume,
  RoutineDelete,
  ChannelCreate,
  BotCreate,
]);
export type RunCommand = v.InferInput<typeof RunCommand>;

export type JobClaimed = {
  runId: string;
  executionId: string;
  executionGeneration: number;
  leaseExpiresAt: string;
  /** `X-Hive-Token` for `/v1/run/*` (§18.2). Returned once: null on a replayed claim. */
  capability: { token: string; expiresAt: string } | null;
  job: { id: string; botId: string; inboxItemId: string | null; placement: PlacementPolicy };
};
export type ClaimFailureReason =
  | "stale_revision"
  | "resource_busy"
  | "already_claimed"
  | "not_eligible";
/** `cancelRequested`: a user asked to cancel the Job; the executor stops the agent (§9.3). */
export type LeaseRenewed = { leaseExpiresAt: string; cancelRequested: boolean };
export type RunResultAccepted = { ok: true };

/** `GET /v1/executor/jobs?state=queued` item. */
export type QueuedJob = {
  id: string;
  botId: string;
  revision: number;
  inboxItemId: string | null;
  placement: PlacementPolicy;
  createdAt: string;
};

type ContextMessage = { actorKind: string; actorId: string; body: string; createdAt: string };
type Speaker = { speakerKind: "human" | "bot"; speakerName: string; isSelf: boolean };
/** A group message as a member Bot reads it (Grok Bot's room turn `new_messages`). */
export type GroupMessage = Speaker & {
  id: string;
  body: string;
  createdAt: string;
  /** The message it replies to, quoted (at most 200 chars). */
  replyTo: (Speaker & { quote: string }) | null;
};

/** `GET /v1/executor/runs/:id`: the device's own Run, for reconcile after a restart. */
/** `GET /v1/executor/jobs/:id/context?runId=&executionGeneration=`: what the adapter builds its prompt from. */
export type RunContext = {
  bot: {
    id: string;
    name: string;
    instructions: string;
    toolPolicy: ToolPolicy;
    /** Always an array from the Worker; optional for stored contexts created before PERM-01. */
    skills?: BotSkill[];
  };
  environment: string | null;
  task: { id: string; key: string; title: string; description: string } | null;
  conversation: {
    id: string;
    channelId: string;
    kind: "channel" | "bot_pair" | "dm" | "thread";
    /** A DM's user, the Bot's counterpart; null otherwise. */
    counterpart: { actorId: string; name: string } | null;
    /** The last 20 messages, oldest first; a thread's start with its root message. */
    recent: ContextMessage[];
  } | null;
  /** A thread's parent Channel / DM: up to 20 messages before the root, oldest first (read-only context). */
  parentMessages: ContextMessage[];
  /**
   * In a Channel's main conversation (group chat, ROUTE-02): the other member Bots (`description` = first line of their
   * instructions, at most 120 chars) and the messages since this Bot's previous Run there (at most 50, oldest first).
   * Empty elsewhere.
   */
  peers: { id: string; name: string; description: string }[];
  since: GroupMessage[];
  /** `fromBot` is set when another Bot sent the message (kind `request` / `notification`). */
  inboxItem: {
    id: string;
    body: string;
    messageId: string | null;
    kind: string | null;
    fromBot: { id: string; name: string } | null;
  } | null;
  /** A batch Job's sealed Inbox batch, items oldest first; `inboxItem` is then null. */
  batch: { id: string; items: { id: string; body: string }[] } | null;
  /** Replies to requests this Job's Runs sent (§8.2), oldest first: what a successor Run continues from. */
  replies: {
    messageId: string;
    requestMessageId: string;
    fromBot: { id: string; name: string };
    body: string;
    createdAt: string;
  }[];
  /** Up to 20 live memories of the Bot, the Task and the Conversation's Channel, newest first, at most 8 KiB. */
  memories: { id: string; scopeKind: string; content: string; createdAt: string }[];
  /** Up to 5 search hits for the trigger item's body (never the trigger message itself). */
  related: { sourceKind: SearchKind; sourceId: string; title: string; snippet: string }[];
  /** The native session of the latest earlier Run of this Job that reported one: what a successor resumes (§13.3). */
  previousProviderSessionId: string | null;
  /** Set when this Job works a task.delegate (§8.1); task writes need `mode: write`. */
  delegation: {
    id: string;
    mode: "read" | "write";
    deadline: string | null;
    fromBot: { id: string; name: string } | null;
    fromUser: { id: string } | null;
    instructions: string;
  } | null;
};

/**
 * `POST /v1/executor/observations` (§9.2 step 7). Stored kinds: `runtime.run.started` with
 * `payload.providerSessionId` (Run `running`, `started_at`), `runtime.run.stopped` with `payload.confirmed: true`
 * (an `unknown` Run becomes `interrupted` and releases its reservations), and `git.collected` (`GitCollected`, stored in
 * `run_git`). Other kinds are accepted (202) and dropped.
 */
export const RunObservation = v.strictObject({
  runId: RunId,
  executionGeneration: Generation,
  kind: Name,
  payload: v.optional(v.record(v.string(), v.unknown()), {}),
});
export type RunObservation = v.InferInput<typeof RunObservation>;

const Str = (max: number) => v.pipe(v.string(), v.maxLength(max));
/**
 * Payload of the `git.collected` observation (GIT-01): what Git produced in a Run's environment checkout. One per Run;
 * the first stored wins. `repository` is `host/owner/repo` ('' without a remote); never a local path.
 */
export const GitCollected = v.strictObject({
  repository: Str(300),
  branch: Str(300),
  before: Str(64),
  after: Str(64),
  commits: v.pipe(
    v.array(v.strictObject({ sha: Str(64), subject: Str(1000), authoredAt: Str(64) })),
    v.maxLength(200),
  ),
  /** `before` was not an ancestor of HEAD (branch switch, rewrite): commits are those since the Run started. */
  partial: v.boolean(),
  prs: v.pipe(
    v.array(
      v.strictObject({
        number: v.pipe(v.number(), v.integer()),
        url: Str(2000),
        state: Str(50),
        title: Str(1000),
      }),
    ),
    v.maxLength(20),
  ),
  prError: v.optional(Str(500)),
});
export type GitCollected = v.InferOutput<typeof GitCollected>;

export type ExecutorRun = {
  id: string;
  jobId: string;
  state: string;
  executionGeneration: number;
  active: boolean;
};

// ------------------------------------------------ Transcript upload (§3.3, §13.2)

/** Largest part the cloud accepts; the executor splits at 1 MiB on line boundaries. */
export const maxTranscriptPartBytes = 8 * 1024 * 1024;

const Sha256Hex = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));

/**
 * A native provider session stream (§13.3) instead of the Run's transcript. `subpath` is opaque (a sub-agent
 * transcript); omitted for the main one.
 */
export const SessionStreamKey = v.strictObject({
  sessionId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,128}$/)),
  subpath: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(512))),
});
export type SessionStreamKey = v.InferInput<typeof SessionStreamKey>;

/** `session` needs `provider`: it is part of the session key. */
export const UploadInit = v.strictObject({
  runId: RunId,
  partSeq: v.pipe(v.number(), v.integer(), v.minValue(0)),
  byteSize: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maxTranscriptPartBytes)),
  sha256: Sha256Hex,
  provider: v.optional(Name),
  session: v.optional(SessionStreamKey),
});
export type UploadInit = v.InferInput<typeof UploadInit>;
/** `committed`: the part is already in the manifest with this hash, so the PUT can be skipped. */
export type UploadInitialized = { uploadId: string; partId: string; committed: boolean };

/** `lastPartSeq` -1: the Run produced an empty transcript. */
export const UploadComplete = v.strictObject({
  runId: RunId,
  lastPartSeq: v.pipe(v.number(), v.integer(), v.minValue(-1)),
  session: v.optional(SessionStreamKey),
});
export type UploadComplete = v.InferInput<typeof UploadComplete>;

/** One normalized transcript entry (§13.2): derived from the raw parts at read time, redacted, ≤ 4 KiB text. */
export type TranscriptEntry = {
  /** Line number in the raw stream; the blocks of one message share it. */
  seq: number;
  kind: "system" | "assistant" | "tool_use" | "tool_result" | "result" | "user" | "other";
  text: string;
  toolName?: string;
};

// docs/architecture.md §22.5
export const apiErrorStatus = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  STALE_GENERATION: 409,
  RESOURCE_BUSY: 409,
  CURSOR_EXPIRED: 410,
  INVALID_INPUT: 422,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 503,
} as const;
export type ApiErrorCode = keyof typeof apiErrorStatus;

export const ApiError = v.strictObject({
  code: v.picklist(Object.keys(apiErrorStatus) as [ApiErrorCode, ...ApiErrorCode[]]),
  message: v.string(),
  requestId: v.string(),
  operationId: v.nullable(v.string()),
  retryable: v.boolean(),
  /** Safe machine-readable detail, e.g. a claim failure reason. */
  reason: v.optional(v.string()),
});
export type ApiError = v.InferOutput<typeof ApiError>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

export const parse = <TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: unknown,
): ParseResult<v.InferOutput<TSchema>> => {
  const result = v.safeParse(schema, input);
  if (result.success) return { ok: true, value: result.output };
  return {
    ok: false,
    issues: result.issues.map((issue) => {
      const path = v.getDotPath(issue);
      return path ? `${path}: ${issue.message}` : issue.message;
    }),
  };
};
