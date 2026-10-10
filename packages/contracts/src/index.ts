import * as v from "valibot";

const id = <const Name extends string>(name: Name) =>
  v.pipe(v.string(), v.minLength(1), v.brand(name));

export const WorkspaceId = id("WorkspaceId");
export const UserId = id("UserId");
export const DeviceId = id("DeviceId");
export const BotId = id("BotId");
export const ChannelId = id("ChannelId");
export const JobId = id("JobId");
export const RunId = id("RunId");
export type WorkspaceId = v.InferOutput<typeof WorkspaceId>;
export type UserId = v.InferOutput<typeof UserId>;
export type DeviceId = v.InferOutput<typeof DeviceId>;
export type BotId = v.InferOutput<typeof BotId>;
export type ChannelId = v.InferOutput<typeof ChannelId>;
export type JobId = v.InferOutput<typeof JobId>;
export type RunId = v.InferOutput<typeof RunId>;

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

const DeviceIds = v.optional(v.array(DeviceId), []);

// docs/architecture.md §3.2, §10.2. Every field defaults, so `{}` means "any eligible device".
export const PlacementPolicy = v.strictObject({
  mode: v.optional(v.picklist(["pinned", "preferred", "any"]), "any"),
  allowedDeviceIds: DeviceIds,
  preferredDeviceIds: DeviceIds,
  fallbackOnUnavailable: v.optional(v.boolean(), true),
  overflowToFallback: v.optional(v.boolean(), false),
  environmentId: v.optional(Name),
  requiredCapabilities: v.optional(v.array(Name), []),
  recovery: v.optional(v.picklist(["manual", "safe_auto"]), "manual"),
});
export type PlacementPolicy = v.InferOutput<typeof PlacementPolicy>;

export const BotCreate = v.strictObject({
  type: v.literal("bot.create"),
  name: Name,
  placementPolicy: v.optional(PlacementPolicy, {}),
});

// docs/architecture.md §5.3, §7.2. Direct delivery to a Bot's Inbox; lane = channel.
export const AgentSend = v.strictObject({
  type: v.literal("agent.send"),
  recipientBotId: BotId,
  channelId: ChannelId,
  message: v.strictObject({
    kind: v.picklist(["request", "notification"]),
    text: v.pipe(v.string(), v.minLength(1), v.maxLength(64 * 1024)),
  }),
  delivery: v.picklist(["wake", "notify"]),
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
export type EventEmitAccepted = {
  operationId: string;
  status: "accepted";
  eventId: string;
  receivedAt: string;
};

// ------------------------------------------------- Executor (§9.2, §10.3)
// Device principal only, same envelope as user commands (`commandEnvelope`).

/** Defaults to `["bot:<botId>"]` on the server: one root Run per Bot at a time. */
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
  state: v.picklist(["succeeded", "failed"]),
  summary: v.pipe(
    v.string(),
    v.check((s) => utf8Bytes(s) <= 8 * 1024, "summary must be at most 8 KiB"),
  ),
  error: v.optional(v.pipe(v.string(), v.maxLength(8 * 1024))),
});

export const ExecutorCommand = v.variant("type", [JobClaim, RunLeaseRenew, RunResultSubmit]);
export type ExecutorCommand = v.InferInput<typeof ExecutorCommand>;

export type JobClaimed = {
  runId: string;
  executionId: string;
  executionGeneration: number;
  leaseExpiresAt: string;
  job: { id: string; botId: string; inboxItemId: string | null; placement: PlacementPolicy };
};
export type ClaimFailureReason =
  | "stale_revision"
  | "resource_busy"
  | "already_claimed"
  | "not_eligible";
export type LeaseRenewed = { leaseExpiresAt: string };
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

/** `GET /v1/executor/runs/:id`: the device's own Run, for reconcile after a restart. */
export type ExecutorRun = {
  id: string;
  jobId: string;
  state: string;
  executionGeneration: number;
  active: boolean;
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
