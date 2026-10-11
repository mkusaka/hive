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
  const environments: [string, string][] = [];
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
    openBrowser: async () => {
      throw new Error("no browser in tests");
    },
    readInput: async (path) => (path === "-" ? stdin : `{"file":"${path}"}`),
    stdout: (line) => void out.push(line),
    stderr: (line) => void err.push(line),
    runExecutor: async () => null,
    saveEnvironment: async (name, path) => {
      environments.push([name, path]);
      return `/abs/${path}`;
    },
    pollMs: 1,
  };
  return {
    deps,
    calls,
    out,
    err,
    saved,
    environments,
    hive: (...argv: string[]) => run(argv, deps),
  };
};

const apiError = (status: number, code: string) =>
  Response.json(
    { code, message: code, requestId: "r", operationId: null, retryable: false },
    { status },
  );

const accessHeaders = (calls: Call[]) =>
  calls.map((c) => [c.headers.get("Cf-Access-Jwt-Assertion"), c.headers.get("Authorization")]);

describe("argv → request", () => {
  it("message post resolves @names to Bot mention tokens with --resolve-names", async () => {
    const h = harness((call) =>
      Response.json(
        call.method === "GET"
          ? {
              bots: [
                { id: "b-1", name: "coder" },
                { id: "b-2", name: "coder-2" },
              ],
            }
          : { ok: true },
      ),
    );
    const post = (...flags: string[]) =>
      h.hive("message", "post", "--channel", "ch-1", "--text", "@coder-2 @coder hi", ...flags);
    expect(await post()).toBe(0);
    expect(await post("--resolve-names")).toBe(0);
    expect(h.calls.map((c) => [c.method, c.path])).toEqual([
      ["POST", "/v1/commands"],
      ["GET", "/v1/bots?workspaceId=ws-1"],
      ["POST", "/v1/commands"],
    ]);
    expect(
      h.calls
        .filter((c) => c.method === "POST")
        .map((c) => (c.body as { command: unknown }).command),
    ).toEqual([
      { type: "message.post", channelId: "ch-1", text: "@coder-2 @coder hi" },
      { type: "message.post", channelId: "ch-1", text: "<@bot:b-2> <@bot:b-1> hi" },
    ]);
  });

  it("dm open, message post --conversation and channel join send their commands", async () => {
    const h = harness(() => Response.json({ ok: true }));
    expect(await h.hive("dm", "open", "b-1")).toBe(0);
    expect(await h.hive("message", "post", "--conversation", "dm-1", "--text", "hi")).toBe(0);
    expect(await h.hive("channel", "join", "ch-1", "--bot", "b-1")).toBe(0);
    expect(await h.hive("message", "post", "--text", "hi")).not.toBe(0);
    expect(h.calls.map((c) => (c.body as { command: unknown }).command)).toEqual([
      { type: "dm.open", botId: "b-1" },
      { type: "message.post", conversationId: "dm-1", text: "hi" },
      { type: "channel.join", channelId: "ch-1", botId: "b-1" },
    ]);
  });

  it("message post --thread-of replies in a thread; thread list reads the user's threads", async () => {
    const h = harness(() => Response.json({ ok: true }));
    expect(
      await h.hive("message", "post", "--channel", "ch-1", "--thread-of", "m-1", "--text", "hi"),
    ).toBe(0);
    expect(await h.hive("thread", "list")).toBe(0);
    expect(h.calls[0]!.body).toMatchObject({
      command: { type: "message.post", channelId: "ch-1", threadOf: "m-1", text: "hi" },
    });
    expect(h.calls[1]!.path).toBe("/v1/threads?workspaceId=ws-1&participant=me");
  });

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

  it("subscription and integration commands", async () => {
    const spec = {
      botId: "bot-1",
      eventTypes: ["github.*"],
      destination: { conversationId: "conv-1" },
    };
    const h = harness(undefined, { stdin: JSON.stringify(spec) });
    expect(await h.hive("subscription", "create", "--file", "-")).toBe(0);
    expect(await h.hive("subscription", "list")).toBe(0);
    expect(await h.hive("subscription", "pause", "sub-1")).toBe(0);
    expect(await h.hive("subscription", "test", "sub-1", "--limit", "5")).toBe(0);
    expect(
      await h.hive("integration", "create", "--kind", "slack", "--external-account-id", "U1"),
    ).toBe(0);
    expect(
      h.calls.map((c) => [c.method, c.path, (c.body as { command?: unknown })?.command]),
    ).toEqual([
      ["POST", "/v1/commands", { ...spec, type: "subscription.create" }],
      ["GET", "/v1/subscriptions?workspaceId=ws-1", undefined],
      ["POST", "/v1/commands", { type: "subscription.pause", subscriptionId: "sub-1" }],
      ["POST", "/v1/commands", { type: "subscription.test", subscriptionId: "sub-1", limit: 5 }],
      [
        "POST",
        "/v1/commands",
        { type: "integration.create", kind: "slack", externalAccountId: "U1" },
      ],
    ]);
  });

  it("routine and job control commands", async () => {
    const h = harness((call) =>
      call.path.startsWith("/v1/channels")
        ? Response.json({ channels: [{ id: "ch-1", conversationId: "conv-1" }] })
        : Response.json({ ok: true }),
    );
    const command = (i: number) => (h.calls[i]!.body as { command: unknown }).command;
    expect(
      await h.hive(
        "routine",
        "create",
        "--bot",
        "bot-1",
        "--name",
        "standup",
        "--cron",
        "0 9 * * 1-5",
        "--tz",
        "Asia/Tokyo",
        "--input",
        "Summarize",
        "--channel",
        "ch-1",
      ),
    ).toBe(0);
    expect(command(1)).toEqual({
      type: "routine.create",
      botId: "bot-1",
      name: "standup",
      schedule: { kind: "cron", expr: "0 9 * * 1-5", timezone: "Asia/Tokyo" },
      inputText: "Summarize",
      conversationId: "conv-1",
    });
    expect(await h.hive("routine", "list")).toBe(0);
    expect(h.calls[2]!.path).toBe("/v1/routines?workspaceId=ws-1");
    expect(await h.hive("routine", "run", "r-1")).toBe(0);
    expect(await h.hive("routine", "pause", "r-1")).toBe(0);
    expect(command(3)).toEqual({ type: "routine.run", routineId: "r-1" });
    expect(command(4)).toEqual({ type: "routine.pause", routineId: "r-1" });
    expect(await h.hive("routine", "delete", "r-1")).toBe(0);
    expect(await h.hive("channel", "update", "ch-1", "--topic", "Daily ops")).toBe(0);
    expect(command(5)).toEqual({ type: "routine.delete", routineId: "r-1" });
    expect(command(6)).toEqual({ type: "channel.update", channelId: "ch-1", topic: "Daily ops" });

    expect(await h.hive("job", "cancel", "job-1")).toBe(0);
    expect(command(7)).toEqual({ type: "job.cancel", jobId: "job-1" });
    expect(await h.hive("job", "resolve", "job-1", "--mark-failed")).toBe(0);
    expect(command(8)).toEqual({ type: "job.resolve", jobId: "job-1", action: "mark_failed" });
    expect(await h.hive("job", "resolve", "job-1")).toBe(2);
    expect(await h.hive("job", "resolve", "job-1", "--retry", "--cancel")).toBe(2);
    expect(h.calls).toHaveLength(9);
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
    expect(h.calls.map((c) => [c.method, c.path, c.headers.get("X-Hive-Token")])).toEqual([
      ["POST", "/v1/executor/pump", "d-1.secret"],
      ["GET", "/v1/executor/jobs?state=queued&limit=10", "d-1.secret"],
    ]);
  });

  it("executor run adds the Access service token to every executor request", async () => {
    const h = harness(
      (call) =>
        Response.json(
          call.path.startsWith("/v1/executor/jobs") ? { jobs: [] } : { processed: 0, dead: 0 },
        ),
      {
        creds: { deviceToken: "d-1.secret", accessClientId: "cid", accessClientSecret: "csecret" },
      },
    );
    h.deps.runExecutor = async (cloud) => cloud.listQueuedJobs(10);
    expect(await h.hive("executor", "run", "--once")).toBe(0);
    expect(
      h.calls.map((c) => [
        c.path,
        c.headers.get("CF-Access-Client-Id"),
        c.headers.get("CF-Access-Client-Secret"),
        c.headers.get("X-Hive-Token"),
        c.headers.get("Authorization"),
      ]),
    ).toEqual([
      ["/v1/executor/pump", "cid", "csecret", "d-1.secret", null],
      ["/v1/executor/jobs?state=queued&limit=10", "cid", "csecret", "d-1.secret", null],
    ]);
  });

  it("device register stores the service token from a file and never prints it", async () => {
    const h = harness(() => Response.json({ deviceId: "d-1", deviceToken: null }));
    h.deps.readInput = async () => "csecret\n";
    const args = ["device", "register", "--name", "pc1", "--os", "darwin", "--agent-version", "0"];
    expect(await h.hive(...args, "--access-client-id", "cid")).toBe(2);
    expect(
      await h.hive(...args, "--access-client-id", "cid", "--access-client-secret-file", "/s"),
    ).toBe(0);
    expect(h.saved).toEqual([{ accessClientId: "cid", accessClientSecret: "csecret" }]);
    expect([...h.out, ...h.err].join("\n")).not.toContain("csecret");
  });

  it("sends the dev assertion first, else the OAuth bearer, else asks for hive login", async () => {
    const oauth = {
      authorizationServer: "https://team.cloudflareaccess.com",
      clientId: "c",
      accessToken: "oauth-token",
      refreshToken: "r",
      expiresAt: Date.now() + 600_000,
    };
    const dev = harness(undefined, { creds: { oauth } });
    expect(await dev.hive("job", "get", "j-1")).toBe(0);
    expect(accessHeaders(dev.calls)).toEqual([["jwt", null]]);

    const bearer = harness(undefined, { creds: { accessJwt: undefined, oauth } });
    expect(await bearer.hive("job", "get", "j-1")).toBe(0);
    expect(accessHeaders(bearer.calls)).toEqual([[null, "Bearer oauth-token"]]);

    const none = harness(undefined, { creds: { accessJwt: undefined } });
    expect(await none.hive("job", "get", "j-1")).toBe(3);
    expect(none.calls).toEqual([]);
    expect(none.err).toEqual(["error: LOGIN_REQUIRED: not logged in: run `hive login`"]);
  });

  it("logout drops the stored grant", async () => {
    const h = harness();
    expect(await h.hive("logout")).toBe(0);
    expect(h.saved).toEqual([{ oauth: undefined }]);
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
    expect(await h.hive("executor", "run", "--once", "--provider", "codex")).toBe(0);
    expect(await h.hive("executor", "run", "--provider", "gemini")).toBe(2);
    expect(providers).toEqual(["claude", "fake", "codex"]);
  });
});

const commandOf = (call: Call) => (call.body as { command: Record<string, unknown> }).command;

describe("tools and approvals", () => {
  it("bot create --tools / --environment and bot update at the current revision", async () => {
    const h = harness((call) =>
      call.method === "GET"
        ? Response.json({
            bots: [
              {
                id: "bot-1",
                revision: 3,
                toolPolicy: { tools: { Read: "allow" }, cwdMode: "environment" },
              },
            ],
          })
        : Response.json({ ok: true }),
    );
    expect(
      await h.hive(
        "bot",
        "create",
        "--name",
        "b",
        "--tools",
        "Read=allow,Bash=ask",
        "--cwd-mode",
        "environment",
        "--environment",
        "backend",
      ),
    ).toBe(0);
    expect(commandOf(h.calls[0]!)).toEqual({
      type: "bot.create",
      name: "b",
      placementPolicy: { environmentId: "backend" },
      toolPolicy: { tools: { Read: "allow", Bash: "ask" }, cwdMode: "environment" },
    });
    expect(await h.hive("bot", "update", "bot-1", "--tools", "Bash=ask")).toBe(0);
    expect(h.calls[1]!.path).toBe("/v1/bots?workspaceId=ws-1");
    expect(commandOf(h.calls.at(-1)!)).toEqual({
      type: "bot.update",
      botId: "bot-1",
      expectedRevision: 3,
      toolPolicy: { tools: { Bash: "ask" }, cwdMode: "environment" },
    });
    expect(await h.hive("bot", "update", "bot-1", "--instructions", "Be brief.")).toBe(0);
    expect(commandOf(h.calls.at(-1)!)).toEqual({
      type: "bot.update",
      botId: "bot-1",
      expectedRevision: 3,
      instructions: "Be brief.",
    });
    expect(await h.hive("bot", "update", "bot-1")).toBe(2);
    expect(await h.hive("bot", "create", "--name", "b", "--tools", "Bash")).toBe(2);
  });

  it("bot create / update placement flags; update merges over the Bot's current placement", async () => {
    const current = {
      mode: "preferred",
      allowedDeviceIds: ["pc1", "pc2"],
      preferredDeviceIds: ["pc1", "pc2"],
      fallbackOnUnavailable: true,
      overflowToFallback: false,
      requiredCapabilities: [],
      recovery: "manual",
    };
    const h = harness((call) =>
      call.method === "GET"
        ? Response.json({
            bots: [{ id: "bot-1", revision: 2, toolPolicy: {}, placementPolicy: current }],
          })
        : Response.json({ ok: true }),
    );
    const create = [
      "bot",
      "create",
      "--name",
      "b",
      "--mode",
      "preferred",
      "--preferred",
      "pc1,pc2",
      "--allowed",
      "pc1,pc2",
      "--overflow",
      "--no-fallback",
      "--capabilities",
      "claude,bash",
    ];
    expect(await h.hive(...create)).toBe(0);
    expect(commandOf(h.calls[0]!)).toEqual({
      type: "bot.create",
      name: "b",
      placementPolicy: {
        mode: "preferred",
        allowedDeviceIds: ["pc1", "pc2"],
        preferredDeviceIds: ["pc1", "pc2"],
        requiredCapabilities: ["claude", "bash"],
        overflowToFallback: true,
        fallbackOnUnavailable: false,
      },
    });
    expect(await h.hive("bot", "update", "bot-1", "--overflow", "--capabilities", "codex")).toBe(0);
    expect(commandOf(h.calls.at(-1)!)).toEqual({
      type: "bot.update",
      botId: "bot-1",
      expectedRevision: 2,
      placementPolicy: { ...current, overflowToFallback: true, requiredCapabilities: ["codex"] },
    });
  });

  it("executor run passes --concurrency through and rejects a bad value", async () => {
    const h = harness(undefined, { creds: { deviceToken: "d-1.secret" } });
    const seen: number[] = [];
    h.deps.runExecutor = async (_cloud, _once, _provider, concurrency) =>
      void seen.push(concurrency);
    expect(await h.hive("executor", "run", "--once")).toBe(0);
    expect(await h.hive("executor", "run", "--once", "--concurrency", "3")).toBe(0);
    expect(await h.hive("executor", "run", "--concurrency", "0")).toBe(2);
    expect(seen).toEqual([1, 3]);
  });

  it("device env add maps the path locally and registers name + repository in the cloud", async () => {
    const h = harness(undefined, { creds: { deviceToken: "dev-1.secret" } });
    expect(
      await h.hive(
        "device",
        "env",
        "add",
        "--name",
        "backend",
        "--repo",
        "git@x:y.git",
        "--path",
        "repo",
      ),
    ).toBe(0);
    expect(h.environments).toEqual([["backend", "repo"]]);
    expect(commandOf(h.calls[0]!)).toEqual({
      type: "device.environment.register",
      deviceId: "dev-1",
      name: "backend",
      repository: "git@x:y.git",
    });
    expect(h.out).toContain("localPath: /abs/repo");
    // The path never goes to the cloud.
    expect(JSON.stringify(h.calls)).not.toContain("/abs/repo");
  });

  it("approval list / resolve / watch", async () => {
    let polls = 0;
    const h = harness((call) => {
      if (call.method === "POST") return Response.json({ approvalId: "a-1", state: "approved" });
      polls += 1;
      const a1 = { id: "a-1", actionKind: "Bash", argsSummary: "ls" };
      const a2 = { id: "a-2", actionKind: "Read", argsSummary: "README.md" };
      // Newest first, like the API.
      return Response.json({ approvals: polls === 1 ? [a1] : [a2, a1] });
    });
    expect(await h.hive("approval", "list")).toBe(0);
    expect(h.calls[0]!.path).toBe("/v1/approvals?workspaceId=ws-1&state=pending");
    expect(await h.hive("approval", "resolve", "a-1", "--allow", "--reason", "ok")).toBe(0);
    expect(commandOf(h.calls[1]!)).toEqual({
      type: "approval.resolve",
      approvalId: "a-1",
      decision: "allow",
      reason: "ok",
    });
    expect(await h.hive("approval", "resolve", "a-1", "--deny")).toBe(0);
    expect(commandOf(h.calls[2]!)).toMatchObject({ decision: "deny" });
    expect(await h.hive("approval", "resolve", "a-1")).toBe(2);
    expect(await h.hive("approval", "resolve", "a-1", "--allow", "--deny")).toBe(2);

    polls = 0;
    h.out.length = 0;
    expect(await h.hive("approval", "watch", "--timeout", "0.02", "--format", "json")).toBe(0);
    expect(polls).toBeGreaterThanOrEqual(2);
    // Each pending approval is printed once, oldest first.
    expect(h.out.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(["a-1", "a-2"]);
  });
});

describe("search and memory", () => {
  it("search / memory write / list / delete", async () => {
    const h = harness(() => Response.json({ hits: [], memories: [], indexedThrough: null }), {
      stdin: "from stdin",
    });
    expect(await h.hive("search", "レビュー", "--kinds", "message,task")).toBe(0);
    expect(h.calls[0]!.path).toBe(
      `/v1/search?workspaceId=ws-1&q=${encodeURIComponent("レビュー")}&kinds=message%2Ctask`,
    );
    expect(await h.hive("memory", "write", "--scope", "bot:b-1", "--content", "x")).toBe(0);
    expect(commandOf(h.calls[1]!)).toEqual({
      type: "memory.write",
      scopeKind: "bot",
      scopeId: "b-1",
      content: "x",
    });
    expect(await h.hive("memory", "write", "--scope", "workspace", "--file", "-")).toBe(0);
    expect(commandOf(h.calls[2]!)).toMatchObject({
      scopeKind: "workspace",
      scopeId: "ws-1",
      content: "from stdin",
    });
    expect(await h.hive("memory", "list", "--scope", "channel:c-1")).toBe(0);
    expect(h.calls[3]!.path).toBe("/v1/memories?workspaceId=ws-1&scopeKind=channel&scopeId=c-1");
    expect(await h.hive("memory", "delete", "m-1")).toBe(0);
    expect(commandOf(h.calls[4]!)).toEqual({
      type: "memory.delete",
      memoryId: "m-1",
      expectedRevision: 1,
    });
    expect(await h.hive("memory", "write", "--scope", "bot", "--content", "x")).toBe(2);
    expect(await h.hive("memory", "write", "--scope", "workspace")).toBe(2);
    expect(await h.hive("search")).toBe(2);
  });
});
