import {
  allowedAttachmentContentTypes,
  AttachmentInit,
  ExecutorHeartbeat,
  ExternalRunInput,
  maxAttachmentBytes,
  maxTranscriptPartBytes,
  mentionedUserIds,
  parse,
  RunObservation,
  type RunPrincipal,
  SessionStreamKey,
  UploadComplete,
  UploadInit,
} from "@hive/contracts";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { JWTVerifyGetKey } from "jose";
import * as v from "valibot";
import { authenticateUser, remoteJwks } from "./auth/access.ts";
import { authenticateDevice, hasDeviceBearerToken, hiveToken } from "./auth/device.ts";
import type { Principal } from "./auth/principal.ts";
import { authenticateRun } from "./auth/run.ts";
import {
  completeAttachment,
  initAttachment,
  putAttachmentContent,
  readAttachment,
  readRunAttachment,
} from "./attachments.ts";
import { CommandEnvelope, RunEnvelope, runCommand, runRunCommand } from "./commands.ts";
import { HttpError, toErrorResponse } from "./errors.ts";
import {
  type Device,
  ExecutorEnvelope,
  getExecutorRun,
  getRunContext,
  heartbeat,
  listQueuedJobs,
  recordObservation,
  runExecutorCommand,
  upsertExternalRun,
} from "./executor.ts";
import { createPerformers, getRunEffect, listEffects } from "./effects.ts";
import { pump } from "./pump.ts";
import {
  getJob,
  getTask,
  getOperation,
  getRunApproval,
  getSidebar,
  getStatus,
  listAudit,
  listBotConversations,
  listBots,
  listApprovals,
  listChannels,
  listChannelMembers,
  listDevices,
  listDms,
  listInbox,
  listJobs,
  listMessages,
  listProjects,
  channelPresence,
  listRuns,
  listRoutines,
  listSubscriptions,
  listThreads,
  listTasks,
  listUsers,
} from "./queries.ts";
import {
  type Attachment,
  type Notification,
  notify,
  principalHeader,
  type Realtime,
} from "./realtime.ts";
import { maxRoutineWebhookBytes, receiveRoutineWebhook } from "./routineWebhook.ts";
import { listMemories, rebuildSearch, search, searchAccess } from "./search.ts";
import {
  approvalRecipients,
  dmReplyRecipient,
  mentionedUserRecipients,
  registerMobilePushToken,
  sendMobilePush,
  unregisterMobilePushToken,
} from "./push.ts";
import { mobileLinks } from "./mobileLinks.ts";
import { listChanges, permittedScopes } from "./sync.ts";
import {
  completeUpload,
  getRun,
  getTranscript,
  initUpload,
  putPart,
  rawTranscript,
  sessionSnapshot,
} from "./transcripts.ts";

export type Bindings = {
  DB: D1Database;
  R2: R2Bucket;
  REALTIME: DurableObjectNamespace<Realtime>;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** Local dev only: a JSON Web Key Set used instead of the Access certs (`.dev.vars`). */
  ACCESS_DEV_JWKS?: string;
  /** External effect credentials (effects.ts), Workers secrets. Unset → that effect kind fails as not configured. */
  SLACK_BOT_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_INSTALLATION_ID?: string;
  /** Firebase service-account JSON for FCM HTTP v1. Unset disables mobile push delivery. */
  FCM_SERVICE_ACCOUNT_JSON?: string;
};
export type AppEnv = {
  Bindings: Bindings;
  Variables: { requestId: string; operationId?: string; principal: Principal };
};

const MobileRegistration = v.strictObject({
  instanceId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  token: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
});
const MobileUnregistration = v.strictObject({
  instanceId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
});

const user = (c: { get: (key: "principal") => Principal }) => {
  const principal = c.get("principal");
  if (principal.kind !== "user") throw new HttpError("FORBIDDEN", "user principal required");
  return principal;
};
const device = (c: { get: (key: "principal") => Principal }): Device => {
  const principal = c.get("principal");
  if (principal.kind !== "device") throw new HttpError("FORBIDDEN", "device principal required");
  return principal;
};
const runPrincipal = (c: { get: (key: "principal") => Principal }) => {
  const principal = c.get("principal");
  if (principal.kind !== "run") throw new HttpError("FORBIDDEN", "run capability required");
  return principal;
};

const tooLarge = () =>
  new HttpError("INVALID_INPUT", `a part is at most ${maxTranscriptPartBytes} bytes`);

/** Transcript uploads take the Run capability or, after it was revoked at result submit, the device token. */
const uploader = (c: { get: (key: "principal") => Principal }) => {
  const principal = c.get("principal");
  if (principal.kind !== "device" && principal.kind !== "run") {
    throw new HttpError("FORBIDDEN", "device or run principal required");
  }
  return principal;
};

/** `?workspaceId=`, which the principal must belong to (403 otherwise). */
const workspaceParam = (c: Context<AppEnv>) => {
  const workspaceId = c.req.query("workspaceId");
  if (!workspaceId) throw new HttpError("INVALID_INPUT", "workspaceId is required");
  if (!c.get("principal").workspaceIds.includes(workspaceId)) {
    throw new HttpError("FORBIDDEN", "not a member of this workspace");
  }
  return workspaceId;
};

const limitParam = (c: Context<AppEnv>, fallback: number, max: number) => {
  const limit = Number(c.req.query("limit") ?? fallback);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new HttpError("INVALID_INPUT", `limit must be an integer in 1..${max}`);
  }
  return limit;
};

/** Realtime hint after the response; losing it is fine (§12.2). */
const hint = (c: Context<AppEnv>, n: Notification) => c.executionCtx.waitUntil(notify(c.env, n));

/** `jwks` and `fetchImpl` are injectable so tests can sign Access assertions and observe FCM requests. */
export const createApp = ({
  jwks = remoteJwks,
  fetchImpl = fetch,
}: { jwks?: (env: Bindings) => JWTVerifyGetKey; fetchImpl?: typeof fetch } = {}) => {
  const app = new Hono<AppEnv>();

  app.use(async (c, next) => {
    c.set("requestId", c.req.header("cf-ray") ?? crypto.randomUUID());
    await next();
    c.header("X-Request-Id", c.get("requestId"));
  });
  app.onError(toErrorResponse);
  app.notFound((c) => toErrorResponse(new HttpError("NOT_FOUND", "route not found"), c));

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.route("/", mobileLinks);

  // Per-Routine HMAC authenticates this hook; it is intentionally outside the `/v1/*` Access middleware.
  app.post("/v1/hooks/routines/:routineId", async (c) => {
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength > maxRoutineWebhookBytes) {
      return c.json({ error: `payload exceeds ${maxRoutineWebhookBytes} bytes` }, 413);
    }
    return c.json(
      await receiveRoutineWebhook(c.env.DB, {
        routineId: c.req.param("routineId"),
        signature: c.req.header("X-Hive-Signature") ?? "",
        deliveryId: c.req.header("X-Hive-Delivery") ?? null,
        body,
      }),
    );
  });

  // Executor routes take device tokens (uploads also a Run capability) and `/v1/run/` routes a Run capability; every
  // other /v1 route takes a user's Access assertion. Realtime only treats X-Hive-Token or a device-shaped Bearer as a
  // device credential, so a local Access JWT in Authorization can upgrade a user socket.
  app.use("/v1/*", async (c, next) => {
    const token = hiveToken(c.req.raw);
    const deviceAuth =
      c.req.path.startsWith("/v1/executor/") ||
      (c.req.path === "/v1/realtime" &&
        (c.req.header("X-Hive-Token") !== undefined || hasDeviceBearerToken(c.req.raw)));
    const capability =
      c.req.path.startsWith("/v1/run/") ||
      (c.req.path.startsWith("/v1/executor/uploads/") && token?.startsWith("cap.") === true);
    c.set(
      "principal",
      capability
        ? await authenticateRun(c.req.raw, c.env)
        : deviceAuth
          ? await authenticateDevice(c.req.raw, c.env)
          : await authenticateUser(c.req.raw, c.env, jwks(c.env)),
    );
    await next();
  });

  // A user also gets a label (email, else id; the desktop account avatar) and their Workspaces' names ("Choose a
  // workspace").
  app.get("/v1/me", async (c) => {
    const principal = c.get("principal");
    if (principal.kind !== "user") return c.json(principal);
    const db = c.env.DB;
    const [row, { results }] = await Promise.all([
      db
        .prepare("SELECT email FROM users WHERE id = ?")
        .bind(principal.userId)
        .first<{ email: string | null }>(),
      db
        .prepare(
          `SELECT w.id, w.name FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
           WHERE m.user_id = ? ORDER BY w.name, w.id`,
        )
        .bind(principal.userId)
        .all<{ id: string; name: string }>(),
    ]);
    return c.json({ ...principal, label: row?.email ?? principal.userId, workspaces: results });
  });
  app.get("/v1/executor/me", (c) => c.json(c.get("principal")));

  app.post("/v1/devices/mobile", async (c) => {
    const parsed = parse(MobileRegistration, await c.req.json().catch(() => null));
    if (!parsed.ok) throw new HttpError("INVALID_INPUT", parsed.issues.join("; "));
    await registerMobilePushToken(c.env.DB, user(c).userId, parsed.value);
    return c.json({ ok: true });
  });
  app.delete("/v1/devices/mobile", async (c) => {
    const parsed = parse(MobileUnregistration, await c.req.json().catch(() => null));
    if (!parsed.ok) throw new HttpError("INVALID_INPUT", parsed.issues.join("; "));
    await unregisterMobilePushToken(c.env.DB, user(c).userId, parsed.value.instanceId);
    return c.json({ ok: true });
  });

  app.get("/v1/mobile/targets/:kind/:id", async (c) => {
    const principal = user(c);
    const { kind, id } = c.req.param();
    if (kind === "approval") {
      const target = await c.env.DB.prepare(
        `SELECT a.workspace_id AS workspaceId FROM approvals a
           JOIN workspace_members m ON m.workspace_id = a.workspace_id
           WHERE a.id = ? AND m.user_id = ?`,
      )
        .bind(id, principal.userId)
        .first<{ workspaceId: string }>();
      if (!target) throw new HttpError("NOT_FOUND", "notification target not found");
      return c.json({ kind, id, ...target });
    }
    if (kind === "job") {
      const target = await c.env.DB.prepare(
        `SELECT j.workspace_id AS workspaceId FROM jobs j
           JOIN workspace_members m ON m.workspace_id = j.workspace_id
           WHERE j.id = ? AND m.user_id = ?`,
      )
        .bind(id, principal.userId)
        .first<{ workspaceId: string }>();
      if (!target) throw new HttpError("NOT_FOUND", "notification target not found");
      return c.json({ kind, id, ...target });
    }
    if (kind !== "mention")
      throw new HttpError("INVALID_INPUT", "unknown notification target kind");
    const target = await c.env.DB.prepare(
      `SELECT c.workspace_id AS workspaceId, c.channel_id AS channelId, c.id AS conversationId,
                c.kind AS conversationKind, COALESCE(c.dm_bot_id, parent.dm_bot_id) AS botId
           FROM conversations c
           LEFT JOIN conversations parent
             ON parent.workspace_id = c.workspace_id
            AND parent.id = COALESCE(c.parent_conversation_id, c.id)
          WHERE c.id = ?
            AND EXISTS (SELECT 1 FROM workspace_members m
                         WHERE m.workspace_id = c.workspace_id AND m.user_id = ?)
            AND EXISTS (
              SELECT 1 FROM conversations p
               WHERE p.workspace_id = c.workspace_id
                 AND p.id = COALESCE(c.parent_conversation_id, c.id)
                 AND ((p.kind = 'dm' AND p.dm_user_id = ?)
                      OR (p.kind = 'channel' AND EXISTS (
                        SELECT 1 FROM channel_members cm
                        JOIN actors a ON a.workspace_id = cm.workspace_id AND a.id = cm.actor_id
                        WHERE cm.workspace_id = p.workspace_id AND cm.channel_id = p.channel_id
                          AND a.user_id = ?))))`,
    )
      .bind(id, principal.userId, principal.userId, principal.userId)
      .first<{
        workspaceId: string;
        channelId: string;
        conversationId: string;
        conversationKind: string;
        botId: string | null;
      }>();
    if (!target) throw new HttpError("NOT_FOUND", "notification target not found");
    return c.json({ kind, id, ...target });
  });

  app.post("/v1/commands", async (c) => {
    const parsed = parse(CommandEnvelope, await c.req.json().catch(() => null));
    if (!parsed.ok) throw new HttpError("INVALID_INPUT", parsed.issues.join("; "));
    c.set("operationId", parsed.value.operationId);
    const result = await runCommand(c.env.DB, c.get("principal"), parsed.value);
    hint(c, { workspaceId: parsed.value.workspaceId, scopes: result.scopes ?? [] });
    if (parsed.value.command.type === "message.post" && result.scopes?.length) {
      const recipientIds = parsed.value.command.conversationId
        ? []
        : await mentionedUserRecipients(
            c.env.DB,
            parsed.value.workspaceId,
            parsed.value.command.channelId!,
            mentionedUserIds(parsed.value.command.text),
          );
      const conversationId =
        result.response &&
        typeof result.response === "object" &&
        "conversationId" in result.response &&
        typeof result.response.conversationId === "string"
          ? result.response.conversationId
          : null;
      if (recipientIds.length > 0 && conversationId) {
        c.executionCtx.waitUntil(
          sendMobilePush(
            c.env.DB,
            c.env,
            { recipients: recipientIds, kind: "mention", id: conversationId },
            fetchImpl,
          ),
        );
      }
    }
    return c.json(result.response, result.status as ContentfulStatusCode);
  });

  app.post("/v1/attachments/init", async (c) => {
    const body = await c.req.json().catch(() => null);
    const contentType =
      body && typeof body === "object" && "contentType" in body ? body.contentType : null;
    if (
      typeof contentType !== "string" ||
      !allowedAttachmentContentTypes.some((allowed) => allowed === contentType)
    ) {
      throw new HttpError("UNSUPPORTED_MEDIA_TYPE", "attachment content type is not allowed");
    }
    const size = body && typeof body === "object" && "size" in body ? body.size : null;
    if (typeof size === "number" && size > maxAttachmentBytes) {
      throw new HttpError("PAYLOAD_TOO_LARGE", "attachment is too large");
    }
    const parsed = parse(AttachmentInit, body);
    if (!parsed.ok) throw new HttpError("INVALID_INPUT", parsed.issues.join("; "));
    return c.json(await initAttachment(c.env.DB, user(c), parsed.value));
  });
  app.put("/v1/attachments/:id/content", async (c) => {
    const contentLength = Number(c.req.header("Content-Length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > maxAttachmentBytes) {
      throw new HttpError("PAYLOAD_TOO_LARGE", "attachment is too large");
    }
    return c.json(
      await putAttachmentContent(c.env.DB, c.env.R2, user(c), c.req.param("id"), c.req.raw.body),
    );
  });
  app.post("/v1/attachments/:id/complete", async (c) =>
    c.json(await completeAttachment(c.env.DB, c.env.R2, user(c), c.req.param("id"))),
  );
  app.get("/v1/attachments/:id", async (c) => {
    const { row, object } = await readAttachment(c.env.DB, c.env.R2, user(c), c.req.param("id"));
    return c.body(object.body, 200, {
      "Content-Type": row.contentType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    });
  });

  app.post("/v1/executor/pump", async (c) =>
    c.json(
      await pump(c.env.DB, {
        owner: `device:${device(c).deviceId}`,
        limit: 50,
        r2: c.env.R2,
        notify: (n) => hint(c, n),
        performers: createPerformers(c.env),
      }),
    ),
  );

  app.post("/v1/executor/commands", async (c) => {
    const parsed = parse(ExecutorEnvelope, await c.req.json().catch(() => null));
    if (!parsed.ok) throw new HttpError("INVALID_INPUT", parsed.issues.join("; "));
    c.set("operationId", parsed.value.operationId);
    const result = await runExecutorCommand(c.env.DB, device(c), parsed.value);
    hint(c, { workspaceId: parsed.value.workspaceId, scopes: result.scopes ?? [] });
    if (
      result.scopes?.length &&
      parsed.value.command.type === "run.result.submit" &&
      parsed.value.command.reply
    ) {
      const recipient = await dmReplyRecipient(
        c.env.DB,
        parsed.value.workspaceId,
        parsed.value.command.reply.conversationId,
      );
      if (recipient) {
        c.executionCtx.waitUntil(
          sendMobilePush(
            c.env.DB,
            c.env,
            {
              recipients: [recipient],
              kind: "mention",
              id: parsed.value.command.reply.conversationId,
            },
            fetchImpl,
          ),
        );
      }
    }
    return c.json(result.response, result.status as ContentfulStatusCode);
  });
  app.post("/v1/executor/heartbeat", async (c) => {
    const parsed = parse(ExecutorHeartbeat, await c.req.json().catch(() => ({})));
    if (!parsed.ok) throw new HttpError("INVALID_INPUT", parsed.issues.join("; "));
    return c.json(await heartbeat(c.env.DB, device(c), parsed.value));
  });

  app.post("/v1/executor/external-runs", async (c) => {
    const parsed = parse(ExternalRunInput, await c.req.json().catch(() => null));
    if (!parsed.ok) throw new HttpError("INVALID_INPUT", parsed.issues.join("; "));
    const result = await upsertExternalRun(c.env.DB, device(c), parsed.value);
    hint(c, {
      workspaceId: device(c).workspaceIds[0]!,
      scopes: [`workspace:${device(c).workspaceIds[0]!}`],
    });
    return c.json(result);
  });
  app.get("/v1/executor/jobs", async (c) => {
    if (c.req.query("state") !== "queued")
      throw new HttpError("INVALID_INPUT", "state=queued is required");
    return c.json(await listQueuedJobs(c.env.DB, device(c), limitParam(c, 50, 100)));
  });
  app.get("/v1/executor/runs/:id", async (c) =>
    c.json(await getExecutorRun(c.env.DB, device(c), c.req.param("id"))),
  );
  app.get("/v1/executor/jobs/:id/context", async (c) => {
    const runId = c.req.query("runId");
    const executionGeneration = Number(c.req.query("executionGeneration"));
    if (!runId || !Number.isInteger(executionGeneration)) {
      throw new HttpError("INVALID_INPUT", "runId and executionGeneration are required");
    }
    return c.json(
      await getRunContext(c.env.DB, device(c), {
        jobId: c.req.param("id"),
        runId,
        executionGeneration,
      }),
    );
  });
  app.post("/v1/executor/observations", async (c) => {
    const parsed = parse(RunObservation, await c.req.json().catch(() => null));
    if (!parsed.ok) throw new HttpError("INVALID_INPUT", parsed.issues.join("; "));
    const { status, body } = await recordObservation(c.env.DB, device(c), parsed.value);
    return c.json(body, status);
  });

  // Transcript upload (§3.3): init → PUT raw part → complete.
  app.post("/v1/executor/uploads/init", async (c) => {
    const parsed = parse(UploadInit, await c.req.json().catch(() => null));
    if (!parsed.ok) throw new HttpError("INVALID_INPUT", parsed.issues.join("; "));
    return c.json(await initUpload(c.env.DB, uploader(c), parsed.value));
  });
  app.post("/v1/executor/uploads/complete", async (c) => {
    const parsed = parse(UploadComplete, await c.req.json().catch(() => null));
    if (!parsed.ok) throw new HttpError("INVALID_INPUT", parsed.issues.join("; "));
    const { workspaceId, body } = await completeUpload(c.env.DB, uploader(c), parsed.value);
    hint(c, { workspaceId, scopes: [`workspace:${workspaceId}`] });
    return c.json(body);
  });
  // Native session snapshot (§13.3) for a resume, from any device of the Workspace; 404 when none is complete.
  app.get("/v1/executor/sessions/:provider/:sessionId", async (c) => {
    const parsed = parse(SessionStreamKey, {
      sessionId: c.req.param("sessionId"),
      subpath: c.req.query("subpath"),
    });
    if (!parsed.ok) throw new HttpError("INVALID_INPUT", parsed.issues.join("; "));
    return c.body(
      await sessionSnapshot(c.env.DB, c.env.R2, device(c), c.req.param("provider"), parsed.value),
      200,
      { "Content-Type": "application/x-ndjson; charset=utf-8" },
    );
  });
  app.put("/v1/executor/uploads/:uploadId", async (c) => {
    const principal = uploader(c);
    if (Number(c.req.header("Content-Length") ?? 0) > maxTranscriptPartBytes) throw tooLarge();
    const body = await c.req.arrayBuffer();
    if (body.byteLength > maxTranscriptPartBytes) throw tooLarge();
    return c.json(await putPart(c.env.DB, c.env.R2, principal, c.req.param("uploadId"), body));
  });

  // In-run hive tools (§18.2): the capability's Run acts as its Bot.
  app.post("/v1/run/commands", async (c) => {
    const run = runPrincipal(c);
    const parsed = parse(RunEnvelope, await c.req.json().catch(() => null));
    if (!parsed.ok) throw new HttpError("INVALID_INPUT", parsed.issues.join("; "));
    c.set("operationId", parsed.value.operationId);
    const result = await runRunCommand(c.env.DB, run, parsed.value);
    hint(c, { workspaceId: run.workspaceId, scopes: result.scopes ?? [] });
    const approvalId =
      result.response &&
      typeof result.response === "object" &&
      "approvalId" in result.response &&
      typeof result.response.approvalId === "string"
        ? result.response.approvalId
        : null;
    if (result.scopes?.length && approvalId) {
      const recipients = await approvalRecipients(c.env.DB, run.workspaceId);
      c.executionCtx.waitUntil(
        sendMobilePush(
          c.env.DB,
          c.env,
          { recipients, kind: "approval", id: approvalId },
          fetchImpl,
        ),
      );
    }
    return c.json(result.response, result.status as ContentfulStatusCode);
  });
  app.get("/v1/run/me", (c) => {
    const run = runPrincipal(c);
    const me: RunPrincipal = {
      kind: "run",
      runId: run.runId,
      jobId: run.jobId,
      botId: run.botId,
      workspaceId: run.workspaceId,
      executionGeneration: run.executionGeneration,
      conversationId: run.conversationId,
      taskId: run.taskId,
      hop: run.hop,
      correlationId: run.correlationId,
      scopes: run.scopes,
    };
    return c.json(me);
  });
  app.get("/v1/run/attachments/:id", async (c) => {
    const { row, object } = await readRunAttachment(
      c.env.DB,
      c.env.R2,
      runPrincipal(c),
      c.req.param("id"),
    );
    return c.body(object.body, 200, {
      "Content-Type": row.contentType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    });
  });
  app.get("/v1/run/approvals/:id", async (c) =>
    c.json(await getRunApproval(c.env.DB, runPrincipal(c), c.req.param("id"))),
  );
  app.get("/v1/run/effects/:id", async (c) =>
    c.json(await getRunEffect(c.env.DB, runPrincipal(c).runId, c.req.param("id"))),
  );
  app.get("/v1/run/tasks/:id", async (c) => {
    const run = runPrincipal(c);
    if (!run.scopes.includes("task.read"))
      throw new HttpError("FORBIDDEN", "capability lacks task.read");
    const task = await getTask(c.env.DB, [run.workspaceId], c.req.param("id"));
    if (!run.taskProjectId || task.projectId !== run.taskProjectId) {
      throw new HttpError("FORBIDDEN", "a run may only read tasks of its own task's project");
    }
    return c.json(task);
  });

  app.get("/v1/run/search", async (c) => {
    const run = runPrincipal(c);
    if (!run.scopes.includes("search.read"))
      throw new HttpError("FORBIDDEN", "capability lacks search.read");
    return c.json(
      await search(c.env.DB, await searchAccess(c.env.DB, run.workspaceId, run), {
        q: c.req.query("q"),
        kinds: c.req.query("kinds"),
        limit: limitParam(c, 10, 50),
      }),
    );
  });

  // Search and Memory (§13.6, §14).
  app.get("/v1/search", async (c) => {
    const workspaceId = workspaceParam(c);
    return c.json(
      await search(c.env.DB, await searchAccess(c.env.DB, workspaceId, user(c)), {
        q: c.req.query("q"),
        kinds: c.req.query("kinds"),
        limit: limitParam(c, 20, 100),
        cursor: c.req.query("cursor"),
      }),
    );
  });
  app.get("/v1/memories", async (c) => {
    const workspaceId = workspaceParam(c);
    return c.json(
      await listMemories(c.env.DB, await searchAccess(c.env.DB, workspaceId, user(c)), {
        scopeKind: c.req.query("scopeKind"),
        scopeId: c.req.query("scopeId"),
      }),
    );
  });
  app.post("/v1/admin/search/rebuild", async (c) => {
    const workspaceId = workspaceParam(c);
    const owner = await c.env.DB.prepare(
      "SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role = 'owner'",
    )
      .bind(workspaceId, user(c).userId)
      .first();
    if (!owner) throw new HttpError("FORBIDDEN", "workspace owner required");
    return c.json(await rebuildSearch(c.env.DB, workspaceId));
  });

  app.get("/v1/operations/:id", async (c) => {
    const { userId, workspaceIds } = user(c);
    return c.json(await getOperation(c.env.DB, userId, workspaceIds, c.req.param("id")));
  });
  app.get("/v1/jobs/:id", async (c) =>
    c.json(await getJob(c.env.DB, user(c).workspaceIds, c.req.param("id"))),
  );
  app.get("/v1/runs/:id", async (c) => c.json(await getRun(c.env.DB, user(c), c.req.param("id"))));
  app.get("/v1/runs/:id/transcript", async (c) =>
    c.json(
      await getTranscript(c.env.DB, c.env.R2, user(c), c.req.param("id"), c.req.query("cursor")),
    ),
  );
  app.get("/v1/transcripts/:runId/raw", async (c) =>
    c.body(await rawTranscript(c.env.DB, c.env.R2, user(c), c.req.param("runId")), 200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
    }),
  );
  app.get("/v1/inbox", async (c) => {
    const botId = c.req.query("botId");
    if (!botId) throw new HttpError("INVALID_INPUT", "botId is required");
    return c.json(await listInbox(c.env.DB, user(c).workspaceIds, botId));
  });

  app.get("/v1/channels", async (c) =>
    c.json(await listChannels(c.env.DB, workspaceParam(c), user(c).userId)),
  );
  app.get("/v1/channels/:id/presence", async (c) =>
    c.json(
      await channelPresence(c.env.DB, {
        workspaceId: workspaceParam(c),
        userId: user(c).userId,
        channelId: c.req.param("id"),
      }),
    ),
  );
  app.get("/v1/users", async (c) => c.json(await listUsers(c.env.DB, workspaceParam(c))));
  app.get("/v1/channels/:id/members", async (c) =>
    c.json(
      await listChannelMembers(c.env.DB, {
        workspaceId: workspaceParam(c),
        userId: user(c).userId,
        channelId: c.req.param("id"),
      }),
    ),
  );
  app.get("/v1/channels/:id/messages", async (c) =>
    c.json(
      await listMessages(c.env.DB, {
        workspaceId: workspaceParam(c),
        userId: user(c).userId,
        channelId: c.req.param("id"),
        limit: limitParam(c, 50, 200),
      }),
    ),
  );
  app.get("/v1/dms", async (c) =>
    c.json(await listDms(c.env.DB, workspaceParam(c), user(c).userId)),
  );
  app.get("/v1/conversations/:id/messages", async (c) =>
    c.json(
      await listMessages(c.env.DB, {
        workspaceId: workspaceParam(c),
        userId: user(c).userId,
        conversationId: c.req.param("id"),
        limit: limitParam(c, 50, 200),
      }),
    ),
  );
  app.get("/v1/threads", async (c) => {
    if (c.req.query("participant") !== "me") {
      throw new HttpError("INVALID_INPUT", "participant=me is required");
    }
    return c.json(await listThreads(c.env.DB, workspaceParam(c), user(c).userId));
  });
  app.get("/v1/sidebar", async (c) =>
    c.json(await getSidebar(c.env.DB, workspaceParam(c), user(c).userId)),
  );
  app.get("/v1/bots", async (c) =>
    c.json(await listBots(c.env.DB, workspaceParam(c), user(c).userId)),
  );
  app.get("/v1/bot-conversations", async (c) =>
    c.json(await listBotConversations(c.env.DB, workspaceParam(c))),
  );
  app.get("/v1/devices", async (c) => c.json(await listDevices(c.env.DB, workspaceParam(c))));
  app.get("/v1/jobs", async (c) =>
    c.json(
      await listJobs(c.env.DB, workspaceParam(c), limitParam(c, 50, 200), c.req.query("state")),
    ),
  );

  app.get("/v1/runs", async (c) => {
    const kind = c.req.query("kind");
    if (kind !== undefined && kind !== "job" && kind !== "native_child" && kind !== "external") {
      throw new HttpError("INVALID_INPUT", "kind must be job, native_child, or external");
    }
    return c.json(
      await listRuns(
        c.env.DB,
        user(c),
        workspaceParam(c),
        kind as "job" | "native_child" | "external" | undefined,
      ),
    );
  });

  app.get("/v1/projects", async (c) => c.json(await listProjects(c.env.DB, workspaceParam(c))));
  app.get("/v1/tasks", async (c) =>
    c.json(
      await listTasks(c.env.DB, workspaceParam(c), {
        projectKey: c.req.query("projectKey"),
        status: c.req.query("status"),
      }),
    ),
  );
  app.get("/v1/tasks/:id", async (c) =>
    c.json(await getTask(c.env.DB, user(c).workspaceIds, c.req.param("id"), user(c).userId)),
  );

  app.get("/v1/approvals", async (c) =>
    c.json(await listApprovals(c.env.DB, workspaceParam(c), c.req.query("state"))),
  );
  app.get("/v1/effects", async (c) =>
    c.json(
      await listEffects(c.env.DB, workspaceParam(c), {
        state: c.req.query("state"),
        runId: c.req.query("runId"),
      }),
    ),
  );
  app.get("/v1/audit", async (c) =>
    c.json(
      await listAudit(c.env.DB, {
        workspaceId: workspaceParam(c),
        userId: user(c).userId,
        cursor: c.req.query("cursor"),
        kinds: c.req.query("kinds"),
        actor: c.req.query("actor"),
        since: c.req.query("since"),
        limit: limitParam(c, 50, 200),
      }),
    ),
  );
  app.get("/v1/status", async (c) =>
    c.json(
      await getStatus(c.env.DB, {
        workspaceId: workspaceParam(c),
        userId: user(c).userId,
      }),
    ),
  );

  app.get("/v1/routines", async (c) =>
    c.json(
      await listRoutines(
        c.env.DB,
        workspaceParam(c),
        c.req.query("botId"),
        c.req.query("conversationId"),
      ),
    ),
  );
  app.get("/v1/subscriptions", async (c) =>
    c.json(await listSubscriptions(c.env.DB, workspaceParam(c))),
  );

  app.get("/v1/sync/changes", async (c) =>
    c.json(
      await listChanges(c.env.DB, {
        workspaceId: workspaceParam(c),
        userId: user(c).userId,
        cursor: c.req.query("cursor"),
        limit: limitParam(c, 100, 500),
      }),
    ),
  );

  // Authenticated here; the DO trusts the principal header set below (never a client header).
  app.get("/v1/realtime", async (c) => {
    const workspaceId = workspaceParam(c);
    if (c.req.header("Upgrade") !== "websocket") {
      throw new HttpError("INVALID_INPUT", "WebSocket upgrade required");
    }
    const principal = c.get("principal");
    const attachment: Attachment =
      principal.kind === "user"
        ? {
            principalKind: "user",
            principalId: principal.userId,
            scopes: await permittedScopes(c.env.DB, workspaceId, principal),
          }
        : {
            principalKind: "device",
            principalId: device(c).deviceId,
            scopes: [`workspace:${workspaceId}`],
          };
    const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(workspaceId));
    return stub.fetch("https://realtime/connect", {
      headers: { Upgrade: "websocket", [principalHeader]: JSON.stringify(attachment) },
    });
  });

  return app;
};
