// Fixtures shaped like the api-worker responses (apps/api-worker/src/queries.ts): one workspace, two channels, two
// bots. `routes()` returns a fresh GET map per test, keyed by pathname.
import type { Routes } from "./fakeHive.ts";

export const ws = "ws-1";
export const me = "user-1";

export const channels = [
  {
    id: "ch-1",
    name: "general",
    topic: null,
    conversationId: "conv-1",
    role: "owner",
    memberCount: 2,
    createdAt: "2026-10-01T09:00:00.000Z",
    lastMessage: {
      body: "- **Fixed** the `build`\nand more",
      createdAt: "2026-10-11T10:01:00.000Z",
      actorId: "actor-bot-1",
    },
  },
  {
    id: "ch-2",
    name: "release",
    topic: "Ship it",
    conversationId: "conv-2",
    role: "member",
    memberCount: 1,
    createdAt: "2026-10-02T09:00:00.000Z",
    lastMessage: null,
  },
];

export const bots = [
  {
    id: "bot-1",
    actorId: "actor-bot-1",
    name: "coder",
    instructions: "Write small diffs.",
    placementPolicy: {},
    toolPolicy: { bash: "ask" },
    revision: 1,
  },
  {
    id: "bot-2",
    actorId: "actor-bot-2",
    name: "reviewer",
    instructions: null,
    placementPolicy: {},
    toolPolicy: {},
    revision: 1,
  },
];

/** Newest first, as the API returns them. */
export const messages = [
  {
    id: "msg-2",
    conversationId: "conv-1",
    seq: 2,
    actorId: "actor-bot-1",
    userId: null,
    body: "**Done**\n- one\n- two\n\nRun `bun test`",
    createdAt: "2026-10-11T10:01:00.000Z",
  },
  {
    id: "msg-1",
    conversationId: "conv-1",
    seq: 1,
    actorId: "actor-user-1",
    userId: me,
    body: "please fix the build",
    createdAt: "2026-10-11T10:00:00.000Z",
  },
];

export const routines = [
  {
    id: "rt-1",
    botId: "bot-1",
    name: "Daily digest",
    conversationId: "conv-1",
    taskId: null,
    inputText: "Summarize the day",
    // Key order as stored: the editor compares schedules by JSON.
    schedule: { kind: "cron", expr: "0 9 * * 1-5", timezone: "UTC" },
    scheduleRevision: 1,
    misfire: "coalesce",
    enabled: true,
    revision: 3,
  },
];

export const executorStatus = {
  registered: true,
  installed: true,
  pid: 4242,
  provider: "claude",
  concurrency: 1,
  program: ["/usr/local/bin/bun"],
  logs: { stdout: "/tmp/hive.out.log", stderr: "/tmp/hive.err.log" },
};

export const routes = (): Routes => ({
  "/v1/sync/changes": { changes: [], cursor: "H0", hasMore: false },
  "/v1/me": { userId: me },
  "/v1/channels": { channels },
  "/v1/bots": { bots },
  "/v1/sidebar": {
    workspaceName: "acme",
    prefs: { pinned: [], hidden: [], groups: [] },
    revision: 0,
  },
  "/v1/devices": {
    devices: [
      {
        id: "dev-1",
        name: "studio",
        os: "darwin",
        capabilities: ["claude", "git"],
        capacityBackground: 2,
        lastHeartbeatAt: new Date().toISOString(),
        revokedAt: null,
      },
    ],
  },
  "/v1/jobs": {
    jobs: [{ id: "job-1", botId: "bot-1", state: "active", cancelRequestedAt: null }],
  },
  "/v1/approvals": {
    approvals: [
      {
        id: "ap-1",
        botId: "bot-1",
        botName: "coder",
        actionKind: "bash",
        argsSummary: "rm -rf build",
        cwdLabel: "hive",
        state: "pending",
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      },
    ],
  },
  "/v1/inbox": (q) => ({
    items:
      q.get("botId") === "bot-1"
        ? [{ id: "in-1", lane: "conv-1", delivery: "wake", state: "done", createdAt: "x" }]
        : [],
  }),
  "/v1/channels/ch-1/messages": { messages },
  "/v1/channels/ch-2/messages": {
    messages: [
      {
        id: "msg-3",
        conversationId: "conv-2",
        seq: 1,
        actorId: "actor-bot-2",
        userId: null,
        body: "release notes ready",
        createdAt: "2026-10-11T11:00:00.000Z",
      },
    ],
  },
  "/v1/channels/ch-1/members": {
    members: [
      {
        actorId: "actor-user-1",
        kind: "user",
        name: "Mina",
        userId: me,
        botId: null,
        role: "owner",
      },
      {
        actorId: "actor-bot-1",
        kind: "bot",
        name: "coder",
        userId: null,
        botId: "bot-1",
        role: null,
      },
    ],
  },
  "/v1/routines": (q) => ({
    routines: routines.filter(
      (r) =>
        (!q.get("botId") || r.botId === q.get("botId")) &&
        (!q.get("conversationId") || r.conversationId === q.get("conversationId")),
    ),
  }),
  "/v1/memories": (q) => ({
    memories:
      q.get("scopeKind") === "bot"
        ? [{ id: "mem-2", content: "prefers bun", createdAt: "2026-10-10" }]
        : [{ id: "mem-1", content: "deploys on Fridays are frozen", createdAt: "2026-10-09" }],
  }),
  "/v1/search": (q) => ({
    indexedThrough: "2026-10-11T12:00:00.000Z",
    hits: [
      {
        sourceKind: "message",
        sourceId: "msg-3",
        title: null,
        snippet: `[${q.get("q")}] notes ready`,
        scope: "channel:ch-2",
      },
    ],
  }),
});
