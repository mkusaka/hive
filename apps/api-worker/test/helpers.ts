import { env } from "cloudflare:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect } from "vitest";
import { createApp } from "../src/app.ts";

const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1" }] });
export const app = createApp({ jwks: () => jwks });
export const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;

export const assertion = (sub: string, overrides: { audience?: string; issuer?: string } = {}) =>
  new SignJWT({ email: `${sub}@example.test` })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setSubject(sub)
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? env.ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

export const call = async (path: string, headers: Record<string, string>, body?: unknown) =>
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
export const login = async () => {
  const header = { "Cf-Access-Jwt-Assertion": await assertion(crypto.randomUUID()) };
  return {
    me: () => call("/v1/me", header),
    get: (path: string) => call(path, header),
    command: (body: unknown) => call("/v1/commands", header, body),
  };
};

export const envelope = (
  workspaceId: string,
  command: unknown,
  idempotencyKey = crypto.randomUUID(),
) => ({
  operationId: crypto.randomUUID(),
  idempotencyKey,
  workspaceId,
  command,
});
export const register = {
  type: "device.register",
  name: "pc1",
  os: "darwin",
  agentVersion: "0.0.0",
};

export const withWorkspace = async () => {
  const user = await login();
  const workspaceId = crypto.randomUUID();
  const created = await user.command(
    envelope(workspaceId, { type: "workspace.create", name: "ws" }),
  );
  expect(created.status).toBe(200);
  return { user, workspaceId };
};

export const executorMe = (token: string) =>
  call("/v1/executor/me", { Authorization: `Bearer ${token}` });
