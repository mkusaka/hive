import { describe, expect, it } from "vitest";
import { type Credentials, type Deps, run } from "../src/cli.ts";
import { exitCodeFor } from "../src/client.ts";

type Call = { method: string; path: string; headers: Headers; body: unknown };

/** Fake deps: `respond` answers each request; output and requests are recorded. */
const harness = (
  respond: (call: Call) => Response | Promise<Response> = () => Response.json({ ok: true }),
  { creds = {}, stdin = "" }: { creds?: Credentials; stdin?: string } = {},
) => {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const saved: Credentials[] = [];
  const deps: Deps = {
    fetch: async (url, init) => {
      const call = {
        method: init.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        headers: new Headers(init.headers),
        body: init.body ? JSON.parse(init.body as string) : undefined,
      };
      calls.push(call);
      return respond(call);
    },
    loadCredentials: async () => ({
      apiUrl: "https://hive.test",
      accessJwt: "jwt",
      workspaceId: "ws-1",
      ...creds,
    }),
    saveCredentials: async (patch) => {
      saved.push(patch);
      return { tokenFile: "/cfg/hive/device-token" };
    },
    readInput: async (path) => (path === "-" ? stdin : `{"file":"${path}"}`),
    stdout: (line) => void out.push(line),
    stderr: (line) => void err.push(line),
    runExecutor: async () => null,
    pollMs: 1,
  };
  return { deps, calls, out, err, saved, hive: (...argv: string[]) => run(argv, deps) };
};

const apiError = (status: number, code: string) =>
  Response.json(
    { code, message: code, requestId: "r", operationId: null, retryable: false },
    { status },
  );

describe("argv → request", () => {
  it("agent send builds the command envelope with the Access assertion", async () => {
    const h = harness();
    const code = await h.hive(
      "agent",
      "send",
      "bot-1",
      "--channel",
      "ch-1",
      "--message",
      "check PR #123",
      "--idempotency-key",
      "k-1",
      "--operation-id",
      "op-1",
    );
    expect(code).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.path).toBe("/v1/commands");
    expect(h.calls[0]!.headers.get("Cf-Access-Jwt-Assertion")).toBe("jwt");
    expect(h.calls[0]!.body).toEqual({
      operationId: "op-1",
      idempotencyKey: "k-1",
      workspaceId: "ws-1",
      command: {
        type: "agent.send",
        recipientBotId: "bot-1",
        channelId: "ch-1",
        message: { kind: "request", text: "check PR #123" },
        delivery: "wake",
      },
    });

    await h.hive(
      "agent",
      "send",
      "bot-1",
      "--channel",
      "ch-1",
      "--message",
      "fyi",
      "--notify",
      "--workspace",
      "ws-2",
    );
    expect(h.calls[1]!.body).toMatchObject({
      workspaceId: "ws-2",
      command: { message: { kind: "notification" }, delivery: "notify" },
    });
    // Fresh keys per invocation.
    const keys = h.calls.map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("list and sync commands GET with the workspace query", async () => {
    const h = harness();
    expect(await h.hive("channel", "list")).toBe(0);
    expect(await h.hive("bot", "list", "--workspace", "ws-2")).toBe(0);
    expect(await h.hive("device", "list")).toBe(0);
    expect(await h.hive("sync", "changes")).toBe(0);
    expect(await h.hive("sync", "changes", "--cursor", "c-1")).toBe(0);
    expect(h.calls.map((c) => [c.method, c.path])).toEqual([
      ["GET", "/v1/channels?workspaceId=ws-1"],
      ["GET", "/v1/bots?workspaceId=ws-2"],
      ["GET", "/v1/devices?workspaceId=ws-1"],
      ["GET", "/v1/sync/changes?workspaceId=ws-1"],
      ["GET", "/v1/sync/changes?workspaceId=ws-1&cursor=c-1"],
    ]);
  });

  it("event emit reads --data-file - from stdin and parses --subject", async () => {
    const h = harness(undefined, { stdin: '{"command":"bun test","exitCode":1}\n' });
    const code = await h.hive(
      "event",
      "emit",
      "custom.build.failed",
      "--data-file",
      "-",
      "--subject",
      "repo:a:b",
    );
    expect(code).toBe(0);
    expect((h.calls[0]!.body as { command: unknown }).command).toEqual({
      type: "event.emit",
      event: {
        type: "custom.build.failed",
        data: { command: "bun test", exitCode: 1 },
        subject: { kind: "repo", id: "a:b" },
      },
    });
  });

  it("rejects invalid input locally with exit 2 and sends nothing", async () => {
    const h = harness(undefined, { stdin: "not json" });
    expect(await h.hive("event", "emit", "custom.x", "--data-file", "-")).toBe(2);
    expect(await h.hive("agent", "send", "bot-1", "--message", "x")).toBe(2); // no --channel
    expect(
      await h.hive("agent", "send", "b", "--channel", "c", "--message", "x", "--notify", "--wait"),
    ).toBe(2);
    expect(await h.hive("nope")).toBe(2);
    expect(await h.hive("job", "get", "j", "--bogus")).toBe(2);
    expect(h.calls).toEqual([]);
  });
});

describe("exit codes", () => {
  it("maps ApiError statuses per §23", async () => {
    const cases: [number, string, number][] = [
      [422, "INVALID_INPUT", 2],
      [401, "UNAUTHENTICATED", 3],
      [403, "FORBIDDEN", 3],
      [409, "IDEMPOTENCY_CONFLICT", 4],
      [404, "NOT_FOUND", 7],
      [503, "UPSTREAM_UNAVAILABLE", 7],
    ];
    const results = await Promise.all(
      cases.map(async ([status, code]) => {
        const h = harness(() => apiError(status, code));
        return [await h.hive("job", "get", "j-1"), h.err[0]];
      }),
    );
    expect(results).toEqual(cases.map(([, code, exit]) => [exit, `error: ${code}: ${code}`]));
    expect(exitCodeFor(500)).toBe(7);
  });

  it("is 7 on a network failure and 3 without an Access assertion", async () => {
    const down = harness(() => Promise.reject(new TypeError("fetch failed")));
    expect(await down.hive("job", "get", "j-1")).toBe(7);
    const anon = harness(undefined, { creds: { accessJwt: undefined } });
    expect(await anon.hive("job", "get", "j-1")).toBe(3);
    expect(anon.calls).toEqual([]);
  });
});

const jobs = (...states: string[]) => {
  let i = 0;
  return () => Response.json({ id: "j-1", state: states[Math.min(i++, states.length - 1)] });
};

describe("job watch", () => {
  it("polls until a terminal state: succeeded 0, failed 5", async () => {
    const ok = harness(jobs("queued", "active", "active", "succeeded"));
    expect(await ok.hive("job", "watch", "j-1")).toBe(0);
    expect(ok.calls.map((c) => c.path)).toEqual(Array(4).fill("/v1/jobs/j-1"));
    expect(ok.err).toEqual(["job state: queued", "job state: active", "job state: succeeded"]);
    expect(ok.out).toEqual(["id: j-1", "state: succeeded"]);

    const failed = harness(jobs("active", "failed"));
    expect(await failed.hive("job", "watch", "j-1", "--format", "json")).toBe(5);
    expect(failed.out).toEqual(['{"id":"j-1","state":"failed"}']);
  });

  it("times out with 6 without cancelling", async () => {
    const h = harness(jobs("active"));
    expect(await h.hive("job", "watch", "j-1", "--timeout", "0.02")).toBe(6);
    expect(h.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("agent send --wait follows the operation to its Job", async () => {
    let opPolls = 0;
    const h = harness((call) => {
      if (call.path === "/v1/commands") return Response.json({ operationId: "op-1", jobId: null });
      if (call.path === "/v1/operations/op-1") {
        return Response.json({ operationId: "op-1", jobId: ++opPolls > 1 ? "j-1" : null });
      }
      return Response.json({ id: "j-1", state: "succeeded" });
    });
    const code = await h.hive(
      "agent",
      "send",
      "b",
      "--channel",
      "c",
      "--message",
      "x",
      "--wait",
      "--operation-id",
      "op-1",
      "--format",
      "json",
    );
    expect(code).toBe(0);
    expect(h.calls.map((c) => c.path)).toEqual([
      "/v1/commands",
      "/v1/operations/op-1",
      "/v1/operations/op-1",
      "/v1/jobs/j-1",
    ]);
    expect(h.out.map((l) => JSON.parse(l))).toEqual([
      { operationId: "op-1", jobId: null },
      { id: "j-1", state: "succeeded" },
    ]);
  });
});

describe("output and credentials", () => {
  it("text prints one fact per line; json prints the envelope exactly", async () => {
    const body = { operationId: "op", status: "accepted", channelId: "ch-1", nested: { a: 1 } };
    const text = harness(() => Response.json(body));
    await text.hive("channel", "create", "--name", "dev");
    expect(text.out).toEqual([
      "operationId: op",
      "status: accepted",
      "channelId: ch-1",
      'nested: {"a":1}',
    ]);
    const json = harness(() => Response.json(body));
    await json.hive("channel", "create", "--name", "dev", "--format", "json");
    expect(json.out).toEqual([JSON.stringify(body)]);
  });

  it("workspace create and device register persist ids and the token", async () => {
    const h = harness((call) =>
      Response.json(
        (call.body as { command: { type: string } }).command.type === "device.register"
          ? { deviceId: "d-1", deviceToken: "d-1.secret" }
          : { workspaceId: "ws-9" },
      ),
    );
    expect(
      await h.hive(
        "workspace",
        "create",
        "--id",
        "ws-9",
        "--name",
        "home",
        "--api-url",
        "http://x",
      ),
    ).toBe(0);
    expect((h.calls[0]!.body as { workspaceId: string }).workspaceId).toBe("ws-9");
    expect(
      await h.hive("device", "register", "--name", "pc1", "--os", "darwin", "--agent-version", "0"),
    ).toBe(0);
    expect(h.saved).toEqual([
      { apiUrl: "http://x", workspaceId: "ws-9" },
      { apiUrl: "https://hive.test", deviceToken: "d-1.secret" },
    ]);
    expect(h.err).toEqual(["device token saved; executor --token-file /cfg/hive/device-token"]);
  });

  it("executor run pumps the outbox before listing Jobs with the device token", async () => {
    const h = harness(
      (call) =>
        Response.json(
          call.path.startsWith("/v1/executor/jobs") ? { jobs: [] } : { processed: 0, dead: 0 },
        ),
      { creds: { deviceToken: "d-1.secret" } },
    );
    h.deps.runExecutor = async (cloud) => cloud.listQueuedJobs(10);
    expect(await h.hive("executor", "run", "--once")).toBe(0);
    expect(h.calls.map((c) => [c.method, c.path, c.headers.get("Authorization")])).toEqual([
      ["POST", "/v1/executor/pump", "Bearer d-1.secret"],
      ["GET", "/v1/executor/jobs?state=queued&limit=10", "Bearer d-1.secret"],
    ]);
  });

  it("bot create sends instructions inline or from a file, not both", async () => {
    const h = harness();
    expect(await h.hive("bot", "create", "--name", "b", "--instructions", "Be brief.")).toBe(0);
    expect(await h.hive("bot", "create", "--name", "b", "--instructions-file", "-")).toBe(0);
    expect(h.calls.map((c) => (c.body as { command: Record<string, unknown> }).command)).toEqual([
      { type: "bot.create", name: "b", instructions: "Be brief." },
      { type: "bot.create", name: "b", instructions: "" },
    ]);
    expect(
      await h.hive(
        "bot",
        "create",
        "--name",
        "b",
        "--instructions",
        "x",
        "--instructions-file",
        "-",
      ),
    ).toBe(2);
  });

  it("executor run passes --provider through and rejects unknown providers", async () => {
    const h = harness(undefined, { creds: { deviceToken: "d-1.secret" } });
    const providers: string[] = [];
    h.deps.runExecutor = async (_cloud, _once, provider) => void providers.push(provider);
    expect(await h.hive("executor", "run", "--once", "--provider", "claude")).toBe(0);
    expect(await h.hive("executor", "run", "--once")).toBe(0);
    expect(await h.hive("executor", "run", "--provider", "codex")).toBe(2);
    expect(providers).toEqual(["claude", "fake"]);
  });
});
