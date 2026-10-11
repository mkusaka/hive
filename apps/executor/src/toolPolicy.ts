// Bot tool policy enforcement for the Claude adapter (docs/architecture.md §18.3, §19, §20.3). Two layers, both
// fail-closed:
// - a PreToolUse hook (mandatory, runs before any permission rule): denies `deny` tools and file-tool paths outside
//   the working directory, and forces `ask` tools to the permission prompt even where Claude Code would auto-allow;
// - `canUseTool` (the prompt): re-checks the policy, then asks a human through the cloud (`approval.request`) and polls
//   until approved / denied / expired. Any error or abort is a deny.
// The cwd check is not a sandbox: Bash is not path-restricted, so a Bot with Bash runs with `unsafe_host_access`.
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { CanUseTool, HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { type ToolName, type ToolPolicy, toolNames } from "@hive/contracts";
import type { RunApi } from "./cloudClient.ts";

/** UTF-8 prefix of at most `max` bytes, cut on a code point boundary. */
export const truncate = (text: string, max: number) => {
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    bytes += Buffer.byteLength(ch);
    if (bytes > max) break;
    out += ch;
  }
  return out;
};

const modeOf = (policy: ToolPolicy, tool: string) =>
  (toolNames as readonly string[]).includes(tool)
    ? (policy.tools[tool as ToolName] ?? "deny")
    : "deny";

/** SDK options for the policy: only allow + ask tools exist; only allow tools (and hive tools) skip the prompt. */
export const toolOptions = (
  policy: ToolPolicy,
  hiveTools: string[],
): Pick<Options, "tools" | "allowedTools" | "disallowedTools" | "permissionMode"> => {
  const named = (mode: string) => toolNames.filter((t) => modeOf(policy, t) === mode);
  return {
    tools: [...named("allow"), ...named("ask")],
    allowedTools: [...named("allow"), ...hiveTools],
    disallowedTools: named("deny"),
    // `default` routes prompts to `canUseTool`; `dontAsk` would deny `ask` tools without calling it.
    permissionMode: "default",
  };
};

// Path-bearing inputs of the file tools; `pattern` / `glob` are glob patterns.
const pathKeys: Record<string, string[]> = {
  Read: ["file_path"],
  Edit: ["file_path"],
  Write: ["file_path"],
  Glob: ["path", "pattern"],
  Grep: ["path", "glob"],
};
const globKeys = new Set(["pattern", "glob"]);

const inside = (root: string, path: string) => {
  const rel = relative(root, resolve(root, path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * The first file-tool input that leaves the working directory (`roots`: the cwd and its realpath), else null. `~`,
 * `..` in a glob, and absolute or relative paths resolving outside are refused. Symlinks inside the cwd are not
 * resolved (§18.3: a path allowlist is not a sandbox).
 */
export const outsidePath = (tool: string, input: unknown, roots: string[]) => {
  for (const key of pathKeys[tool] ?? []) {
    const value = (input as Record<string, unknown> | null)?.[key];
    if (typeof value !== "string" || value === "") continue;
    if (value.startsWith("~")) return value;
    if (globKeys.has(key) && value.split(/[/\\]/).includes("..")) return value;
    if (!roots.some((root) => inside(root, value))) return value;
  }
  return null;
};

const decide = (permissionDecision: "allow" | "deny" | "ask", reason: string) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse" as const,
    permissionDecision,
    permissionDecisionReason: reason,
  },
});

/** The mandatory before_tool hook (§20.3). */
export const preToolUse =
  (policy: ToolPolicy, roots: string[], hiveTools: Set<string>): HookCallback =>
  async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const tool = input.tool_name;
    if (hiveTools.has(tool)) return {};
    const mode = modeOf(policy, tool);
    if (mode === "deny") return decide("deny", `${tool} is not allowed for this bot`);
    const outside = outsidePath(tool, input.tool_input, roots);
    if (outside) return decide("deny", `${outside} is outside the working directory`);
    return mode === "ask" ? decide("ask", `${tool} needs a human approval`) : {};
  };

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

/** SHA-256 (hex) of the canonical JSON (sorted keys) of a tool input: what an approval is bound to. */
export const argsHash = (input: unknown) =>
  createHash("sha256").update(canonical(input)).digest("hex");

/**
 * What a human sees: the Bash command or the file path / pattern, at most 2 KiB, with the cwd `roots` replaced by
 * `<cwd>` (local paths never leave the device, §10.1). The full input stays here.
 */
export const argsSummary = (tool: string, input: Record<string, unknown>, roots: string[] = []) => {
  const value =
    tool === "Bash" ? input.command : (input.file_path ?? input.path ?? input.pattern ?? "");
  let text = typeof value === "string" ? value : JSON.stringify(value);
  for (const root of roots.toSorted((a, b) => b.length - a.length)) {
    text = text.replaceAll(root, "<cwd>");
  }
  return truncate(text, 2 * 1024);
};

const deny = (message: string) => ({ behavior: "deny" as const, message });

/**
 * `canUseTool`: the policy first (a `deny` tool is denied even if the SDK asks), then for `ask` a cloud approval bound
 * to this Run's generation and the input hash, polled every `pollMs`. Never resolves to null; never fail-open.
 */
export const approvalGate =
  (opts: {
    policy: ToolPolicy;
    run: RunApi | null;
    cwdLabel: string;
    /** The cwd and its realpath, redacted from the summary. */
    roots?: string[];
    hiveTools: Set<string>;
    pollMs?: number;
  }): CanUseTool =>
  async (toolName, input, { signal, mcpServer }) => {
    if (opts.hiveTools.has(toolName)) {
      return mcpServer?.source === "sdk"
        ? { behavior: "allow", updatedInput: input }
        : deny("unknown MCP server");
    }
    const mode = modeOf(opts.policy, toolName);
    if (mode === "allow") return { behavior: "allow", updatedInput: input };
    if (mode !== "ask") return deny(`${toolName} is not allowed for this bot`);
    if (!opts.run) return deny(`${toolName} needs an approval, which this run cannot request`);
    try {
      const hash = argsHash(input);
      const { approvalId } = (await opts.run.command({
        type: "approval.request",
        actionKind: toolName as ToolName,
        argsHash: hash,
        argsSummary: argsSummary(toolName, input, opts.roots),
        cwdLabel: opts.cwdLabel,
      })) as { approvalId: string };
      for (;;) {
        signal.throwIfAborted();
        // oxlint-disable-next-line no-await-in-loop -- one poll at a time
        const status = await opts.run.getApproval(approvalId);
        if (status.state === "approved") {
          return status.argsHash === hash
            ? { behavior: "allow", updatedInput: input }
            : deny("the approval does not match this call");
        }
        if (status.state !== "pending") {
          const why = status.decisionReason ? `: ${status.decisionReason}` : "";
          return deny(`a human did not approve this ${toolName} call (${status.state}${why})`);
        }
        // oxlint-disable-next-line no-await-in-loop -- one poll at a time
        await sleep(opts.pollMs ?? 2000, undefined, { signal });
      }
    } catch (error) {
      return deny(`${toolName} approval failed: ${error instanceof Error ? error.message : error}`);
    }
  };
