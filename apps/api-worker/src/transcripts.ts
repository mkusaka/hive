// Transcript persistence (docs/architecture.md §3.3, §9.1, §13.2). The executor uploads a Run's raw provider
// transcript as immutable R2 parts: init (authorize, no state) → PUT (verify size and SHA-256, store the object,
// then commit the manifest row and the contiguous watermark in one batch) → complete (`persistence = complete`
// when every part up to the last is confirmed). Users read a normalized, redacted view derived at read time; the
// raw JSONL is owner-only and never indexed. Unreferenced objects from a failed commit are not collected yet.
// The same parts model carries native provider session snapshots (§13.3, `kind = 'session'`): one per uploading Run,
// read back only by an executor (`sessionSnapshot`) to resume the session on another device.
import {
  type SessionStreamKey,
  type TranscriptEntry,
  type UploadComplete,
  type UploadInit,
  type UploadInitialized,
} from "@hive/contracts";
import { appendChange } from "@hive/db";
import type { Principal } from "./auth/principal.ts";
import { HttpError } from "./errors.ts";

type Uploader = Extract<Principal, { kind: "device" | "run" }>;
type User = Extract<Principal, { kind: "user" }>;
type Device = Extract<Principal, { kind: "device" }>;

const notFound = () => new HttpError("NOT_FOUND", "run not found");
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const placeholders = (ids: string[]) => ids.map(() => "?").join(", ");

/**
 * The Workspace of a Run the principal may upload for: the capability's own Run, or a device's own Run in any state.
 * Fencing is run_id + device_id only: parts of a terminal or stale attempt are accepted as its history (§10.3); they
 * never change Job or Task state.
 */
const uploadableRun = async (db: D1Database, principal: Uploader, runId: string) => {
  if (principal.kind === "run") {
    if (principal.runId !== runId) throw notFound();
    return principal.workspaceId;
  }
  const row = await db
    .prepare("SELECT workspace_id FROM runs WHERE id = ? AND workspace_id = ? AND device_id = ?")
    .bind(runId, principal.workspaceIds[0], principal.deviceId)
    .first<{ workspace_id: string }>();
  if (!row) throw notFound();
  return row.workspace_id;
};

type Stream = { id: string; confirmed_through_seq: number | null };

/** The Run's transcript stream, or with `session` its snapshot of that native session stream. */
const streamOf = (db: D1Database, runId: string, session?: SessionStreamKey) =>
  (session
    ? db
        .prepare(
          `SELECT id, confirmed_through_seq FROM transcript_streams
            WHERE run_id = ? AND kind = 'session' AND session_id = ? AND subpath = ?`,
        )
        .bind(runId, session.sessionId, session.subpath ?? "")
    : db
        .prepare(
          "SELECT id, confirmed_through_seq FROM transcript_streams WHERE run_id = ? AND kind = 'run'",
        )
        .bind(runId)
  ).first<Stream>();

const partOf = (db: D1Database, streamId: string, partSeq: number) =>
  db
    .prepare("SELECT sha256 FROM transcript_parts WHERE stream_id = ? AND part_seq = ?")
    .bind(streamId, partSeq)
    .first<{ sha256: string }>();

/** Never a user-supplied path (§3.3). */
const objectKey = (workspaceId: string, streamId: string, partSeq: number) =>
  `workspace/${workspaceId}/transcript/${streamId}/${partSeq}`;

type UploadToken = {
  runId: string;
  partSeq: number;
  byteSize: number;
  sha256: string;
  streamId: string;
};

/**
 * The upload id is the init request itself, encoded: there is no pending-upload state. PUT re-authorizes the
 * principal against its Run and verifies the body against it, so a forged id gains nothing.
 */
const encodeUpload = (t: UploadToken) =>
  btoa(JSON.stringify([t.runId, t.partSeq, t.byteSize, t.sha256, t.streamId]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const decodeUpload = (id: string): UploadToken => {
  try {
    const [runId, partSeq, byteSize, sha256, streamId] = JSON.parse(
      atob(id.replaceAll("-", "+").replaceAll("_", "/")),
    ) as unknown[];
    if (
      typeof runId === "string" &&
      Number.isInteger(partSeq) &&
      (partSeq as number) >= 0 &&
      Number.isInteger(byteSize) &&
      typeof sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(sha256) &&
      typeof streamId === "string"
    ) {
      return { runId, partSeq: partSeq as number, byteSize: byteSize as number, sha256, streamId };
    }
  } catch {
    // fall through
  }
  throw new HttpError("INVALID_INPUT", "invalid upload id");
};

const shaConflict = () =>
  new HttpError(
    "IDEMPOTENCY_CONFLICT",
    "this part is already stored with a different sha256",
    false,
    "part_conflict",
  );

/** Idempotent on (run, partSeq, sha256); a different hash for a committed part is a 409. */
export const initUpload = async (
  db: D1Database,
  principal: Uploader,
  input: UploadInit,
): Promise<UploadInitialized> => {
  const { session } = input;
  if (session && !input.provider) {
    throw new HttpError("INVALID_INPUT", "a session stream needs its provider");
  }
  const workspaceId = await uploadableRun(db, principal, input.runId);
  await (
    session
      ? db
          .prepare(
            `INSERT INTO transcript_streams (id, workspace_id, run_id, provider, kind, session_id, subpath)
             VALUES (?, ?, ?, ?, 'session', ?, ?)
             ON CONFLICT (run_id, session_id, subpath) WHERE kind = 'session' DO NOTHING`,
          )
          .bind(
            crypto.randomUUID(),
            workspaceId,
            input.runId,
            input.provider,
            session.sessionId,
            session.subpath ?? "",
          )
      : db
          .prepare(
            `INSERT INTO transcript_streams (id, workspace_id, run_id, provider) VALUES (?, ?, ?, ?)
             ON CONFLICT (run_id) WHERE kind = 'run' DO NOTHING`,
          )
          .bind(crypto.randomUUID(), workspaceId, input.runId, input.provider ?? "unknown")
  ).run();
  const stream = (await streamOf(db, input.runId, session))!;
  const part = await partOf(db, stream.id, input.partSeq);
  if (part && part.sha256 !== input.sha256) throw shaConflict();
  return {
    uploadId: encodeUpload({ ...input, streamId: stream.id }),
    partId: `${stream.id}:${input.partSeq}`,
    committed: part !== null,
  };
};

const countLines = (bytes: Uint8Array) => {
  let n = 0;
  for (const b of bytes) if (b === 10) n++;
  return bytes.length > 0 && bytes.at(-1) !== 10 ? n + 1 : n;
};

/**
 * Stores and verifies the object first, then commits the manifest row and advances the watermark in one batch.
 * A replay of a committed part is a no-op.
 */
export const putPart = async (
  db: D1Database,
  r2: R2Bucket,
  principal: Uploader,
  uploadId: string,
  body: ArrayBuffer,
) => {
  const t = decodeUpload(uploadId);
  const workspaceId = await uploadableRun(db, principal, t.runId);
  const streamById = () =>
    db
      .prepare(
        "SELECT id, confirmed_through_seq FROM transcript_streams WHERE id = ? AND run_id = ?",
      )
      .bind(t.streamId, t.runId)
      .first<Stream>();
  const stream = await streamById();
  if (!stream) throw new HttpError("NOT_FOUND", "upload not initialized");
  if (body.byteLength !== t.byteSize) {
    throw new HttpError(
      "INVALID_INPUT",
      "body size does not match byteSize",
      false,
      "size_mismatch",
    );
  }
  if (hex(await crypto.subtle.digest("SHA-256", body)) !== t.sha256) {
    throw new HttpError("INVALID_INPUT", "body does not match sha256", false, "sha256_mismatch");
  }
  const existing = await partOf(db, stream.id, t.partSeq);
  if (existing && existing.sha256 !== t.sha256) throw shaConflict();
  if (!existing) {
    const key = objectKey(workspaceId, stream.id, t.partSeq);
    // ponytail: two concurrent PUTs of different content for one uncommitted seq can overwrite each other's object;
    // only a misbehaving client does that (the executor's split is deterministic). Add `onlyIf` when that matters.
    await r2.put(key, body, { sha256: t.sha256 });
    await db.batch([
      db
        .prepare(
          `INSERT INTO transcript_parts (id, workspace_id, stream_id, part_seq, byte_size, sha256, entry_count, r2_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (stream_id, part_seq) DO NOTHING`,
        )
        .bind(
          `${stream.id}:${t.partSeq}`,
          workspaceId,
          stream.id,
          t.partSeq,
          t.byteSize,
          t.sha256,
          countLines(new Uint8Array(body)),
          key,
        ),
      // The highest seq s such that every part 0..s is committed (part_seq is unique and ≥ 0).
      // ponytail: O(parts²) per commit; keep a running watermark if streams get thousands of parts.
      db
        .prepare(
          `UPDATE transcript_streams SET updated_at = ?2, confirmed_through_seq = (
             SELECT MAX(a.part_seq) FROM transcript_parts a
              WHERE a.stream_id = ?1 AND a.part_seq + 1 =
                    (SELECT COUNT(*) FROM transcript_parts b WHERE b.stream_id = ?1 AND b.part_seq <= a.part_seq))
            WHERE id = ?1`,
        )
        .bind(stream.id, new Date().toISOString()),
    ]);
    // Lost a race to an identical or a different body.
    if ((await partOf(db, stream.id, t.partSeq))!.sha256 !== t.sha256) throw shaConflict();
  }
  const after = (await streamById())!;
  return {
    partId: `${stream.id}:${t.partSeq}`,
    committed: true,
    confirmedThroughSeq: after.confirmed_through_seq,
  };
};

/**
 * The executor's final marker: `persistence = complete` only when the watermark reached `lastPartSeq`; otherwise a
 * 409 `gap` naming the missing parts, and the Run stays `pending`.
 */
export const completeUpload = async (
  db: D1Database,
  principal: Uploader,
  input: UploadComplete,
) => {
  const workspaceId = await uploadableRun(db, principal, input.runId);
  const stream = await streamOf(db, input.runId, input.session);
  if (input.session && !stream) throw new HttpError("NOT_FOUND", "upload not initialized");
  const confirmed = stream?.confirmed_through_seq ?? -1;
  if (confirmed < input.lastPartSeq) {
    const { results } = stream
      ? await db
          .prepare("SELECT part_seq FROM transcript_parts WHERE stream_id = ? AND part_seq <= ?")
          .bind(stream.id, input.lastPartSeq)
          .all<{ part_seq: number }>()
      : { results: [] };
    const have = new Set(results.map((r) => r.part_seq));
    const missing = [];
    for (let s = 0; s <= input.lastPartSeq && missing.length < 100; s++) {
      if (!have.has(s)) missing.push(s);
    }
    throw new HttpError(
      "REVISION_CONFLICT",
      `transcript has a gap; missing parts: ${missing.join(", ")}`,
      true,
      "gap",
    );
  }
  const beyond = stream
    ? await db
        .prepare("SELECT 1 FROM transcript_parts WHERE stream_id = ? AND part_seq > ?")
        .bind(stream.id, input.lastPartSeq)
        .first()
    : null;
  if (beyond) throw new HttpError("INVALID_INPUT", "parts exist beyond lastPartSeq");
  if (input.session) {
    await db
      .prepare("UPDATE transcript_streams SET last_part_seq = ?, updated_at = ? WHERE id = ?")
      .bind(input.lastPartSeq, new Date().toISOString(), stream!.id)
      .run();
    return { workspaceId, body: { runId: input.runId, sessionComplete: true } };
  }
  const run = await db
    .prepare("SELECT persistence FROM runs WHERE id = ?")
    .bind(input.runId)
    .first<{ persistence: string }>();
  if (run?.persistence !== "complete") {
    await db.batch([
      db
        .prepare(
          "UPDATE runs SET persistence = 'complete', updated_at = ? WHERE id = ? AND persistence = 'pending'",
        )
        .bind(new Date().toISOString(), input.runId),
      appendChange(db, {
        workspaceId,
        entityKind: "run",
        entityId: input.runId,
        scope: `workspace:${workspaceId}`,
      }),
    ]);
  }
  return { workspaceId, body: { runId: input.runId, persistence: "complete" as const } };
};

// ------------------------------------------------------------------- Reads

const terminalRunStates = new Set(["succeeded", "failed", "interrupted", "cancelled"]);

/** The Run for a member of its Workspace (like `GET /v1/jobs/:id`); provider ids are only reported as present. */
export const getRun = async (db: D1Database, user: User, id: string) => {
  if (user.workspaceIds.length === 0) throw notFound();
  const row = await db
    .prepare(
      `SELECT r.id, r.job_id, r.workspace_id, r.state, r.execution_generation, r.device_id, r.persistence,
              r.started_at, r.finished_at, r.created_at, r.result_summary, r.result_error,
              r.provider_session_id IS NOT NULL AS has_session, s.confirmed_through_seq,
              (SELECT COUNT(*) FROM transcript_parts p WHERE p.stream_id = s.id) AS parts,
              g.run_id AS git_run_id, g.repository AS git_repository, g.branch AS git_branch,
              g.before AS git_before, g.after AS git_after, g.commits AS git_commits, g.partial AS git_partial,
              g.prs AS git_prs, g.pr_error AS git_pr_error
         FROM runs r LEFT JOIN transcript_streams s ON s.run_id = r.id AND s.kind = 'run'
         LEFT JOIN run_git g ON g.workspace_id = r.workspace_id AND g.run_id = r.id
        WHERE r.id = ? AND r.workspace_id IN (${placeholders(user.workspaceIds)})`,
    )
    .bind(id, ...user.workspaceIds)
    .first<Record<string, string | number | null>>();
  if (!row) throw notFound();
  return {
    id: row.id,
    jobId: row.job_id,
    workspaceId: row.workspace_id,
    state: row.state,
    generation: row.execution_generation,
    deviceId: row.device_id,
    terminal: terminalRunStates.has(row.state as string),
    persistence: row.persistence,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    resultSummary: row.result_summary,
    resultError: row.result_error,
    hasProviderSession: row.has_session === 1,
    transcript: { parts: row.parts ?? 0, confirmedThroughSeq: row.confirmed_through_seq },
    // GIT-01: null when the Run reported no `git.collected` (scratch cwd, not finished, older executor).
    git: row.git_run_id
      ? {
          repository: row.git_repository,
          branch: row.git_branch,
          before: row.git_before,
          after: row.git_after,
          commits: JSON.parse(row.git_commits as string) as unknown[],
          partial: row.git_partial === 1,
          prs: JSON.parse(row.git_prs as string) as unknown[],
          prError: row.git_pr_error,
        }
      : null,
  };
};

/**
 * Who may read a Run's transcript: a workspace owner, or a member of the Channel of the Run's trigger Conversation.
 * A bot-pair Conversation, or a Job without one (Task, Routine, batch), is owner-only. Anything else is a 404.
 */
const transcriptAccess = async (
  db: D1Database,
  user: User,
  runId: string,
  need: "member" | "owner",
) => {
  if (user.workspaceIds.length === 0) throw notFound();
  const row = await db
    .prepare(
      `SELECT r.workspace_id, s.id AS stream_id, s.confirmed_through_seq, s.provider,
              EXISTS (SELECT 1 FROM workspace_members w
                       WHERE w.workspace_id = r.workspace_id AND w.user_id = ?1 AND w.role = 'owner') AS owner,
              EXISTS (SELECT 1 FROM jobs j
                        JOIN inbox_items i ON i.workspace_id = j.workspace_id AND 'inbox:' || i.id = j.trigger_key
                        JOIN conversations cv ON cv.workspace_id = i.workspace_id AND cv.id = i.conversation_id
                        JOIN channel_members m ON m.workspace_id = cv.workspace_id AND m.channel_id = cv.channel_id
                        JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
                       WHERE j.workspace_id = r.workspace_id AND j.id = r.job_id AND cv.kind = 'channel'
                         AND a.user_id = ?1) AS member
         FROM runs r LEFT JOIN transcript_streams s ON s.run_id = r.id AND s.kind = 'run'
        WHERE r.id = ?2 AND r.workspace_id IN (SELECT value FROM json_each(?3))`,
    )
    .bind(user.userId, runId, JSON.stringify(user.workspaceIds))
    .first<{
      workspace_id: string;
      stream_id: string | null;
      confirmed_through_seq: number | null;
      provider: string | null;
      owner: number;
      member: number;
    }>();
  if (!row || !(row.owner === 1 || (need === "member" && row.member === 1))) throw notFound();
  return row;
};

const confirmedParts = async (
  db: D1Database,
  streamId: string,
  confirmedThroughSeq: number,
  from = 0,
  to = confirmedThroughSeq,
) =>
  (
    await db
      .prepare(
        `SELECT part_seq, r2_key, entry_count FROM transcript_parts
          WHERE stream_id = ? AND part_seq BETWEEN ? AND ? ORDER BY part_seq`,
      )
      .bind(streamId, from, Math.min(to, confirmedThroughSeq))
      .all<{ part_seq: number; r2_key: string; entry_count: number }>()
  ).results;

const secret =
  /-----BEGIN[\s\S]*?(?:-----END[^\n]*|$)|(?:sk-|ghp_|xox[a-z]-|AKIA|-----BEGIN)[^\s]*/g;
const maxEntryBytes = 4 * 1024;
const encoder = new TextEncoder();

/** Redacted first, so a cut can never leave half a secret, then cut to 4 KiB of UTF-8. */
export const clean = (text: string) => {
  const redacted = text.replaceAll(secret, "[redacted]");
  const bytes = encoder.encode(redacted);
  if (bytes.length <= maxEntryBytes) return redacted;
  return new TextDecoder().decode(bytes.slice(0, maxEntryBytes)).replace(/�$/, "");
};

type Block = { type?: string; text?: string; name?: string; input?: unknown; content?: unknown };
const blockText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? (content as Block[])
          .flatMap((b) => (b?.type === "text" && typeof b.text === "string" ? [b.text] : []))
          .join("\n")
      : "";

/** One SDK message (a JSONL line) → normalized entries; unknown types and unparseable lines give none. */
export const normalize = (line: string, seq: number): TranscriptEntry[] => {
  let m: {
    type?: string;
    subtype?: string;
    message?: { content?: unknown };
    result?: string;
    errors?: string[];
  };
  try {
    m = JSON.parse(line) as typeof m;
  } catch {
    return [];
  }
  const entry = (kind: TranscriptEntry["kind"], text: string, toolName?: string) => ({
    seq,
    kind,
    text: clean(text),
    ...(toolName ? { toolName } : {}),
  });
  const blocks = Array.isArray(m.message?.content) ? (m.message.content as Block[]) : [];
  switch (m.type) {
    case "system":
      return [entry("system", m.subtype ?? "system")];
    case "assistant":
      return blocks.flatMap((b) =>
        b.type === "text"
          ? [entry("assistant", b.text ?? "")]
          : b.type === "tool_use"
            ? [entry("tool_use", JSON.stringify(b.input ?? {}), b.name)]
            : [],
      );
    case "user":
      if (typeof m.message?.content === "string") return [entry("user", m.message.content)];
      return blocks.flatMap((b) =>
        b.type === "tool_result"
          ? [entry("tool_result", blockText(b.content))]
          : b.type === "text"
            ? [entry("user", b.text ?? "")]
            : [],
      );
    case "result":
      return [
        entry(
          "result",
          m.subtype === "success"
            ? (m.result ?? "")
            : `${m.subtype}: ${(m.errors ?? []).join("; ")}`,
        ),
      ];
    default:
      return [];
  }
};

type CodexItem = {
  type?: string;
  text?: string;
  command?: string;
  status?: string;
  exitCode?: number | null;
  aggregatedOutput?: string | null;
  changes?: { path?: string }[];
  tool?: string;
  server?: string;
  arguments?: unknown;
  contentItems?: { text?: string }[] | null;
  agentThreadId?: string;
  receiverThreadIds?: string[];
};
// Item kinds with nothing for a reader (the user message is taken from `turn/start`).
const silentItems = new Set([
  "userMessage",
  "reasoning",
  "plan",
  "hookPrompt",
  "contextCompaction",
]);

/**
 * One Codex app-server line (`{dir: "in" | "out", msg}` or `{dir: "local", event}`, apps/executor codex adapter) →
 * normalized entries. Sub-agents (AT-20) are named only by the explicit thread id the protocol gives, never
 * attributed to the Bot. Streaming deltas, status and account notifications give none.
 */
export const normalizeCodex = (line: string, seq: number): TranscriptEntry[] => {
  let l: {
    dir?: string;
    event?: string;
    msg?: {
      id?: unknown;
      method?: string;
      params?: Record<string, any>;
      result?: any;
      error?: any;
    };
  };
  try {
    l = JSON.parse(line) as typeof l;
  } catch {
    return [];
  }
  const entry = (kind: TranscriptEntry["kind"], text: string, toolName?: string) => ({
    seq,
    kind,
    text: clean(text),
    ...(toolName ? { toolName } : {}),
  });
  if (l.dir === "local") return [entry("system", l.event ?? "local")];
  const m = l.msg ?? {};
  const p = m.params ?? {};
  if (l.dir === "out") {
    if (m.method === "turn/start") {
      const input = (p.input ?? []) as { text?: string }[];
      return [entry("user", input.map((i) => i.text ?? "").join("\n"))];
    }
    if (typeof m.result?.decision === "string")
      return [entry("system", `approval: ${m.result.decision}`)];
    return [];
  }
  switch (m.method) {
    case "thread/started":
      return [entry("system", "thread started")];
    case "error":
      return [entry("system", `error: ${p.error?.message ?? ""}`)];
    case "item/commandExecution/requestApproval":
      return [entry("system", `approval requested: Bash ${p.command ?? ""}`)];
    case "item/fileChange/requestApproval":
      return [entry("system", "approval requested: Edit")];
    case "turn/completed": {
      const turn = p.turn ?? {};
      const items = (turn.items ?? []) as CodexItem[];
      const final = items.findLast((i) => i.type === "agentMessage")?.text;
      return [
        entry(
          "result",
          turn.status === "completed"
            ? (final ?? "completed")
            : `${turn.status}: ${turn.error?.message ?? ""}`,
        ),
      ];
    }
    case "item/completed":
      break;
    default:
      return [];
  }
  const item = (p.item ?? {}) as CodexItem;
  switch (item.type) {
    case "agentMessage":
      return [entry("assistant", item.text ?? "")];
    case "commandExecution":
      return [
        entry("tool_use", JSON.stringify({ command: item.command }), "Bash"),
        entry(
          "tool_result",
          `${item.status} (exit ${item.exitCode ?? "-"})\n${item.aggregatedOutput ?? ""}`,
        ),
      ];
    case "fileChange":
      return [
        entry("tool_use", (item.changes ?? []).map((c) => c.path).join("\n"), "Edit"),
        entry("tool_result", item.status ?? ""),
      ];
    case "dynamicToolCall":
      return [
        entry("tool_use", JSON.stringify(item.arguments ?? {}), item.tool),
        entry("tool_result", (item.contentItems ?? []).map((c) => c.text ?? "").join("\n")),
      ];
    case "mcpToolCall":
      return [
        entry(
          "tool_use",
          JSON.stringify(item.arguments ?? {}),
          `mcp__${item.server}__${item.tool}`,
        ),
      ];
    case "subAgentActivity":
      return item.agentThreadId ? [entry("system", `sub-agent thread ${item.agentThreadId}`)] : [];
    case "collabAgentToolCall":
      return item.receiverThreadIds?.length
        ? [entry("system", `sub-agent threads ${item.receiverThreadIds.join(", ")}`)]
        : [];
    default:
      return silentItems.has(item.type ?? "")
        ? []
        : [entry("system", `item ${item.type ?? "unknown"}`)];
  }
};

/**
 * One confirmed part per page (≤ 1 MiB from the executor): `cursor` is the part seq, `nextCursor` the next one or
 * null. Only parts up to the watermark are read.
 */
export const getTranscript = async (
  db: D1Database,
  r2: R2Bucket,
  user: User,
  runId: string,
  cursor: string | undefined,
) => {
  const partSeq = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isInteger(partSeq) || partSeq < 0) {
    throw new HttpError("INVALID_INPUT", "cursor must be a part sequence number");
  }
  const access = await transcriptAccess(db, user, runId, "member");
  const confirmed = access.confirmed_through_seq;
  if (!access.stream_id || confirmed === null || partSeq > confirmed) {
    return { entries: [], nextCursor: null, confirmedThroughSeq: confirmed };
  }
  const [part] = await confirmedParts(db, access.stream_id, confirmed, partSeq, partSeq);
  const offset = await db
    .prepare(
      "SELECT COALESCE(SUM(entry_count), 0) AS n FROM transcript_parts WHERE stream_id = ? AND part_seq < ?",
    )
    .bind(access.stream_id, partSeq)
    .first<{ n: number }>();
  const object = part ? await r2.get(part.r2_key) : null;
  if (!part || !object)
    throw new HttpError("UPSTREAM_UNAVAILABLE", "transcript part missing", true);
  const lines = (await object.text()).split("\n");
  if (lines.at(-1) === "") lines.pop();
  return {
    entries: lines.flatMap((line, i) =>
      (access.provider === "codex" ? normalizeCodex : normalize)(line, offset!.n + i),
    ),
    nextCursor: partSeq < confirmed ? String(partSeq + 1) : null,
    confirmedThroughSeq: confirmed,
  };
};

/** Owner only: the confirmed raw parts concatenated, one part in memory at a time. Never indexed (§13.2). */
export const rawTranscript = async (db: D1Database, r2: R2Bucket, user: User, runId: string) => {
  const access = await transcriptAccess(db, user, runId, "owner");
  return concatenated(
    r2,
    access.stream_id && access.confirmed_through_seq !== null
      ? await confirmedParts(db, access.stream_id, access.confirmed_through_seq)
      : [],
  );
};

/**
 * For an executor of the Workspace (any device: the resume may run on another PC): the newest complete snapshot of a
 * native session stream, raw. Complete means `complete` was ACKed and every part through `last_part_seq` is
 * confirmed; anything else is a 404, so the caller starts fresh instead of resuming a partial session.
 */
export const sessionSnapshot = async (
  db: D1Database,
  r2: R2Bucket,
  device: Device,
  provider: string,
  session: SessionStreamKey,
) => {
  const stream = await db
    .prepare(
      `SELECT s.id, s.last_part_seq FROM transcript_streams s
         JOIN runs r ON r.workspace_id = s.workspace_id AND r.id = s.run_id
        WHERE s.workspace_id = ? AND s.kind = 'session' AND s.provider = ? AND s.session_id = ? AND s.subpath = ?
          AND s.last_part_seq IS NOT NULL AND s.confirmed_through_seq >= s.last_part_seq
        ORDER BY r.created_at DESC, r.execution_generation DESC LIMIT 1`,
    )
    .bind(device.workspaceIds[0], provider, session.sessionId, session.subpath ?? "")
    .first<{ id: string; last_part_seq: number }>();
  if (!stream) throw new HttpError("NOT_FOUND", "no complete session snapshot");
  return concatenated(r2, await confirmedParts(db, stream.id, stream.last_part_seq));
};

const concatenated = (r2: R2Bucket, parts: { part_seq: number; r2_key: string }[]) => {
  let next = 0;
  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const part = parts[next++];
      if (!part) return controller.close();
      const object = await r2.get(part.r2_key);
      if (!object) return controller.error(new Error(`transcript part ${part.part_seq} missing`));
      controller.enqueue(new Uint8Array(await object.arrayBuffer()));
    },
  });
};
