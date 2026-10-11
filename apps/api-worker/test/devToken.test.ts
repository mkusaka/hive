import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { devKeys, mintDevToken } from "../scripts/dev-token.ts";
import { createApp } from "../src/app.ts";

describe("ACCESS_DEV_JWKS", () => {
  it("verifies a dev-token.ts assertion with the default jwks; other keys are 401", async () => {
    const app = createApp();
    const keys = await devKeys();
    const devEnv = { ...env, ACCESS_DEV_JWKS: keys.jwks };
    const claims = {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      aud: env.ACCESS_AUD,
      email: "d@example.test",
    };
    const me = (jwt: string) =>
      app.request("/v1/me", { headers: { "Cf-Access-Jwt-Assertion": jwt } }, devEnv);

    const ok = await me(
      await mintDevToken(keys.privateJwk, { ...claims, sub: crypto.randomUUID() }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ kind: "user", workspaceIds: [] });

    const other = await devKeys();
    const forged = await mintDevToken(other.privateJwk, { ...claims, sub: "x" });
    expect((await me(forged)).status).toBe(401);
  });

  it("accepts a local Access JWT in Authorization for a realtime user socket", async () => {
    const app = createApp();
    const keys = await devKeys();
    const devEnv = { ...env, ACCESS_DEV_JWKS: keys.jwks };
    const token = await mintDevToken(keys.privateJwk, {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      aud: env.ACCESS_AUD,
      email: "mobile@example.test",
      sub: crypto.randomUUID(),
    });
    const headers = { Authorization: `Bearer ${token}` };
    const workspaceId = crypto.randomUUID();
    const ctx = createExecutionContext();
    expect((await app.request("/v1/me", { headers }, devEnv)).status).toBe(200);
    expect(
      (
        await app.request(
          "/v1/commands",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify({
              operationId: crypto.randomUUID(),
              idempotencyKey: crypto.randomUUID(),
              workspaceId,
              command: { type: "workspace.create", name: "mobile" },
            }),
          },
          devEnv,
          ctx,
        )
      ).status,
    ).toBe(200);
    await waitOnExecutionContext(ctx);
    const socket = await app.request(
      `/v1/realtime?workspaceId=${workspaceId}`,
      { headers: { ...headers, Upgrade: "websocket" } },
      devEnv,
    );
    expect(socket.status).toBe(101);
    socket.webSocket?.accept();
    socket.webSocket?.close();
  });
});
