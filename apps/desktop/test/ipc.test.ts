import { createClient } from "@hive/cli/client";
import { describe, expect, it, vi } from "vitest";
import { type Credentials, type Deps, run } from "@hive/cli/cli";
import { attachmentHandlers, handlers, setupHandlers } from "../src/main/ipc.ts";

const setup = (respond: () => Response = () => Response.json({ ok: true })) => {
  const requests: { path: string; jwt: string | null; body: unknown }[] = [];
  const client = createClient({
    apiUrl: "https://hive.test",
    accessJwt: "jwt",
    fetch: async (url, init) => {
      requests.push({
        path: `${url.pathname}${url.search}`,
        jwt: new Headers(init.headers).get("Cf-Access-Jwt-Assertion"),
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      return respond();
    },
  });
  return { h: handlers(client), requests };
};

const envelope = {
  operationId: "op-1",
  idempotencyKey: "key-1",
  workspaceId: "ws-1",
  command: {
    type: "agent.send",
    recipientBotId: "bot-1",
    channelId: "ch-1",
    message: { kind: "request", text: "hi" },
    delivery: "wake",
  },
};

describe("IPC handlers", () => {
  it("passes /v1 GETs through with the Access header injected by main", async () => {
    const { h, requests } = setup();
    expect(await h.get("/v1/sync/changes?workspaceId=ws-1&cursor=eyJ3_-")).toEqual({
      ok: true,
      value: { ok: true },
    });
    expect(requests).toEqual([
      { path: "/v1/sync/changes?workspaceId=ws-1&cursor=eyJ3_-", jwt: "jwt", body: undefined },
    ]);
  });

  it.each([
    "/v1/../admin",
    "/v1/jobs/%2e%2e/x",
    "/v1/jobs/a.b",
    "/v2/jobs",
    "//evil.test/v1/jobs",
    "https://evil.test/v1/jobs",
    "/v1/jobs?x=..",
    "/v1/jobs#frag",
    "/v1",
    42,
  ])("rejects the path %s without a request", async (path) => {
    const { h, requests } = setup();
    expect(await h.get(path)).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    expect(requests).toEqual([]);
  });

  it.each([
    ["not an object", "x"],
    ["another command type", { ...envelope, command: { type: "bot.create", name: "b" } }],
    ["an extra field", { ...envelope, extra: 1 }],
    [
      "an empty message",
      { ...envelope, command: { ...envelope.command, message: { kind: "request", text: "" } } },
    ],
    ["no idempotency key", { ...envelope, idempotencyKey: undefined }],
  ])("rejects a command envelope with %s", async (_, input) => {
    const { h, requests } = setup();
    expect(await h.command(input)).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    expect(requests).toEqual([]);
  });

  it("posts a job.cancel envelope", async () => {
    const { h, requests } = setup();
    const cancel = { ...envelope, command: { type: "job.cancel", jobId: "job-1" } };
    expect((await h.command(cancel)).ok).toBe(true);
    expect(requests[0]).toMatchObject({ path: "/v1/commands", body: cancel });
  });

  it("posts an approval.resolve envelope and rejects a bad decision", async () => {
    const { h, requests } = setup();
    const resolve = {
      ...envelope,
      command: { type: "approval.resolve", approvalId: "a-1", decision: "deny", reason: "no" },
    };
    expect((await h.command(resolve)).ok).toBe(true);
    expect(requests[0]).toMatchObject({ path: "/v1/commands", body: resolve });
    const rejected = await Promise.all(
      [
        { type: "approval.resolve", approvalId: "a-1", decision: "approve" },
        { type: "approval.resolve", approvalId: "", decision: "allow" },
        { type: "approval.resolve", approvalId: "a-1", decision: "allow", argsHash: "x" },
      ].map((command) => h.command({ ...envelope, command })),
    );
    for (const result of rejected) {
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    }
    expect(requests).toHaveLength(1);
  });

  it("passes a search query encoded by URLSearchParams and posts memory.write", async () => {
    const { h, requests } = setup();
    const path = `/v1/search?${new URLSearchParams({ workspaceId: "ws-1", q: "deploy staging レビュー*" })}`;
    expect((await h.get(path)).ok).toBe(true);
    const write = {
      ...envelope,
      command: { type: "memory.write", scopeKind: "bot", scopeId: "bot-1", content: "x" },
    };
    expect((await h.command(write)).ok).toBe(true);
    expect(requests.map((r) => r.path)).toEqual([path, "/v1/commands"]);
  });

  it("posts routine pause / resume / run / delete and rejects invalid routine commands", async () => {
    const { h, requests } = setup();
    const accepted = await Promise.all(
      ["routine.pause", "routine.resume", "routine.run", "routine.delete"].map((type) =>
        h.command({ ...envelope, command: { type, routineId: "r-1" } }),
      ),
    );
    expect(accepted.map((r) => r.ok)).toEqual([true, true, true, true]);
    const rejected = await Promise.all(
      [
        { type: "routine.pause", routineId: "" },
        { type: "routine.run", routineId: "r-1", extra: 1 },
        { type: "routine.create", botId: "bot-1", name: "x" },
      ].map((command) => h.command({ ...envelope, command })),
    );
    for (const result of rejected) {
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    }
    expect(requests.map((r) => (r.body as { command: { type: string } }).command.type)).toEqual([
      "routine.pause",
      "routine.resume",
      "routine.run",
      "routine.delete",
    ]);
  });

  it("posts channel.update and rejects a topic over 250 chars", async () => {
    const { h, requests } = setup();
    const update = (topic: string) =>
      h.command({ ...envelope, command: { type: "channel.update", channelId: "ch-1", topic } });
    expect((await update("Daily ops")).ok).toBe(true);
    expect(await update("x".repeat(251))).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGS" },
    });
    expect(requests).toHaveLength(1);
  });

  it("posts sidebar.update and rejects an unknown item kind", async () => {
    const { h, requests } = setup();
    const update = (kind: string) =>
      h.command({
        ...envelope,
        command: {
          type: "sidebar.update",
          prefs: { pinned: [{ kind, id: "ch-1" }], hidden: [], groups: [] },
          expectedRevision: 0,
        },
      });
    expect((await update("channel")).ok).toBe(true);
    expect(await update("task")).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    expect(requests).toHaveLength(1);
  });

  it("posts message.post and rejects an unknown field", async () => {
    const { h, requests } = setup();
    const post = (command: Record<string, unknown>) =>
      h.command({ ...envelope, command: { type: "message.post", channelId: "ch-1", ...command } });
    expect((await post({ text: "<@bot:bot-1> hi", mentions: ["bot-1"] })).ok).toBe(true);
    expect(await post({ text: "hi", recipientBotId: "bot-1" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGS" },
    });
    expect(requests).toHaveLength(1);
  });

  it("posts a valid agent.send envelope", async () => {
    const { h, requests } = setup();
    expect((await h.command(envelope)).ok).toBe(true);
    expect(requests[0]).toMatchObject({ path: "/v1/commands", body: envelope });
  });

  it("maps an ApiError response to a typed error result", async () => {
    const body = {
      code: "CURSOR_EXPIRED",
      message: "cursor expired",
      requestId: "r",
      operationId: null,
      retryable: false,
    };
    const { h } = setup(() => Response.json(body, { status: 410 }));
    expect(await h.get("/v1/sync/changes?workspaceId=ws-1&cursor=x")).toEqual({
      ok: false,
      error: { code: "CURSOR_EXPIRED", message: "cursor expired", body },
    });
  });
});

describe("attachment IPC", () => {
  it("rejects unsafe local paths before upload", async () => {
    const upload = vi.fn(async () => ({ id: "att-1" }));
    const h = attachmentHandlers({
      upload,
      paste: async () => ({ id: "att-paste" }),
      dataUrl: async () => "data:image/png;base64,AA==",
      save: async () => true,
    });
    const results = await Promise.all(
      ["relative.txt", "../outside.txt", "/tmp/\0file"].map((path) =>
        h.upload({
          target: { workspaceId: "ws-1", channelId: "ch-1" },
          path,
        }),
      ),
    );
    expect(results).toMatchObject([
      { ok: false, error: { code: "INVALID_ARGS" } },
      { ok: false, error: { code: "INVALID_ARGS" } },
      { ok: false, error: { code: "INVALID_ARGS" } },
    ]);
    expect(upload).not.toHaveBeenCalled();
  });

  it("returns only attachment metadata, never the Access assertion", async () => {
    const accessAssertion = "private-access-assertion";
    const h = attachmentHandlers({
      upload: async () => ({
        id: "att-1",
        name: "notes.md",
        contentType: "text/markdown",
        size: 8,
      }),
      paste: async () => ({ id: "att-paste" }),
      dataUrl: async () => `data:image/png;base64,${accessAssertion}`,
      save: async () => true,
    });
    const uploaded = await h.upload({
      target: { workspaceId: "ws-1", channelId: "ch-1" },
      path: "/tmp/notes.md",
    });
    expect(uploaded).toEqual({
      ok: true,
      value: { id: "att-1", name: "notes.md", contentType: "text/markdown", size: 8 },
    });
    expect(JSON.stringify(uploaded)).not.toContain(accessAssertion);
  });

  it("validates clipboard image upload targets before main reads the clipboard", async () => {
    const paste = vi.fn(async () => ({ id: "att-paste" }));
    const h = attachmentHandlers({
      upload: async () => ({ id: "att-1" }),
      paste,
      dataUrl: async () => "data:image/png;base64,AA==",
      save: async () => true,
    });
    expect(await h.paste({ target: { workspaceId: "ws-1" } })).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGS" },
    });
    expect(paste).not.toHaveBeenCalled();
    expect(await h.paste({ target: { workspaceId: "ws-1", channelId: "ch-1" } })).toEqual({
      ok: true,
      value: { id: "att-paste" },
    });
    expect(paste).toHaveBeenCalledWith({ workspaceId: "ws-1", channelId: "ch-1" });
  });
});

/** The CLI's real `run` over fake deps, wired like main (stdout dropped, stderr collected). */
const setupWith = (respond: () => Response) => {
  const saved: Credentials[] = [];
  const requests: unknown[] = [];
  let reconciled = 0;
  const deps = {
    fetch: async (_url: URL, init: RequestInit) => {
      requests.push(JSON.parse(init.body as string));
      return respond();
    },
    loadCredentials: async () => ({
      apiUrl: "http://localhost:8787",
      accessJwt: "jwt",
      workspaceId: "ws-1",
    }),
    saveCredentials: async (patch: Credentials) => {
      saved.push(patch);
      return {};
    },
    stdout: () => {},
    stderr: () => {},
  } as unknown as Deps;
  const h = setupHandlers({
    save: async (patch) => void saved.push(patch),
    cli: async (argv) => {
      const stderr: string[] = [];
      const code = await run(argv, { ...deps, stderr: (l) => stderr.push(l) });
      return { code, stderr };
    },
    os: "darwin",
    agentVersion: "0.0.0",
    reconcile: async () => void reconciled++,
  });
  return { h, saved, requests, reconciled: () => reconciled };
};

describe("setup IPC (config.set, logout, device.register)", () => {
  it("config.set accepts https or http://localhost and rejects anything else", async () => {
    const { h, saved } = setupWith(() => Response.json({}));
    expect(await h.configSet({ apiUrl: "http://localhost:8787" })).toEqual({ ok: true, value: {} });
    expect(
      await h.configSet({ apiUrl: " https://api.example.com ", workspaceId: "ws-dev" }),
    ).toEqual({ ok: true, value: {} });
    expect(saved).toEqual([
      { apiUrl: "http://localhost:8787" },
      { apiUrl: "https://api.example.com", workspaceId: "ws-dev" },
    ]);
    const bad = [
      { apiUrl: "http://api.example.com" },
      { apiUrl: "file:///etc/passwd" },
      { apiUrl: "not a url" },
      { workspaceId: "" },
      { deviceToken: "x" },
      {},
    ];
    for (const result of await Promise.all(bad.map(h.configSet)))
      expect(result).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    expect(saved).toHaveLength(2);
  });

  it("device.register runs `hive device register`, saves the token, reconciles and never returns it", async () => {
    const { h, saved, requests, reconciled } = setupWith(() =>
      Response.json({ deviceId: "dev-1", deviceToken: "dev-1.secret" }),
    );
    const result = await h.deviceRegister({ name: " studio " });
    expect(result).toEqual({ ok: true, value: {} });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(requests).toMatchObject([
      {
        workspaceId: "ws-1",
        command: { type: "device.register", name: "studio", os: "darwin", agentVersion: "0.0.0" },
      },
    ]);
    expect(saved).toEqual([{ apiUrl: "http://localhost:8787", deviceToken: "dev-1.secret" }]);
    expect(reconciled()).toBe(1);
    expect(await h.deviceRegister({ name: "" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGS" },
    });
  });

  it("device.register maps a failed command to an error and skips the reconcile", async () => {
    const { h, reconciled } = setupWith(() =>
      Response.json(
        { code: "FORBIDDEN", message: "not a member", retryable: false },
        { status: 403 },
      ),
    );
    expect(await h.deviceRegister({ name: "studio" })).toMatchObject({
      ok: false,
      error: { code: "COMMAND_FAILED", message: expect.stringContaining("not a member") },
    });
    expect(reconciled()).toBe(0);
  });

  it("logout runs `hive logout`, which drops only the OAuth grant", async () => {
    const { h, saved } = setupWith(() => Response.json({}));
    expect(await h.logout()).toEqual({ ok: true, value: {} });
    expect(saved).toEqual([{ oauth: undefined }]);
  });
});
