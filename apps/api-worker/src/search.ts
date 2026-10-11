// Search projection over D1 FTS5 (docs/architecture.md §14) and Memory reads (§13.6).
// `search_documents` is a rebuildable projection of messages, tasks and memories; `search_fts` (trigram) follows it
// through triggers (migration 0012). The indexer reads the source's current state, so a late or duplicate
// `search.index` row can only write what is current, and the revision guard keeps an older read from overwriting a
// newer one (§14.2, AT-39). No consumer receipt: the guarded upsert is idempotent.
import {
  type Memory,
  memoryScopeKinds,
  type SearchHit,
  type SearchKind,
  type SearchResult,
} from "@hive/contracts";
import { enqueueOutbox } from "@hive/db";
import type { Principal } from "./auth/principal.ts";
import { HttpError } from "./errors.ts";
import { permittedScopes } from "./sync.ts";

/** Outbox row that (re)indexes one source; goes in the batch that changed it. */
export const indexLater = (
  db: D1Database,
  workspaceId: string,
  sourceKind: SearchKind,
  sourceId: string,
) => enqueueOutbox(db, { workspaceId, topic: "search.index", payload: { sourceKind, sourceId } });

type Doc = {
  workspaceId: string;
  revision: number;
  title: string;
  body: string;
  scope: string;
  deleted: boolean;
};

/** ACL scope of a memory's document: Bot and Task memories are readable by users and by that Bot's / Task's Runs. */
const memoryScope = (workspaceId: string, kind: string, id: string) =>
  kind === "channel" || kind === "bot" || kind === "task"
    ? `${kind}:${id}`
    : `workspace:${workspaceId}`;

const loadSource = async (db: D1Database, kind: SearchKind, id: string): Promise<Doc | null> => {
  if (kind === "message") {
    // Messages are immutable; `seq` stands in for a revision. A thread reply's title is its root message's start.
    const row = await db
      .prepare(
        `SELECT m.workspace_id, m.seq, m.body, c.channel_id, COALESCE(substr(rm.body, 1, 80), '') AS title
           FROM messages m
           JOIN conversations c ON c.workspace_id = m.workspace_id AND c.id = m.conversation_id
           LEFT JOIN messages rm ON rm.workspace_id = c.workspace_id AND rm.id = c.root_message_id
          WHERE m.id = ?`,
      )
      .bind(id)
      .first<{
        workspace_id: string;
        seq: number;
        body: string;
        channel_id: string;
        title: string;
      }>();
    return row
      ? {
          workspaceId: row.workspace_id,
          revision: row.seq,
          title: row.title,
          body: row.body,
          scope: `channel:${row.channel_id}`,
          deleted: false,
        }
      : null;
  }
  if (kind === "task") {
    // A cancelled Task stays searchable.
    const row = await db
      .prepare("SELECT workspace_id, key, title, description, revision FROM tasks WHERE id = ?")
      .bind(id)
      .first<{
        workspace_id: string;
        key: string;
        title: string;
        description: string;
        revision: number;
      }>();
    return row
      ? {
          workspaceId: row.workspace_id,
          revision: row.revision,
          title: `${row.key} ${row.title}`,
          body: row.description,
          scope: `workspace:${row.workspace_id}`,
          deleted: false,
        }
      : null;
  }
  const row = await db
    .prepare(
      "SELECT workspace_id, scope_kind, scope_id, content, revision, deleted_at FROM memories WHERE id = ?",
    )
    .bind(id)
    .first<{
      workspace_id: string;
      scope_kind: string;
      scope_id: string;
      content: string;
      revision: number;
      deleted_at: string | null;
    }>();
  return row
    ? {
        workspaceId: row.workspace_id,
        revision: row.revision,
        title: "",
        body: row.content,
        scope: memoryScope(row.workspace_id, row.scope_kind, row.scope_id),
        deleted: row.deleted_at !== null,
      }
    : null;
};

/**
 * The `search.index` consumer. Upserts the source's current document unless a newer revision is already indexed; a
 * deleted source becomes a tombstone with an empty title and body (kept for the revision guard).
 */
export const indexSource = async (
  db: D1Database,
  input: { sourceKind: SearchKind; sourceId: string },
) => {
  const now = new Date().toISOString();
  const doc = await loadSource(db, input.sourceKind, input.sourceId);
  if (!doc) {
    await db
      .prepare(
        `UPDATE search_documents SET title = '', body = '', deleted_at = COALESCE(deleted_at, ?), indexed_at = ?
          WHERE source_kind = ? AND source_id = ?`,
      )
      .bind(now, now, input.sourceKind, input.sourceId)
      .run();
    return;
  }
  await db
    .prepare(
      `INSERT INTO search_documents (workspace_id, source_kind, source_id, source_revision, chunk_key, title, body,
         scope, deleted_at, indexed_at)
       VALUES (?, ?, ?, ?, '0', ?, ?, ?, ?, ?)
       ON CONFLICT (source_kind, source_id, chunk_key) DO UPDATE SET
         source_revision = excluded.source_revision, title = excluded.title, body = excluded.body,
         scope = excluded.scope, deleted_at = excluded.deleted_at, indexed_at = excluded.indexed_at
       WHERE excluded.source_revision >= search_documents.source_revision`,
    )
    .bind(
      doc.workspaceId,
      input.sourceKind,
      input.sourceId,
      doc.revision,
      doc.deleted ? "" : doc.title,
      doc.deleted ? "" : doc.body,
      doc.scope,
      doc.deleted ? now : null,
      now,
    )
    .run();
};

/**
 * Who may read which documents. `scopes` are exact ACL scopes; `allBotsAndTasks` (users) adds every `bot:` / `task:`
 * scope of the Workspace, since Bots and Tasks are Workspace-visible to members.
 */
export type SearchAccess = { workspaceId: string; scopes: string[]; allBotsAndTasks: boolean };

export const searchAccess = async (
  db: D1Database,
  workspaceId: string,
  principal: Extract<Principal, { kind: "user" | "run" }>,
): Promise<SearchAccess> => ({
  workspaceId,
  scopes: await permittedScopes(db, workspaceId, principal),
  allBotsAndTasks: principal.kind === "user",
});

const permitted = `(d.scope IN (SELECT value FROM json_each(?)) OR (? AND (d.scope LIKE 'bot:%' OR d.scope LIKE 'task:%')))`;

const codePoints = (text: string) => [...text];
const clip = (text: string, max = 200) => codePoints(text).slice(0, max).join("");

/** A phrase string for FTS5: the user's text is never evaluated as query syntax. */
const phrase = (text: string) => `"${text.replaceAll('"', '""')}"`;

const shortPathScan = 200;

type HitRow = {
  source_kind: SearchKind;
  source_id: string;
  title: string;
  snippet: string;
  scope: string;
  source_revision: number;
};
const toHit = (r: HitRow): SearchHit => ({
  sourceKind: r.source_kind,
  sourceId: r.source_id,
  title: r.title,
  snippet: clip(r.snippet),
  scope: r.scope,
  sourceRevision: r.source_revision,
});

/** `[match]` with some context before it. */
const shortSnippet = (text: string, q: string) => {
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return clip(text);
  const before = codePoints(text.slice(0, at)).slice(-40).join("");
  return clip(`${before}[${text.slice(at, at + q.length)}]${text.slice(at + q.length)}`);
};

export const searchDocuments = async (
  db: D1Database,
  access: SearchAccess,
  input: {
    q: string;
    kinds: readonly SearchKind[];
    limit: number;
    offset?: number;
    /** Prebuilt OR of quoted terms (run context); otherwise `q` is matched as one phrase. */
    match?: string;
    excludeMessageId?: string | null;
  },
) => {
  const offset = input.offset ?? 0;
  const common = [
    access.workspaceId,
    JSON.stringify(input.kinds),
    JSON.stringify(access.scopes),
    access.allBotsAndTasks ? 1 : 0,
  ];
  const where = `d.workspace_id = ? AND d.deleted_at IS NULL AND d.source_kind IN (SELECT value FROM json_each(?))
    AND ${permitted} AND NOT (d.source_kind = 'message' AND d.source_id = ?)`;
  const exclude = input.excludeMessageId ?? "";
  if (input.match === undefined && codePoints(input.q).length < 3) {
    // Trigram MATCH needs 3 characters (§14.1). Short queries scan only the 200 newest permitted documents: a
    // substring match on title / body (which covers Task key prefixes, `<key> <title>`), never an unbounded LIKE.
    const like = `%${input.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const { results } = await db
      .prepare(
        `SELECT source_kind, source_id, title, body, scope, source_revision FROM (
           SELECT d.rowid, d.source_kind, d.source_id, d.title, d.body, d.scope, d.source_revision
             FROM search_documents d WHERE ${where} ORDER BY d.rowid DESC LIMIT ${shortPathScan}
         ) WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'
         ORDER BY rowid DESC LIMIT ? OFFSET ?`,
      )
      .bind(...common, exclude, like, like, input.limit, offset)
      .all<Omit<HitRow, "snippet"> & { body: string }>();
    return results.map(({ body, ...r }) =>
      toHit({
        ...r,
        snippet: shortSnippet(
          body.toLowerCase().includes(input.q.toLowerCase()) ? body : r.title,
          input.q,
        ),
      }),
    );
  }
  const { results } = await db
    .prepare(
      `SELECT d.source_kind, d.source_id, d.title, snippet(search_fts, -1, '[', ']', '…', 24) AS snippet, d.scope,
              d.source_revision
         FROM search_fts JOIN search_documents d ON d.rowid = search_fts.rowid
        WHERE search_fts MATCH ? AND ${where}
        ORDER BY bm25(search_fts) LIMIT ? OFFSET ?`,
    )
    .bind(input.match ?? phrase(input.q), ...common, exclude, input.limit, offset)
    .all<HitRow>();
  return results.map(toHit);
};

const parseKinds = (value: string | undefined): SearchKind[] => {
  if (!value) return ["message", "task", "memory"];
  const kinds = value.split(",");
  for (const kind of kinds) {
    if (kind !== "message" && kind !== "task" && kind !== "memory") {
      throw new HttpError("INVALID_INPUT", `unknown kind: ${kind}`);
    }
  }
  return kinds as SearchKind[];
};

/** `GET /v1/search` and `GET /v1/run/search`. The cursor is an offset. */
export const search = async (
  db: D1Database,
  access: SearchAccess,
  input: { q?: string; kinds?: string; limit: number; cursor?: string },
): Promise<SearchResult> => {
  const q = input.q?.trim() ?? "";
  if (q === "") throw new HttpError("INVALID_INPUT", "q is required");
  const offset = Number(input.cursor ?? 0);
  if (!Number.isInteger(offset) || offset < 0)
    throw new HttpError("INVALID_INPUT", "invalid cursor");
  const hits = await searchDocuments(db, access, {
    q,
    kinds: parseKinds(input.kinds),
    limit: input.limit,
    offset,
  });
  const head = await db
    .prepare("SELECT MAX(indexed_at) AS at FROM search_documents WHERE workspace_id = ?")
    .bind(access.workspaceId)
    .first<{ at: string | null }>();
  return {
    hits,
    indexedThrough: head?.at ?? null,
    cursor: hits.length === input.limit ? String(offset + input.limit) : null,
  };
};

/**
 * `context.related` for a Run: the trigger body's words of 3+ characters, each quoted, ORed. Japanese without spaces
 * stays one phrase.
 * ponytail: whitespace / punctuation split only; an NFKC projection and a real term extractor would find more.
 */
export const relatedQuery = (body: string) => {
  const terms = [
    ...new Set(
      body.split(/[\s、。，．,.!?！？「」()（）"']+/u).filter((t) => codePoints(t).length >= 3),
    ),
  ].slice(0, 8);
  return terms.length ? terms.map(phrase).join(" OR ") : null;
};

/**
 * AT-38: drops the Workspace's documents and re-enqueues one `search.index` row per source in the same batch; the
 * pump indexes them 50 rows per pass. Deleted memories come back as tombstones.
 * ponytail: one DELETE and three INSERT ... SELECTs over the whole Workspace; page by rowid if a Workspace outgrows a
 * single D1 batch.
 */
export const rebuildSearch = async (db: D1Database, workspaceId: string) => {
  const enqueue = (kind: SearchKind, table: string) =>
    db
      .prepare(
        `INSERT INTO outbox (id, workspace_id, topic, payload)
         SELECT lower(hex(randomblob(16))), workspace_id, 'search.index',
                json_object('sourceKind', '${kind}', 'sourceId', id)
           FROM ${table} WHERE workspace_id = ?`,
      )
      .bind(workspaceId);
  await db.batch([
    db.prepare("DELETE FROM search_documents WHERE workspace_id = ?").bind(workspaceId),
    enqueue("message", "messages"),
    enqueue("task", "tasks"),
    enqueue("memory", "memories"),
  ]);
  // No counts: D1 `meta.changes` would include the FTS writes of the triggers.
  return { status: "accepted" as const };
};

/** `GET /v1/memories`: live memories of one scope, newest first. A Channel scope needs membership. */
export const listMemories = async (
  db: D1Database,
  access: SearchAccess,
  input: { scopeKind?: string; scopeId?: string },
) => {
  const { scopeKind } = input;
  const scopeId = scopeKind === "workspace" ? access.workspaceId : input.scopeId;
  if (!scopeKind || !scopeId || !memoryScopeKinds.includes(scopeKind as never)) {
    throw new HttpError("INVALID_INPUT", "scopeKind (and scopeId unless workspace) is required");
  }
  if (scopeKind === "channel" && !access.scopes.includes(`channel:${scopeId}`)) {
    throw new HttpError("FORBIDDEN", "not a member of this channel");
  }
  const { results } = await db
    .prepare(
      `SELECT id, scope_kind AS scopeKind, scope_id AS scopeId, content, source_kind AS sourceKind,
              source_id AS sourceId, revision, supersedes_id AS supersedesId, created_at AS createdAt
         FROM memories WHERE workspace_id = ? AND scope_kind = ? AND scope_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC LIMIT 200`,
    )
    .bind(access.workspaceId, scopeKind, scopeId)
    .all<Memory>();
  return { memories: results };
};
