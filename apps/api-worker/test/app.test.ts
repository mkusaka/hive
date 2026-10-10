import { env } from "cloudflare:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";

const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1" }] });
const app = createApp({ jwks: () => jwks });
const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;

const assertion = (sub: string, overrides: { audience?: string; issuer?: string } = {}) =>
  new SignJWT({ email: `${sub}@example.test` })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setSubject(sub)
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? env.ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

const call = async (path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    path,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );

// A fresh user per test so tests do not depend on storage isolation.
const login = async () => {
  const header = { "Cf-Access-Jwt-Assertion": await assertion(crypto.randomUUID()) };
  return {
    me: () => call("/v1/me", header),
    command: (body: unknown) => call("/v1/commands", header, body),
  };
};

const envelope = (workspaceId: string, command: unknown, idempotencyKey = crypto.randomUUID()) => ({
  operationId: crypto.randomUUID(),
  idempotencyKey,
  workspaceId,
  command,
});
const register = { type: "device.register", name: "pc1", os: "darwin", agentVersion: "0.0.0" };

const withWorkspace = async () => {
  const user = await login();
  const workspaceId = crypto.randomUUID();
  const created = await user.command(
    envelope(workspaceId, { type: "workspace.create", name: "ws" }),
  );
  expect(created.status).toBe(200);
  return { user, workspaceId };
};

const executorMe = (token: string) => call("/v1/executor/me", { Authorization: `Bearer ${token}` });

describe("user auth", () => {
  it("rejects a missing or invalid assertion with 401", async () => {
    const missing = await call("/v1/me", {});
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ code: "UNAUTHENTICATED", retryable: false });
    expect(missing.headers.get("X-Request-Id")).toBeTruthy();

    const bad = [
      "not-a-jwt",
      await assertion("u", { audience: "other" }),
      await assertion("u", { issuer: "https://evil.example" }),
    ];
    const statuses = await Promise.all(
      bad.map(async (a) => (await call("/v1/me", { "Cf-Access-Jwt-Assertion": a })).status),
    );
    expect(statuses).toEqual([401, 401, 401]);
  });

  it("creates the user on first login and returns the principal", async () => {
    const sub = crypto.randomUUID();
    const header = { "Cf-Access-Jwt-Assertion": await assertion(sub), "cf-ray": "ray-1" };
    const first = await call("/v1/me", header);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Request-Id")).toBe("ray-1");
    const principal = await first.json<{ kind: string; userId: string }>();
    expect(principal).toMatchObject({ kind: "user", workspaceIds: [] });

    const row = await env.DB.prepare(
      "SELECT id, email FROM users WHERE access_issuer = ? AND access_subject = ?",
    )
      .bind(issuer, sub)
      .first();
    expect(row).toEqual({ id: principal.userId, email: `${sub}@example.test` });
    expect(await (await call("/v1/me", header)).json()).toEqual(principal);
  });

  it("serves /healthz without auth", async () => {
    expect((await call("/healthz", {})).status).toBe(200);
  });
});

describe("commands", () => {
  it("registers a device; a replay returns the same device without the token", async () => {
    const { user, workspaceId } = await withWorkspace();
    expect(await (await user.me()).json()).toMatchObject({ workspaceIds: [workspaceId] });

    const request = envelope(workspaceId, register);
    const first = await user.command(request);
    expect(first.status).toBe(200);
    const body = await first.json<{ deviceId: string; deviceToken: string }>();
    expect(body).toMatchObject({ operationId: request.operationId, status: "accepted" });
    expect(body.deviceToken).toBe(`${body.deviceId}.${body.deviceToken.split(".")[1]}`);

    const replay = await user.command(request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...body, deviceToken: null });

    const conflict = await user.command({ ...request, command: { ...register, name: "pc2" } });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      operationId: request.operationId,
    });
  });

  it("rejects invalid envelopes and unknown command types with 422", async () => {
    const { user, workspaceId } = await withWorkspace();
    const bodies = [
      envelope(workspaceId, { type: "bot.explode" }),
      envelope(workspaceId, { ...register, name: "" }),
      { command: register },
    ];
    const results = await Promise.all(
      bodies.map(async (body) => {
        const res = await user.command(body);
        return [res.status, (await res.json<{ code: string }>()).code];
      }),
    );
    expect(results).toEqual(bodies.map(() => [422, "INVALID_INPUT"]));
  });

  it("forbids commands for a workspace the user is not a member of", async () => {
    const { workspaceId } = await withWorkspace();
    const stranger = await login();
    const res = await stranger.command(envelope(workspaceId, register));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FORBIDDEN" });
    // Nor can a stranger claim an existing Workspace through the bootstrap path.
    const create = await stranger.command(
      envelope(workspaceId, { type: "workspace.create", name: "x" }),
    );
    expect(create.status).toBe(403);
  });
});

describe("device auth", () => {
  it("authenticates a device token until it is revoked", async () => {
    const { user, workspaceId } = await withWorkspace();
    const { deviceId, deviceToken } = await (
      await user.command(envelope(workspaceId, register))
    ).json<{ deviceId: string; deviceToken: string }>();
    const userId = (await (await user.me()).json<{ userId: string }>()).userId;

    const ok = await executorMe(deviceToken);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      kind: "device",
      deviceId,
      ownerUserId: userId,
      workspaceIds: [workspaceId],
    });

    const bad = [`${deviceId}.${"0".repeat(64)}`, deviceId, "", `x.${deviceToken}`];
    const statuses = await Promise.all(bad.map(async (t) => (await executorMe(t)).status));
    expect(statuses).toEqual([401, 401, 401, 401]);
    // A user's Access assertion does not open executor routes.
    expect((await call("/v1/executor/me", {})).status).toBe(401);

    const revoke = await user.command(envelope(workspaceId, { type: "device.revoke", deviceId }));
    expect(revoke.status).toBe(200);
    expect((await executorMe(deviceToken)).status).toBe(401);
  });
});
