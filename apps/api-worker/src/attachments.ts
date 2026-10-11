import { type AttachmentInit, type AttachmentSummary, maxAttachmentBytes } from "@hive/contracts";
import { enqueueOutbox, guard } from "@hive/db";
import { HttpError } from "./errors.ts";
import type { Principal } from "./auth/principal.ts";

type User = Extract<Principal, { kind: "user" }>;
type Run = Extract<Principal, { kind: "run" }>;
type AttachmentRow = AttachmentSummary & {
  workspaceId: string;
  uploaderActorId: string;
  conversationId: string;
  messageId: string | null;
  r2Key: string;
  sha256: string | null;
  state: "pending" | "ready";
};

const attachmentColumns = `a.id, a.name, a.content_type AS contentType, a.size, a.workspace_id AS workspaceId,
  a.uploader_actor_id AS uploaderActorId, a.conversation_id AS conversationId, a.message_id AS messageId,
  a.r2_key AS r2Key, a.sha256, a.state`;
const objectKey = (workspaceId: string, id: string) => `workspace/${workspaceId}/attachment/${id}`;
const summary = (row: AttachmentRow): AttachmentSummary => ({
  id: row.id,
  name: row.name,
  contentType: row.contentType,
  size: row.size,
});

const userActor = (db: D1Database, workspaceId: string, userId: string) =>
  db
    .prepare("SELECT id FROM actors WHERE workspace_id = ? AND user_id = ? AND kind = 'user'")
    .bind(workspaceId, userId)
    .first<{ id: string }>();

/** The exact conversation where a corresponding message.post will land. */
const destination = async (db: D1Database, user: User, input: AttachmentInit) => {
  const actor = await userActor(db, input.workspaceId, user.userId);
  if (!actor) throw new HttpError("FORBIDDEN", "not a member of this workspace");
  const parent = await (
    input.channelId
      ? db
          .prepare(
            `SELECT c.id, c.channel_id FROM conversations c
             JOIN channel_members m ON m.workspace_id = c.workspace_id AND m.channel_id = c.channel_id
            WHERE c.workspace_id = ? AND c.channel_id = ? AND c.kind = 'channel' AND m.actor_id = ?`,
          )
          .bind(input.workspaceId, input.channelId, actor.id)
      : db
          .prepare(
            `SELECT c.id, c.channel_id FROM conversations c
            WHERE c.workspace_id = ? AND c.id = ? AND c.kind = 'dm' AND c.dm_user_id = ?`,
          )
          .bind(input.workspaceId, input.conversationId, user.userId)
  ).first<{ id: string; channel_id: string }>();
  if (!parent) {
    throw new HttpError(input.channelId ? "FORBIDDEN" : "NOT_FOUND", "conversation not found");
  }
  if (!input.threadOf)
    return { actorId: actor.id, conversationId: parent.id, channelId: parent.channel_id };
  const root = await db
    .prepare("SELECT id FROM messages WHERE workspace_id = ? AND id = ? AND conversation_id = ?")
    .bind(input.workspaceId, input.threadOf, parent.id)
    .first<{ id: string }>();
  if (!root) throw new HttpError("NOT_FOUND", "thread root message not found");
  const conversationId = `thread-${root.id}`;
  return {
    actorId: actor.id,
    conversationId,
    channelId: parent.channel_id,
    rootId: root.id,
    parentId: parent.id,
  };
};

/** Creates the pending manifest (and a deterministic empty thread when needed) before the PUT. */
export const initAttachment = async (
  db: D1Database,
  user: User,
  input: AttachmentInit,
): Promise<{ id: string; uploadUrl: string }> => {
  if (!user.workspaceIds.includes(input.workspaceId)) {
    throw new HttpError("FORBIDDEN", "not a member of this workspace");
  }
  const target = await destination(db, user, input);
  const id = crypto.randomUUID();
  await db.batch([
    ...(target.rootId
      ? [
          db
            .prepare(
              `INSERT INTO conversations (id, workspace_id, channel_id, kind, root_message_id, parent_conversation_id)
               VALUES (?, ?, ?, 'thread', ?, ?) ON CONFLICT DO NOTHING`,
            )
            .bind(
              target.conversationId,
              input.workspaceId,
              target.channelId,
              target.rootId,
              target.parentId,
            ),
        ]
      : []),
    db
      .prepare(
        `INSERT INTO attachments (id, workspace_id, uploader_actor_id, conversation_id, name, content_type, size,
          r2_key, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.workspaceId,
        target.actorId,
        target.conversationId,
        input.name,
        input.contentType,
        input.size,
        objectKey(input.workspaceId, id),
        input.sha256 ?? null,
      ),
  ]);
  return { id, uploadUrl: `/v1/attachments/${id}/content` };
};

const uploadedBy = async (db: D1Database, user: User, id: string) => {
  const row = await db
    .prepare(
      `SELECT ${attachmentColumns} FROM attachments a
       JOIN actors u ON u.workspace_id = a.workspace_id AND u.id = a.uploader_actor_id
       WHERE a.id = ? AND u.user_id = ? AND u.kind = 'user'`,
    )
    .bind(id, user.userId)
    .first<AttachmentRow>();
  if (!row) throw new HttpError("NOT_FOUND", "attachment not found");
  return row;
};

const discardOwnObject = async (r2: R2Bucket, key: string, attemptId: string) => {
  const object = await r2.head(key);
  if (object?.customMetadata?.attemptId === attemptId) await r2.delete(key);
};

/** Streams one immutable body into R2. R2 enforces an optional SHA-256 while the transform bounds the stream. */
export const putAttachmentContent = async (
  db: D1Database,
  r2: R2Bucket,
  user: User,
  id: string,
  body: ReadableStream<Uint8Array> | null,
) => {
  const row = await uploadedBy(db, user, id);
  if (row.state !== "pending")
    throw new HttpError("REVISION_CONFLICT", "attachment is already complete");
  if (!body) throw new HttpError("INVALID_INPUT", "attachment body is required");
  if (await r2.head(row.r2Key)) {
    throw new HttpError(
      "REVISION_CONFLICT",
      "attachment content was already uploaded",
      false,
      "content_uploaded",
    );
  }
  let size = 0;
  let streamError: HttpError | null = null;
  const attemptId = crypto.randomUUID();
  const bounded = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > row.size || size > maxAttachmentBytes) {
          streamError = new HttpError("PAYLOAD_TOO_LARGE", "attachment is too large");
          controller.error(streamError);
          return;
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        if (size !== row.size) {
          streamError = new HttpError(
            "INVALID_INPUT",
            "body size does not match declared size",
            false,
            "size_mismatch",
          );
          controller.error(streamError);
        }
      },
    }),
  );
  const fixed = new FixedLengthStream(row.size);
  const copyAbort = new AbortController();
  const copied = bounded.pipeTo(fixed.writable, { signal: copyAbort.signal }).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    const stored = await r2.put(row.r2Key, fixed.readable, {
      ...(row.sha256 ? { sha256: row.sha256 } : {}),
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: { attachmentId: id, attemptId },
      httpMetadata: { contentType: row.contentType },
    });
    if (!stored) {
      copyAbort.abort();
      await copied;
      throw new HttpError(
        "REVISION_CONFLICT",
        "attachment content was already uploaded",
        false,
        "content_uploaded",
      );
    }
    const copyError = await copied;
    if (copyError) throw copyError;
  } catch (error) {
    copyAbort.abort();
    await copied;
    if (streamError) {
      await discardOwnObject(r2, row.r2Key, attemptId);
      throw streamError;
    }
    await discardOwnObject(r2, row.r2Key, attemptId);
    if (error instanceof HttpError) throw error;
    if (
      row.sha256 &&
      error instanceof Error &&
      /(?:sha-?256|checksum).*(?:mismatch|invalid|did not match)|(?:mismatch|invalid).*(?:sha-?256|checksum)/i.test(
        error.message,
      )
    ) {
      throw new HttpError("INVALID_INPUT", "body does not match sha256", false, "sha256_mismatch");
    }
    if (error instanceof Error && /conditional|precondition|etag/i.test(error.message)) {
      throw new HttpError(
        "REVISION_CONFLICT",
        "attachment content was already uploaded",
        false,
        "content_uploaded",
      );
    }
    throw error;
  }
  if (size !== row.size) {
    await discardOwnObject(r2, row.r2Key, attemptId);
    throw new HttpError(
      "INVALID_INPUT",
      "body size does not match declared size",
      false,
      "size_mismatch",
    );
  }
  return { id, uploaded: true };
};

export const completeAttachment = async (db: D1Database, r2: R2Bucket, user: User, id: string) => {
  const row = await uploadedBy(db, user, id);
  if (row.state === "ready") return summary(row);
  const object = await r2.head(row.r2Key);
  if (!object || object.size !== row.size || object.customMetadata?.attachmentId !== id) {
    throw new HttpError(
      "REVISION_CONFLICT",
      "attachment content has not been uploaded",
      false,
      "content_missing",
    );
  }
  const { meta } = await db
    .prepare("UPDATE attachments SET state = 'ready' WHERE id = ? AND state = 'pending'")
    .bind(id)
    .run();
  if (meta.changes === 0) {
    const current = await uploadedBy(db, user, id);
    if (current.state === "ready") return summary(current);
    throw new HttpError("REVISION_CONFLICT", "attachment changed during completion");
  }
  return summary({ ...row, state: "ready" });
};

/** Guards each update so a concurrent attach or an invalid attachment rolls back the complete message batch. */
export const attachmentStatements = (
  db: D1Database,
  input: {
    workspaceId: string;
    messageId: string;
    actorId: string;
    conversationId: string;
    attachmentIds: string[];
  },
) =>
  input.attachmentIds.flatMap((id) => {
    const [setGuard, clearGuard] = guard(db);
    return [
      db
        .prepare(
          `UPDATE attachments SET message_id = ?
            WHERE workspace_id = ? AND id = ? AND uploader_actor_id = ? AND conversation_id = ?
              AND state = 'ready' AND message_id IS NULL`,
        )
        .bind(input.messageId, input.workspaceId, id, input.actorId, input.conversationId),
      setGuard,
      clearGuard,
    ];
  });

const reader = async (db: D1Database, userId: string, id: string) => {
  const row = await db
    .prepare(
      `SELECT ${attachmentColumns} FROM attachments a
       JOIN conversations c ON c.workspace_id = a.workspace_id AND c.id = a.conversation_id
       JOIN conversations p ON p.workspace_id = c.workspace_id AND p.id = COALESCE(c.parent_conversation_id, c.id)
       WHERE a.id = ? AND a.state = 'ready' AND
         ((p.kind = 'dm' AND p.dm_user_id = ?) OR
          (p.kind = 'channel' AND EXISTS (SELECT 1 FROM channel_members cm JOIN actors ca
            ON ca.workspace_id = cm.workspace_id AND ca.id = cm.actor_id
            WHERE cm.workspace_id = p.workspace_id AND cm.channel_id = p.channel_id AND ca.user_id = ?)))`,
    )
    .bind(id, userId, userId)
    .first<AttachmentRow>();
  if (!row) throw new HttpError("NOT_FOUND", "attachment not found");
  return row;
};

export const readAttachment = async (db: D1Database, r2: R2Bucket, user: User, id: string) => {
  const row = await reader(db, user.userId, id);
  const object = await r2.get(row.r2Key);
  if (!object) throw new HttpError("NOT_FOUND", "attachment not found");
  return { row, object };
};

/** A Run can read attachments only from the conversation that triggered its capability, including a thread's parent. */
export const readRunAttachment = async (db: D1Database, r2: R2Bucket, run: Run, id: string) => {
  const row = await db
    .prepare(
      `SELECT ${attachmentColumns} FROM attachments a
       JOIN conversations c ON c.workspace_id = a.workspace_id AND c.id = a.conversation_id
       JOIN conversations rc ON rc.workspace_id = a.workspace_id AND rc.id = ?
       WHERE a.id = ? AND a.workspace_id = ? AND a.state = 'ready'
         AND COALESCE(c.parent_conversation_id, c.id) = COALESCE(rc.parent_conversation_id, rc.id)`,
    )
    .bind(run.conversationId, id, run.workspaceId)
    .first<AttachmentRow>();
  if (!row) throw new HttpError("NOT_FOUND", "attachment not found");
  const object = await r2.get(row.r2Key);
  if (!object) throw new HttpError("NOT_FOUND", "attachment not found");
  return { row, object };
};

/** Queues R2 deletion with the guarded manifest deletion after 24 hours. */
export const collectAttachments = async (db: D1Database) => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { results } = await db
    .prepare(
      `SELECT id, workspace_id, r2_key, state, message_id FROM attachments
        WHERE created_at < ? AND (state = 'pending' OR (state = 'ready' AND message_id IS NULL))
        ORDER BY created_at LIMIT 200`,
    )
    .bind(cutoff)
    .all<{
      id: string;
      workspace_id: string;
      r2_key: string;
      state: string;
      message_id: string | null;
    }>();
  const deleted = await Promise.all(
    results.map(async (item) => {
      const [setGuard, clearGuard] = guard(db);
      try {
        await db.batch([
          db
            .prepare(
              `DELETE FROM attachments WHERE id = ? AND created_at < ? AND state = ?
                AND ((? IS NULL AND message_id IS NULL) OR message_id = ?)`,
            )
            .bind(item.id, cutoff, item.state, item.message_id, item.message_id),
          setGuard,
          enqueueOutbox(db, {
            workspaceId: item.workspace_id,
            topic: "attachment.gc",
            payload: { r2Key: item.r2_key },
          }),
          clearGuard,
        ]);
        return 1;
      } catch (error) {
        if (error instanceof Error && error.message.includes("atomic_guards_ok")) return 0;
        throw error;
      }
    }),
  );
  return deleted.reduce<number>((sum, current) => sum + current, 0);
};
