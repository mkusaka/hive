// HTTP delta sync over `change_log` (docs/architecture.md §12.2, §12.3).
import { parse } from "@hive/contracts";
import * as v from "valibot";
import { HttpError } from "./errors.ts";

const Cursor = v.strictObject({
  workspaceId: v.string(),
  epoch: v.number(),
  seq: v.number(),
});
type Cursor = v.InferOutput<typeof Cursor>;

/** Opaque to clients: base64url of the JSON `{workspaceId, epoch, seq}`. */
const encodeCursor = (cursor: Cursor) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(cursor))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const decodeCursor = (value: string) => {
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    const json = new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
    const parsed = parse(Cursor, JSON.parse(json));
    return parsed.ok ? parsed.value : null;
  } catch {
    return null;
  }
};

const head = (db: D1Database, workspaceId: string) =>
  db
    .prepare(
      `SELECT auth_epoch AS epoch,
              (SELECT COALESCE(MAX(seq), 0) FROM change_log WHERE workspace_id = w.id) AS seq
         FROM workspaces w WHERE id = ?`,
    )
    .bind(workspaceId)
    .first<{ epoch: number; seq: number }>();

/** The cursor at the newest change: the bootstrap position H0, also sent in `sync.changed` hints. */
export const headCursor = async (db: D1Database, workspaceId: string) => {
  const row = await head(db, workspaceId);
  if (!row) throw new HttpError("NOT_FOUND", "workspace not found");
  return encodeCursor({ workspaceId, ...row });
};

/** `workspace:<id>` plus `channel:<id>` for every channel the user's actor is a member of. */
export const permittedScopes = async (db: D1Database, workspaceId: string, userId: string) => {
  const { results } = await db
    .prepare(
      `SELECT m.channel_id FROM channel_members m
         JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
        WHERE m.workspace_id = ? AND a.user_id = ?`,
    )
    .bind(workspaceId, userId)
    .all<{ channel_id: string }>();
  return [`workspace:${workspaceId}`, ...results.map((r) => `channel:${r.channel_id}`)];
};

const expired = () =>
  new HttpError("CURSOR_EXPIRED", "cursor expired or invalid; bootstrap again", false);

/**
 * Changes after `cursor` in permitted scopes. Rows are filtered after the scan, and the returned cursor is the
 * last scanned seq, so filtered pages still advance (§12.3). No cursor returns the head cursor and no changes.
 */
export const listChanges = async (
  db: D1Database,
  input: { workspaceId: string; userId: string; cursor?: string; limit: number },
) => {
  const { workspaceId, limit } = input;
  if (input.cursor === undefined) {
    return { changes: [], cursor: await headCursor(db, workspaceId), hasMore: false };
  }
  const cursor = decodeCursor(input.cursor);
  const current = await head(db, workspaceId);
  if (!cursor || !current || cursor.workspaceId !== workspaceId || cursor.epoch !== current.epoch) {
    throw expired();
  }
  const { results } = await db
    .prepare(
      `SELECT seq, entity_kind AS entityKind, entity_id AS entityId, op, revision, scope,
              created_at AS createdAt
         FROM change_log WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    )
    .bind(workspaceId, cursor.seq, limit + 1)
    .all<{ seq: number; scope: string }>();
  const scanned = results.slice(0, limit);
  const allowed = new Set(await permittedScopes(db, workspaceId, input.userId));
  return {
    changes: scanned.filter((row) => allowed.has(row.scope)),
    cursor: encodeCursor({ ...cursor, seq: scanned.at(-1)?.seq ?? cursor.seq }),
    hasMore: results.length > limit,
  };
};
