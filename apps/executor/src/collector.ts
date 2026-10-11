// Read-only collector for sessions started outside hive. It persists only offsets and immutable upload part
// sequence numbers; source files are never modified.
/* oxlint-disable no-await-in-loop */
import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ExternalRunInput } from "@hive/contracts";
import type { CloudClient } from "./cloudClient.ts";
import { exec, normalizeRemote } from "./gitCollector.ts";
import { partBytes, splitParts } from "./uploader.ts";

type Provider = "claude" | "codex";
type Normalized = { kind: string; text: string; toolName?: string };
type Source = ExternalRunInput & { path: string; provider: Provider; hasResponseItems: boolean };
type Tracked = {
  offset: number;
  runId: string;
  nextPartSeq: number;
  /** The complete source-byte range being retried; cleared only after `complete` ACKs. */
  pendingEnd?: number;
  source: Omit<Source, "path">;
};
type State = { files: Record<string, Tracked> };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const redactions = [
  /-----BEGIN[\s\S]*?(?:-----END[^\n]*|$)/g,
  /\b[A-Za-z_][A-Za-z0-9_]*(?:_TOKEN|_SECRET|_KEY)\s*["']?\s*(?:=|:)\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
  /\b(?:token|secret|key)\s*["']?\s*(?:=|:)\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
  /(?:sk-|ghp_|xox[a-z]-|AKIA)[^\s"']*/g,
];

/** Redacts credential-shaped values before a normalized line leaves this device. */
export const redact = (text: string) =>
  redactions.reduce((value, pattern) => value.replaceAll(pattern, "[redacted]"), text);

const text = (value: unknown) => (typeof value === "string" ? value : "");
const shortType = (value: unknown) =>
  typeof value === "string"
    ? value.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40) || "unknown"
    : "unknown";
const containsPrivateData = (value: unknown): boolean => {
  if (typeof value === "string") {
    const assignments =
      value.match(/(?:^|\n)(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*(?:=|:)/gm)?.length ?? 0;
    return (
      assignments > 1 || /["']?(?:environment|config|reasoning|thinking)["']?\s*:/i.test(value)
    );
  }
  if (Array.isArray(value)) return value.some(containsPrivateData);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      /(?:env(?:ironment)?|config|reasoning|thinking)/i.test(key) || containsPrivateData(nested),
  );
};
const entry = (kind: string, value: string, toolName?: string): Normalized => ({
  kind,
  text: redact(value),
  ...(toolName ? { toolName: shortType(toolName) } : {}),
});
const toolUse = (input: unknown, name: unknown) =>
  containsPrivateData(input)
    ? []
    : [
        entry(
          "tool_use",
          typeof input === "string" ? input : JSON.stringify(input ?? {}),
          text(name),
        ),
      ];
const toolResult = (value: string) =>
  containsPrivateData(value) ? [] : [entry("tool_result", value)];
const blockText = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((block) => {
            if (typeof block !== "object" || block === null) return [];
            const b = block as { type?: unknown; text?: unknown };
            return b.type === "text" && typeof b.text === "string" ? [b.text] : [];
          })
          .join("\n")
      : "";

const claudeEntries = (value: Record<string, unknown>): Normalized[] => {
  const type = value.type;
  const message = value.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (type === "user") {
    if (typeof content === "string") return [entry("user", content)];
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) => {
      if (typeof block !== "object" || block === null) return [];
      const b = block as { type?: unknown; text?: unknown; content?: unknown };
      return b.type === "text" && typeof b.text === "string"
        ? [entry("user", b.text)]
        : b.type === "tool_result"
          ? toolResult(blockText(b.content))
          : [];
    });
  }
  if (type === "assistant" && Array.isArray(content)) {
    return content.flatMap((block) => {
      if (typeof block !== "object" || block === null) return [];
      const b = block as { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
      return b.type === "text" && typeof b.text === "string"
        ? [entry("assistant", b.text)]
        : b.type === "tool_use"
          ? toolUse(b.input, b.name)
          : [];
    });
  }
  return [entry("other", `claude:${shortType(type)}`)];
};

const codexEntries = (value: Record<string, unknown>, hasResponseItems: boolean): Normalized[] => {
  const topRole = value.role;
  if (value.type === "message" && (topRole === "user" || topRole === "assistant")) {
    const body = blockText(value.content);
    return body ? [entry(topRole === "user" ? "user" : "assistant", body)] : [];
  }
  const payload = value.payload;
  if (typeof payload !== "object" || payload === null)
    return [entry("other", `codex:${shortType(value.type)}`)];
  const p = payload as {
    type?: unknown;
    role?: unknown;
    content?: unknown;
    name?: unknown;
    arguments?: unknown;
    output?: unknown;
    text?: unknown;
    message?: unknown;
  };
  if (value.type === "response_item") {
    if (
      p.type === "message" &&
      (p.role === "user" || p.role === "assistant") &&
      Array.isArray(p.content)
    ) {
      const kind = p.role === "user" ? "user" : "assistant";
      return p.content.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const i = item as { type?: unknown; text?: unknown };
        return (i.type === "input_text" || i.type === "output_text") && typeof i.text === "string"
          ? [entry(kind, i.text)]
          : [];
      });
    }
    if (p.type === "function_call") return toolUse(p.arguments, p.name);
    if (p.type === "function_call_output") return toolResult(text(p.output));
  }
  if (value.type === "event_msg" && !hasResponseItems) {
    if (p.type === "user_message" && typeof p.message === "string")
      return [entry("user", p.message)];
    if (p.type === "agent_message" && typeof p.message === "string")
      return [entry("assistant", p.message)];
  }
  // Older Codex files had the message at top-level rather than response_item.
  if (value.type === "message" && (p.role === "user" || p.role === "assistant")) {
    const body = blockText(p.content);
    return body ? [entry(p.role === "user" ? "user" : "assistant", body)] : [];
  }
  return [
    entry(
      "other",
      `codex:${shortType(value.type)}${typeof p.type === "string" ? `:${shortType(p.type)}` : ""}`,
    ),
  ];
};

const parseLines = (bytes: Uint8Array) =>
  decoder
    .decode(bytes)
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });

const timestampOf = (value: Record<string, unknown>) => {
  const payload = value.payload as { timestamp?: unknown } | undefined;
  const candidate = text(value.timestamp) || text(payload?.timestamp);
  return Number.isFinite(Date.parse(candidate)) ? candidate : undefined;
};

const metadata = (
  provider: Provider,
  path: string,
  values: Record<string, unknown>[],
  fallback: string,
): Source | null => {
  let cwd = "";
  let externalSessionId = provider === "claude" ? basename(path, ".jsonl") : "";
  let startedAt: string | undefined;
  let lastActivityAt: string | undefined;
  let hasResponseItems = false;
  for (const value of values) {
    const payload = value.payload as
      | { id?: unknown; session_id?: unknown; cwd?: unknown }
      | undefined;
    cwd ||= text(value.cwd) || text(payload?.cwd);
    if (provider === "claude") externalSessionId = text(value.sessionId) || externalSessionId;
    else externalSessionId ||= text(payload?.session_id) || text(payload?.id);
    const timestamp = timestampOf(value);
    if (timestamp) {
      startedAt ??= timestamp;
      lastActivityAt = timestamp;
    }
    hasResponseItems ||= value.type === "response_item";
  }
  externalSessionId ||= basename(path, ".jsonl");
  if (!cwd || !externalSessionId) return null;
  return {
    provider,
    externalSessionId,
    cwd,
    startedAt: startedAt ?? fallback,
    lastActivityAt: lastActivityAt ?? fallback,
    repository: "",
    title: "",
    path,
    hasResponseItems,
  };
};

const firstUserMessage = (
  provider: Provider,
  values: Record<string, unknown>[],
  hasResponseItems: boolean,
) =>
  values
    .flatMap((value) =>
      provider === "claude" ? claudeEntries(value) : codexEntries(value, hasResponseItems),
    )
    .find((value) => value.kind === "user" && value.text.trim())
    ?.text.replace(/\s+/g, " ")
    .trim();

const completeBytes = (bytes: Uint8Array) => {
  const at = bytes.lastIndexOf(10);
  return at < 0 ? new Uint8Array() : bytes.subarray(0, at + 1);
};

const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const readFrom = async (path: string, offset = 0, length?: number) => {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    if (size <= offset) return new Uint8Array();
    const bytes = new Uint8Array(Math.min(size - offset, length ?? Number.MAX_SAFE_INTEGER));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

const discover = async (root: string, depth = Infinity): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const files: string[] = [];
  for (const item of entries) {
    const path = join(root, item.name);
    if (item.isDirectory() && depth > 0) files.push(...(await discover(path, depth - 1)));
    else if (item.name.endsWith(".jsonl") && (await stat(path)).isFile()) files.push(path);
  }
  return files;
};

const collectorPath = (stateDir: string) => join(stateDir, "collector.json");
const loadState = async (stateDir: string): Promise<State> =>
  readFile(collectorPath(stateDir), "utf8").then(
    (data) => {
      const parsed = JSON.parse(data) as Partial<State>;
      return parsed.files && typeof parsed.files === "object"
        ? { files: parsed.files }
        : { files: {} };
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return { files: {} };
      throw error;
    },
  );

const saveState = async (stateDir: string, state: State) => {
  await mkdir(stateDir, { recursive: true });
  const path = collectorPath(stateDir);
  const pending = `${path}.pending`;
  const file = await open(pending, "w", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(state)}\n`);
    await file.datasync();
  } finally {
    await file.close();
  }
  await rename(pending, path);
};

/** Acquires the state-dir lock, recovering only a lock whose recorded owner PID no longer exists. */
const acquireCollectorLock = async (stateDir: string) => {
  const path = join(stateDir, "collector.lock");
  for (;;) {
    try {
      const lock = await open(path, "wx", 0o600);
      await lock.writeFile(`${process.pid}\n`);
      await lock.datasync();
      return { lock, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const owner = await readFile(path, "utf8").catch(() => null);
    if (!owner?.match(/^[1-9]\d*\n?$/)) return null;
    try {
      process.kill(Number(owner), 0);
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return null;
    }
    await unlink(path).catch(() => undefined);
  }
};

const managedSessionIds = async (stateDir: string) =>
  new Set(
    (await readdir(join(stateDir, "sessions")).catch(() => []))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.slice(0, name.indexOf("."))),
  );

const isManaged = (source: Source, stateDir: string, sessionIds: Set<string>) => {
  const path = relative(resolve(stateDir), resolve(source.cwd));
  return sessionIds.has(source.externalSessionId) || (!path.startsWith("..") && !isAbsolute(path));
};

const repository = async (cwd: string) =>
  normalizeRemote(await exec("git", ["remote", "get-url", "origin"], cwd).catch(() => ""));

export type CollectOptions = { sinceMs?: number; dryRun?: boolean; now?: () => Date };
export type CollectResult = { files: number; uploaded: number; dryRun: boolean; busy?: boolean };

/** Collects source-file deltas. A failed ACK leaves its offset and part sequence unchanged for an identical retry. */
export const collectExternalRuns = async (
  cloud: CloudClient,
  {
    stateDir,
    claudeRoot = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"),
    codexRoot = join(homedir(), ".codex", "sessions"),
    ...options
  }: CollectOptions & { stateDir: string; claudeRoot?: string; codexRoot?: string },
): Promise<CollectResult> => {
  if (options.dryRun)
    return collectExternalRunsUnlocked(cloud, { stateDir, claudeRoot, codexRoot, ...options });
  await mkdir(stateDir, { recursive: true });
  const held = await acquireCollectorLock(stateDir);
  if (!held) return { files: 0, uploaded: 0, dryRun: false, busy: true };
  try {
    return await collectExternalRunsUnlocked(cloud, {
      stateDir,
      claudeRoot,
      codexRoot,
      ...options,
    });
  } finally {
    await held.lock.close();
    await unlink(held.path).catch(() => undefined);
  }
};

const collectExternalRunsUnlocked = async (
  cloud: CloudClient,
  {
    stateDir,
    claudeRoot = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"),
    codexRoot = join(homedir(), ".codex", "sessions"),
    ...options
  }: CollectOptions & { stateDir: string; claudeRoot?: string; codexRoot?: string },
): Promise<CollectResult> => {
  const state = await loadState(stateDir);
  const now = options.now?.() ?? new Date();
  const after = options.sinceMs === undefined ? undefined : now.getTime() - options.sinceMs;
  const sessions = await managedSessionIds(stateDir);
  const files = [
    ...(await discover(claudeRoot, 1)).map((path) => ({ provider: "claude" as const, path })),
    ...(await discover(codexRoot)).map((path) => ({ provider: "codex" as const, path })),
  ];
  let uploaded = 0;
  for (const file of files) {
    const tracked = state.files[file.path];
    const fileStat = await stat(file.path);
    if (!tracked && after !== undefined && fileStat.mtimeMs < after) continue;
    const all = tracked ? undefined : completeBytes(await readFrom(file.path));
    const initialValues = all ? parseLines(all) : undefined;
    const source = tracked
      ? { ...tracked.source, path: file.path }
      : metadata(file.provider, file.path, initialValues!, fileStat.mtime.toISOString());
    if (!source || isManaged(source, stateDir, sessions)) continue;
    const offset = tracked?.offset ?? 0;
    const pendingLength =
      tracked?.pendingEnd === undefined ? undefined : tracked.pendingEnd - offset;
    const tail = completeBytes(all ?? (await readFrom(file.path, offset, pendingLength)));
    if (pendingLength !== undefined && tail.length !== pendingLength)
      throw new Error(`external session changed while retrying: ${file.path}`);
    const values = initialValues ?? parseLines(tail);
    source.hasResponseItems ||= values.some((value) => value.type === "response_item");
    if (!source.firstUserMessage) {
      const firstUser = firstUserMessage(file.provider, values, source.hasResponseItems);
      source.title = firstUser?.slice(0, 120) ?? (source.title || "External session");
      if (firstUser) source.firstUserMessage = firstUser.slice(0, 4096);
    }
    if (values.length > 0) {
      const times = values.map(timestampOf).filter((value): value is string => value !== undefined);
      if (times.length > 0) source.lastActivityAt = times.at(-1)!;
    }
    if (options.dryRun) {
      uploaded += tail.length > 0 ? 1 : 0;
      continue;
    }
    source.repository = await repository(source.cwd);
    const { path: ignoredPath, hasResponseItems, ...input } = source;
    void ignoredPath;
    void hasResponseItems;
    const created = await cloud.externalRun(input);
    const normalized = values.flatMap((value) =>
      file.provider === "claude"
        ? claudeEntries(value)
        : codexEntries(value, source.hasResponseItems),
    );
    const bytes = encoder.encode(
      normalized.map((value) => JSON.stringify(value)).join("\n") + (normalized.length ? "\n" : ""),
    );
    let nextPartSeq = tracked?.nextPartSeq ?? 0;
    if (tail.length > 0 && tracked?.pendingEnd === undefined) {
      const { path: pendingPath, ...persisted } = source;
      void pendingPath;
      state.files[file.path] = {
        offset,
        runId: created.runId,
        nextPartSeq,
        pendingEnd: offset + tail.length,
        source: persisted,
      };
      await saveState(stateDir, state);
    }
    for (const part of splitParts(bytes, partBytes)) {
      const init = await cloud.uploadInit({
        runId: created.runId,
        partSeq: nextPartSeq,
        byteSize: part.length,
        sha256: await sha256(part),
        provider: file.provider,
      });
      if (!init.committed) await cloud.uploadPart(init.uploadId, part);
      nextPartSeq += 1;
    }
    if (tail.length > 0) {
      await cloud.uploadComplete({ runId: created.runId, lastPartSeq: nextPartSeq - 1 });
      const { path: confirmedPath, ...persisted } = source;
      void confirmedPath;
      state.files[file.path] = {
        offset: offset + tail.length,
        runId: created.runId,
        nextPartSeq,
        source: persisted,
      };
      await saveState(stateDir, state);
      uploaded += 1;
    }
  }
  return { files: files.length, uploaded, dryRun: options.dryRun === true };
};
