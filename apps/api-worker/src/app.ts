import { parse } from "@hive/contracts";
import { Hono } from "hono";
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
  heartbeat,
  listQueuedJobs,
  runExecutorCommand,
} from "./executor.ts";
import { pump } from "./pump.ts";
import { getJob, getOperation, listInbox } from "./queries.ts";

export type Bindings = { DB: D1Database; ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string };
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

  // Executor routes take device tokens; every other /v1 route takes a user's Access assertion.
  app.use("/v1/*", async (c, next) => {
    c.set(
      "principal",
      c.req.path.startsWith("/v1/executor/")
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
    const { status, response } = await runCommand(c.env.DB, c.get("principal"), parsed.value);
    return c.json(response, status as ContentfulStatusCode);
  });

  app.post("/v1/executor/pump", async (c) =>
    c.json(await pump(c.env.DB, { owner: `device:${device(c).deviceId}`, limit: 50 })),
  );

  app.post("/v1/executor/commands", async (c) => {
    const parsed = parse(ExecutorEnvelope, await c.req.json().catch(() => null));
    if (!parsed.ok) throw new HttpError("INVALID_INPUT", parsed.issues.join("; "));
    c.set("operationId", parsed.value.operationId);
    const { status, response } = await runExecutorCommand(c.env.DB, device(c), parsed.value);
    return c.json(response, status as ContentfulStatusCode);
  });
  app.post("/v1/executor/heartbeat", async (c) => c.json(await heartbeat(c.env.DB, device(c))));
  app.get("/v1/executor/jobs", async (c) => {
    if (c.req.query("state") !== "queued")
      throw new HttpError("INVALID_INPUT", "state=queued is required");
    const limit = Number(c.req.query("limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HttpError("INVALID_INPUT", "limit must be an integer in 1..100");
    }
    return c.json(await listQueuedJobs(c.env.DB, device(c), limit));
  });
  app.get("/v1/executor/runs/:id", async (c) =>
    c.json(await getExecutorRun(c.env.DB, device(c), c.req.param("id"))),
  );

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

  return app;
};
