import { parse, RunObservation } from "@hive/contracts";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { JWTVerifyGetKey } from "jose";
import { authenticateUser, remoteJwks } from "./auth/access.ts";
import { authenticateDevice } from "./auth/device.ts";
import type { Principal } from "./auth/principal.ts";
import { CommandEnvelope, runCommand } from "./commands.ts";
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
} from "./executor.ts";
import { pump } from "./pump.ts";
import {
  getJob,
  getOperation,
  getTask,
  listBots,
  listChannels,
  listDevices,
  listInbox,
  listJobs,
  listMessages,
  listProjects,
  listRoutines,
  listSubscriptions,
  listTasks,
} from "./queries.ts";
import {
  type Attachment,
  type Notification,
  notify,
  principalHeader,
  type Realtime,
} from "./realtime.ts";
import { listChanges, permittedScopes } from "./sync.ts";

export type Bindings = {
  DB: D1Database;
  REALTIME: DurableObjectNamespace<Realtime>;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /** Local dev only: a JSON Web Key Set used instead of the Access certs (`.dev.vars`). */
  ACCESS_DEV_JWKS?: string;
};
export type AppEnv = {
  Bindings: Bindings;
  Variables: { requestId: string; operationId?: string; principal: Principal };
};

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

/** `jwks` is injectable so tests can sign Access assertions with a local key. */
export const createApp = ({
  jwks = remoteJwks,
}: { jwks?: (env: Bindings) => JWTVerifyGetKey } = {}) => {
  const app = new Hono<AppEnv>();

  app.use(async (c, next) => {
    c.set("requestId", c.req.header("cf-ray") ?? crypto.randomUUID());
    await next();
    c.header("X-Request-Id", c.get("requestId"));
  });
  app.onError(toErrorResponse);
  app.notFound((c) => toErrorResponse(new HttpError("NOT_FOUND", "route not found"), c));

  app.get("/healthz", (c) => c.json({ ok: true }));

  // Executor routes take device tokens; every other /v1 route takes a user's Access assertion, except
  // `/v1/realtime`, which takes a device token when a Bearer token is presented.
  app.use("/v1/*", async (c, next) => {
    const deviceAuth =
      c.req.path.startsWith("/v1/executor/") ||
      (c.req.path === "/v1/realtime" && c.req.header("Authorization")?.startsWith("Bearer "));
    c.set(
      "principal",
      deviceAuth
        ? await authenticateDevice(c.req.raw, c.env)
        : await authenticateUser(c.req.raw, c.env, jwks(c.env)),
    );
    await next();
  });

  app.get("/v1/me", (c) => c.json(c.get("principal")));
  app.get("/v1/executor/me", (c) => c.json(c.get("principal")));

  app.post("/v1/commands", async (c) => {
    const parsed = parse(CommandEnvelope, await c.req.json().catch(() => null));
    if (!parsed.ok) throw new HttpError("INVALID_INPUT", parsed.issues.join("; "));
    c.set("operationId", parsed.value.operationId);
    const { status, response, scopes } = await runCommand(
      c.env.DB,
      c.get("principal"),
      parsed.value,
    );
    hint(c, { workspaceId: parsed.value.workspaceId, scopes: scopes ?? [] });
    return c.json(response, status as ContentfulStatusCode);
  });

  app.post("/v1/executor/pump", async (c) =>
    c.json(
      await pump(c.env.DB, {
        owner: `device:${device(c).deviceId}`,
        limit: 50,
        notify: (n) => hint(c, n),
      }),
    ),
  );

  app.post("/v1/executor/commands", async (c) => {
    const parsed = parse(ExecutorEnvelope, await c.req.json().catch(() => null));
    if (!parsed.ok) throw new HttpError("INVALID_INPUT", parsed.issues.join("; "));
    c.set("operationId", parsed.value.operationId);
    const { status, response, scopes } = await runExecutorCommand(
      c.env.DB,
      device(c),
      parsed.value,
    );
    hint(c, { workspaceId: parsed.value.workspaceId, scopes: scopes ?? [] });
    return c.json(response, status as ContentfulStatusCode);
  });
  app.post("/v1/executor/heartbeat", async (c) => c.json(await heartbeat(c.env.DB, device(c))));
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

  app.get("/v1/operations/:id", async (c) => {
    const { userId, workspaceIds } = user(c);
    return c.json(await getOperation(c.env.DB, userId, workspaceIds, c.req.param("id")));
  });
  app.get("/v1/jobs/:id", async (c) =>
    c.json(await getJob(c.env.DB, user(c).workspaceIds, c.req.param("id"))),
  );
  app.get("/v1/inbox", async (c) => {
    const botId = c.req.query("botId");
    if (!botId) throw new HttpError("INVALID_INPUT", "botId is required");
    return c.json(await listInbox(c.env.DB, user(c).workspaceIds, botId));
  });

  app.get("/v1/channels", async (c) =>
    c.json(await listChannels(c.env.DB, workspaceParam(c), user(c).userId)),
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
  app.get("/v1/bots", async (c) => c.json(await listBots(c.env.DB, workspaceParam(c))));
  app.get("/v1/devices", async (c) => c.json(await listDevices(c.env.DB, workspaceParam(c))));
  app.get("/v1/jobs", async (c) =>
    c.json(
      await listJobs(c.env.DB, workspaceParam(c), limitParam(c, 50, 200), c.req.query("state")),
    ),
  );

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
    c.json(await getTask(c.env.DB, user(c).workspaceIds, c.req.param("id"))),
  );

  app.get("/v1/routines", async (c) => c.json(await listRoutines(c.env.DB, workspaceParam(c))));
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
            scopes: await permittedScopes(c.env.DB, workspaceId, principal.userId),
          }
        : {
            principalKind: "device",
            principalId: principal.deviceId,
            scopes: [`workspace:${workspaceId}`],
          };
    const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(workspaceId));
    return stub.fetch("https://realtime/connect", {
      headers: { Upgrade: "websocket", [principalHeader]: JSON.stringify(attachment) },
    });
  });

  return app;
};
