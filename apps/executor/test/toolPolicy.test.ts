import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookInput, Options } from "@anthropic-ai/claude-agent-sdk";
import type { ToolPolicy } from "@hive/contracts";
import { describe, expect, it } from "vitest";
import { claudeAdapter, type QueryFn } from "../src/adapters/claude.ts";
import { saveEnvironment } from "../src/environments.ts";
import type { LaunchContext } from "../src/runner.ts";
import {
  approvalGate,
  argsHash,
  argsSummary,
  outsidePath,
  preToolUse,
  toolOptions,
} from "../src/toolPolicy.ts";
import { context, fakeRunApi } from "./helpers.ts";

const policy: ToolPolicy = {
  tools: { Read: "allow", Glob: "allow", Bash: "ask", Write: "deny" },
  cwdMode: "run_scratch",
};
const hive = new Set(["mcp__hive__hive_notify"]);
const root = "/work/repo";

const gateOptions = (signal = new AbortController().signal) => ({
  signal,
  toolUseID: "t",
  requestId: "r",
});
const launch = (overrides: Partial<LaunchContext["context"]>): LaunchContext => ({
  runId: "run-1",
  jobId: "job-1",
  executionGeneration: 1,
  inboxItemId: "inbox-1",
  context: { ...context, ...overrides },
  run: null,
  observe: async () => {},
});
const recorder = () => {
  const calls: Options[] = [];
  const queryFn: QueryFn = async function* ({ options }) {
    calls.push(options);
    yield* [];
  };
  return { calls, queryFn };
};

describe("toolOptions", () => {
  it("exposes allow + ask tools, pre-allows only allow tools and disallows the rest", () => {
    expect(toolOptions(policy, [...hive])).toEqual({
      tools: ["Read", "Glob", "Bash"],
      allowedTools: ["Read", "Glob", "mcp__hive__hive_notify"],
      disallowedTools: ["Grep", "Edit", "Write"],
      permissionMode: "default",
    });
  });
});

describe("PreToolUse hook", () => {
  const hook = preToolUse(policy, [root], hive);
  const run = (tool_name: string, tool_input: unknown) =>
    hook(
      { hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t" } as HookInput,
      "t",
      { signal: new AbortController().signal },
    );
  const decision = async (tool: string, input: unknown) =>
    ((await run(tool, input)) as { hookSpecificOutput?: { permissionDecision: string } })
      .hookSpecificOutput?.permissionDecision ?? "none";

  it("denies deny / unknown tools and forces ask tools to the prompt", async () => {
    expect(await decision("Write", { file_path: "a.txt", content: "x" })).toBe("deny");
    expect(await decision("WebFetch", { url: "https://x" })).toBe("deny");
    expect(await decision("Bash", { command: "ls" })).toBe("ask");
    expect(await decision("mcp__hive__hive_notify", { text: "x" })).toBe("none");
  });

  it("denies file paths outside the cwd, allows inside", async () => {
    expect(await decision("Read", { file_path: "src/a.ts" })).toBe("none");
    expect(await decision("Read", { file_path: `${root}/src/a.ts` })).toBe("none");
    expect(await decision("Glob", { pattern: "**/*.ts" })).toBe("none");
    expect(await decision("Read", { file_path: "../x" })).toBe("deny");
    expect(await decision("Read", { file_path: "src/../../x" })).toBe("deny");
    expect(await decision("Read", { file_path: "/etc/passwd" })).toBe("deny");
    expect(await decision("Read", { file_path: "/work/repo-other/a" })).toBe("deny");
    expect(await decision("Read", { file_path: "~/.ssh/id_ed25519" })).toBe("deny");
    expect(await decision("Glob", { pattern: "../**/*" })).toBe("deny");
    expect(await decision("Glob", { pattern: "*", path: "/tmp" })).toBe("deny");
  });

  it("accepts either root (cwd or its realpath)", () => {
    expect(
      outsidePath("Read", { file_path: "/private/tmp/x/a" }, ["/tmp/x", "/private/tmp/x"]),
    ).toBe(null);
    expect(outsidePath("Read", { file_path: "..x" }, [root])).toBe(null);
  });
});

describe("approvalGate (canUseTool)", () => {
  const input = { command: "ls -la", description: "list" };

  it("denies a deny / unknown tool without calling the cloud", async () => {
    const { api, calls } = fakeRunApi();
    const gate = approvalGate({ policy, run: api, cwdLabel: "run_scratch", hiveTools: hive });
    expect(await gate("Write", { file_path: "a" }, gateOptions())).toMatchObject({
      behavior: "deny",
    });
    expect(await gate("WebFetch", {}, gateOptions())).toMatchObject({ behavior: "deny" });
    expect(await gate("Read", { file_path: "a" }, gateOptions())).toMatchObject({
      behavior: "allow",
    });
    expect(calls).toEqual([]);
  });

  it("asks the cloud, polls and allows the approved call with its input", async () => {
    const { api, calls } = fakeRunApi(undefined, ["pending", "approved"]);
    const gate = approvalGate({
      policy,
      run: api,
      cwdLabel: "backend",
      hiveTools: hive,
      pollMs: 1,
    });
    expect(await gate("Bash", input, gateOptions())).toEqual({
      behavior: "allow",
      updatedInput: input,
    });
    expect(calls).toEqual([
      {
        type: "approval.request",
        actionKind: "Bash",
        argsHash: argsHash({ description: "list", command: "ls -la" }),
        argsSummary: "ls -la",
        cwdLabel: "backend",
      },
      { getApproval: "approval-1" },
      { getApproval: "approval-1" },
    ]);
  });

  it("denies on expired / denied, on a cloud error, without a capability and on abort", async () => {
    const gate = (states: ("expired" | "denied" | "pending")[], fail?: Error) =>
      approvalGate({
        policy,
        run: fakeRunApi(fail, states).api,
        cwdLabel: "run_scratch",
        hiveTools: hive,
        pollMs: 1,
      });
    expect(await gate(["expired"])("Bash", input, gateOptions())).toEqual({
      behavior: "deny",
      message: "a human did not approve this Bash call (expired: timeout)",
    });
    expect(await gate(["denied"])("Bash", input, gateOptions())).toMatchObject({
      behavior: "deny",
    });
    expect(await gate([], new Error("offline"))("Bash", input, gateOptions())).toMatchObject({
      behavior: "deny",
      message: "Bash approval failed: offline",
    });
    const noRun = approvalGate({ policy, run: null, cwdLabel: "x", hiveTools: hive });
    expect(await noRun("Bash", input, gateOptions())).toMatchObject({ behavior: "deny" });
    const abort = new AbortController();
    const waiting = gate([])("Bash", input, gateOptions(abort.signal));
    setTimeout(() => abort.abort(), 5);
    expect(await waiting).toMatchObject({ behavior: "deny" });
  });

  it("keeps local paths out of the summary", () => {
    expect(
      argsSummary("Bash", { command: "ls /private/tmp/x/src && cat /tmp/x/a" }, [
        "/tmp/x",
        "/private/tmp/x",
      ]),
    ).toBe("ls <cwd>/src && cat <cwd>/a");
    expect(argsSummary("Read", { file_path: "/w/r/README.md" }, ["/w/r"])).toBe("<cwd>/README.md");
  });

  it("binds the hash to the canonical input", () => {
    expect(argsHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(
      argsHash({ b: [1, { d: 3, c: 2 }], a: 1 }),
    );
    expect(argsHash({ command: "ls" })).not.toBe(argsHash({ command: "ls -a" }));
  });
});

describe("claudeAdapter with a tool policy", () => {
  it("runs in the environment's checkout root with the hook and the approval gate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hive-policy-"));
    const checkout = join(dir, "checkout");
    await mkdir(checkout);
    await writeFile(join(checkout, "README.md"), "hi");
    await saveEnvironment(dir, "backend", checkout);
    const { calls, queryFn } = recorder();
    const agent = await claudeAdapter({ stateDir: dir, queryFn }).start(
      launch({
        bot: { ...context.bot, toolPolicy: { ...policy, cwdMode: "environment" } },
        environment: "backend",
      }),
    );
    await agent.waitForExit();
    const [options] = calls as [Options];
    expect(options).toMatchObject({
      cwd: checkout,
      tools: ["Read", "Glob", "Bash"],
      allowedTools: ["Read", "Glob"],
      disallowedTools: ["Grep", "Edit", "Write"],
      permissionMode: "default",
    });
    expect(typeof options.canUseTool).toBe("function");
    const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
    const real = await realpath(checkout);
    const out = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: `${real}/../secret` },
      } as HookInput,
      "t",
      { signal: new AbortController().signal },
    );
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("fails with environment_missing, without calling the SDK, when the checkout is not on this device", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hive-policy-"));
    const { calls, queryFn } = recorder();
    const agent = await claudeAdapter({ stateDir: dir, queryFn }).start(
      launch({
        bot: { ...context.bot, toolPolicy: { tools: {}, cwdMode: "environment" } },
        environment: "backend",
      }),
    );
    expect(await agent.waitForExit()).toMatchObject({ code: 1, reason: "environment_missing" });
    expect(calls).toEqual([]);
  });
});
