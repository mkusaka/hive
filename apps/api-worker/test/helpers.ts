import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect } from "vitest";
import { createApp } from "../src/app.ts";

const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
export const localJwks = createLocalJWKSet({
  keys: [{ ...(await exportJWK(publicKey)), kid: "k1" }],
});
export const app = createApp({ jwks: () => localJwks });
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

/** `app.request` with an ExecutionContext; waits for `waitUntil` work (realtime hints) before returning. */
export const request = async (input: string | URL, init: RequestInit) => {
  const ctx = createExecutionContext();
  const res = await app.request(input, init, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
};

export const call = (path: string, headers: Record<string, string>, body?: unknown) =>
  request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// A fresh user per test so tests do not depend on storage isolation.
export const login = async () => {
  const header = { "Cf-Access-Jwt-Assertion": await assertion(crypto.randomUUID()) };
  return {
    headers: header,
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

export type Json = Record<string, unknown>;

// Workspace + device + channel + bot, all fresh per test.
export const setup = async () => {
  const { user, workspaceId } = await withWorkspace();
  const ok = async (command: unknown) => {
    const res = await user.command(envelope(workspaceId, command));
    expect(res.status).toBe(200);
    return res.json<Json>();
  };
  const { deviceId, deviceToken } = await ok(register);
  const { channelId } = await ok({ type: "channel.create", name: "dev" });
  const { botId } = await ok({ type: "bot.create", name: "coder" });
  const pump = async () => {
    const res = await call("/v1/executor/pump", { Authorization: `Bearer ${deviceToken}` }, {});
    expect(res.status).toBe(200);
    return res.json<{ processed: number; dead: number; approvalsExpired: number }>();
  };
  const send = (delivery = "wake", idempotencyKey?: string) =>
    envelope(
      workspaceId,
      {
        type: "agent.send",
        recipientBotId: botId,
        channelId,
        message: { kind: "request", text: "check PR #123" },
        delivery,
      },
      idempotencyKey,
    );
  return {
    user,
    workspaceId,
    deviceId: deviceId as string,
    deviceToken: deviceToken as string,
    channelId: channelId as string,
    botId: botId as string,
    ok,
    pump,
    send,
  };
};

export const count = async (from: string, ...params: unknown[]) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${from}`)
    .bind(...params)
    .first<{ n: number }>())!.n;

export const executor = (token: string, workspaceId: string) => {
  const auth = { Authorization: `Bearer ${token}` };
  return {
    get: (path: string) => call(path, auth),
    post: (path: string, body: unknown) => call(path, auth, body),
    command: (command: unknown, idempotencyKey?: string) =>
      call("/v1/executor/commands", auth, envelope(workspaceId, command, idempotencyKey)),
  };
};

export type Claimed = { runId: string; executionGeneration: number; leaseExpiresAt: string };

/** agent.send → pump → a queued Job for `botId` (default: the setup Bot). */
export const queuedJob = async (s: Awaited<ReturnType<typeof setup>>, botId = s.botId) => {
  const sent = s.send();
  (sent.command as Json).recipientBotId = botId;
  const { inboxItemId } = await (await s.user.command(sent)).json<{ inboxItemId: string }>();
  await s.pump();
  const op = await (await s.user.get(`/v1/operations/${sent.operationId}`)).json<Json>();
  return { jobId: op.jobId as string, inboxItemId };
};

export const claim = (jobId: string, expectedRevision = 1) => ({
  type: "job.claim",
  jobId,
  expectedRevision,
});
