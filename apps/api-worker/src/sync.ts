// HTTP delta sync over `change_log` (docs/architecture.md §12.2, §12.3).
import { parse } from "@hive/contracts";
import * as v from "valibot";
import type { Principal } from "./auth/principal.ts";
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

/**
 * A user: `workspace:<id>`, their Channel / DM scopes, and private device scopes for devices they own (or all
 * devices when they own the Workspace). A Run: its Workspace, Conversation Channel and own Bot / Task scopes.
 */
export const permittedScopes = async (
  db: D1Database,
  workspaceId: string,
  principal: { kind: "user"; userId: string } | Extract<Principal, { kind: "run" }>,
) => {
  if (principal.kind === "run") {
    return [
      `workspace:${workspaceId}`,
      `bot:${principal.botId}`,
      ...(principal.channelId ? [`channel:${principal.channelId}`] : []),
      ...(principal.taskId ? [`task:${principal.taskId}`] : []),
    ];
  }
  const { results } = await db
    .prepare(
      `SELECT 'channel:' || m.channel_id AS scope FROM channel_members m
         JOIN actors a ON a.workspace_id = m.workspace_id AND a.id = m.actor_id
        WHERE m.workspace_id = ?1 AND a.user_id = ?2
       UNION ALL
       SELECT 'channel:' || channel_id AS scope FROM conversations
        WHERE workspace_id = ?1 AND kind = 'dm' AND dm_user_id = ?2
       UNION ALL
       SELECT 'device:' || d.id AS scope FROM devices d
        WHERE d.workspace_id = ?1 AND (d.owner_user_id = ?2 OR EXISTS (
          SELECT 1 FROM workspace_members m
           WHERE m.workspace_id = d.workspace_id AND m.user_id = ?2 AND m.role = 'owner'))`,
    )
    .bind(workspaceId, principal.userId)
    .all<{ scope: string }>();
  return [`workspace:${workspaceId}`, ...results.map((r) => r.scope)];
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
  const allowed = new Set(
    await permittedScopes(db, workspaceId, { kind: "user", userId: input.userId }),
  );
  return {
    changes: scanned.filter((row) => allowed.has(row.scope)),
    cursor: encodeCursor({ ...cursor, seq: scanned.at(-1)?.seq ?? cursor.seq }),
    hasMore: results.length > limit,
  };
};
