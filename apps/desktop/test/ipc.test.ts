import { createClient } from "@hive/cli/client";
import { describe, expect, it } from "vitest";
import { handlers } from "../src/main/ipc.ts";

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

  it("posts routine pause / resume / run and rejects other routine commands", async () => {
    const { h, requests } = setup();
    const accepted = await Promise.all(
      ["routine.pause", "routine.resume", "routine.run"].map((type) =>
        h.command({ ...envelope, command: { type, routineId: "r-1" } }),
      ),
    );
    expect(accepted.map((r) => r.ok)).toEqual([true, true, true]);
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
    ]);
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
