import { parse } from "@hive/contracts";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { JWTVerifyGetKey } from "jose";
import { authenticateUser, remoteJwks } from "./auth/access.ts";
import { authenticateDevice } from "./auth/device.ts";
import type { Principal } from "./auth/principal.ts";
import { CommandEnvelope, runCommand } from "./commands.ts";
import { HttpError, toErrorResponse } from "./errors.ts";

export type Bindings = { DB: D1Database; ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string };
export type AppEnv = {
  Bindings: Bindings;
  Variables: { requestId: string; operationId?: string; principal: Principal };
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

  return app;
};
