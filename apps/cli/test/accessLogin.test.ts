// Managed OAuth against a fake Access: discovery, registration and the token endpoint are stubbed `fetch`
// responses; the loopback callback is a real local server. No real network.
import * as oauth from "oauth4webapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accessTokens, login, type OAuthToken } from "../src/accessLogin.ts";

const API = "https://hive.test";
const ISSUER = "https://team.cloudflareaccess.com";

afterEach(() => void vi.unstubAllGlobals());

/** `refreshError(refreshToken)`: the OAuth error for that refresh grant, if any; it may also act as the other client. */
const fakeAccess = (refreshError?: string | ((refreshToken: string) => string | undefined)) => {
  const tokenRequests: URLSearchParams[] = [];
  let authorizationUrl: URL | undefined;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // oauth4webapi sends URLSearchParams for form bodies.
    const body = init?.body instanceof URLSearchParams ? init.body : String(init?.body ?? "");
    if (url === `${API}/`) {
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${API}/.well-known/oauth-protected-resource"`,
        },
      });
    }
    if (url.endsWith("/.well-known/oauth-protected-resource"))
      return Response.json({ resource: `${API}/`, authorization_servers: [ISSUER] });
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/cdn-cgi/access/oauth/authorization`,
        token_endpoint: `${ISSUER}/cdn-cgi/access/oauth/token`,
        registration_endpoint: `${ISSUER}/cdn-cgi/access/oauth/registration`,
      });
    }
    if (url.endsWith("/oauth/registration")) {
      const { redirect_uris } = JSON.parse(String(body)) as { redirect_uris: string[] };
      return Response.json(
        { client_id: "client-1", redirect_uris, token_endpoint_auth_method: "none" },
        { status: 201 },
      );
    }
    if (url.endsWith("/oauth/token")) {
      const params = new URLSearchParams(body);
      tokenRequests.push(params);
      const grant = params.get("grant_type");
      if (grant === "authorization_code") {
        // Access rejects a verifier that does not match the challenge of the authorization request.
        const verifier = params.get("code_verifier") ?? "";
        if (
          (await oauth.calculatePKCECodeChallenge(verifier)) !==
          authorizationUrl?.searchParams.get("code_challenge")
        )
          return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      const error =
        typeof refreshError === "function"
          ? refreshError(params.get("refresh_token") ?? "")
          : refreshError;
      if (grant === "refresh_token" && error) return Response.json({ error }, { status: 400 });
      return Response.json({
        access_token: grant === "refresh_token" ? "refreshed" : "initial",
        refresh_token: grant === "refresh_token" ? "rt-2" : "rt-1",
        token_type: "Bearer",
        expires_in: 900,
      });
    }
    return realFetch(input, init);
  });
  // The browser: follows the authorization URL straight to the loopback redirect with a code.
  const openBrowser = async (url: string) => {
    authorizationUrl = new URL(url);
    const redirect = authorizationUrl.searchParams.get("redirect_uri");
    const state = authorizationUrl.searchParams.get("state");
    await realFetch(`${redirect}?code=code-1&state=${state}`);
  };
  return { tokenRequests, openBrowser, authorizationUrl: () => authorizationUrl };
};

const grant = (expiresAt: number): OAuthToken => ({
  authorizationServer: ISSUER,
  clientId: "client-1",
  accessToken: "stored",
  refreshToken: "rt-0",
  expiresAt,
});

/** `file` stands in for the shared credentials file that the CLI and Electron both read and write. */
const tokens = (stored: OAuthToken | undefined, openBrowser?: (url: string) => Promise<void>) => {
  const file = { oauth: stored };
  const saved: OAuthToken[] = [];
  const get = accessTokens({
    apiUrl: API,
    load: async () => file.oauth,
    save: async (t) => {
      saved.push(t);
      file.oauth = t;
    },
    openBrowser,
  });
  return { get, saved, file };
};

describe("Access managed OAuth", () => {
  it("logs in with DCR on a loopback redirect and a matching PKCE pair", async () => {
    const access = fakeAccess();
    expect(await login(API, access.openBrowser)).toMatchObject({
      accessToken: "initial",
      clientId: "client-1",
      refreshToken: "rt-1",
    });
    const url = access.authorizationUrl()!;
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(`${API}/`);
    expect(url.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const exchange = access.tokenRequests[0]!;
    expect(exchange.get("code")).toBe("code-1");
    expect(await oauth.calculatePKCECodeChallenge(exchange.get("code_verifier")!)).toBe(
      url.searchParams.get("code_challenge"),
    );
  });

  it("reuses a fresh token and refreshes one within 30 s of expiry without a browser", async () => {
    const access = fakeAccess();
    expect(await tokens(grant(Date.now() + 600_000)).get()).toBe("stored");
    expect(access.tokenRequests).toEqual([]);

    const t = tokens(grant(Date.now() + 10_000));
    expect(await Promise.all([t.get(), t.get()])).toEqual(["refreshed", "refreshed"]);
    expect(access.tokenRequests.map((p) => p.get("refresh_token"))).toEqual(["rt-0"]);
    expect(t.saved).toMatchObject([{ accessToken: "refreshed", refreshToken: "rt-2" }]);
    expect(access.authorizationUrl()).toBeUndefined();
  });

  it("logs in again only on invalid_grant, and only with a browser", async () => {
    const access = fakeAccess("invalid_grant");
    expect(await tokens(grant(0), access.openBrowser).get()).toBe("initial");

    await expect(tokens(grant(0)).get()).rejects.toThrow(
      "Access session expired: run `hive login`",
    );
    await expect(tokens(undefined).get()).rejects.toThrow("not logged in: run `hive login`");
  });

  it("uses the grant another client refreshed meanwhile instead of logging in", async () => {
    const t = tokens(grant(0), async () => {
      throw new Error("must not open the browser");
    });
    // Electron refreshes first: rt-0 is rotated to rt-9 and written to the shared file while our refresh is in flight.
    const access = fakeAccess((refreshToken) => {
      if (refreshToken !== "rt-0") return undefined;
      t.file.oauth = { ...grant(0), refreshToken: "rt-9" };
      return "invalid_grant";
    });
    expect(await t.get()).toBe("refreshed");
    expect(access.tokenRequests.map((p) => p.get("refresh_token"))).toEqual(["rt-0", "rt-9"]);
    expect(t.file.oauth).toMatchObject({ accessToken: "refreshed", refreshToken: "rt-2" });

    // A token the other client already refreshed is used as-is, without another refresh.
    const u = tokens(grant(0));
    fakeAccess(() => {
      u.file.oauth = { ...grant(Date.now() + 600_000), accessToken: "theirs" };
      return "invalid_grant";
    });
    expect(await u.get()).toBe("theirs");
    expect(u.saved).toEqual([]);
  });

  it("passes other refresh errors through instead of opening the browser", async () => {
    const access = fakeAccess("temporarily_unavailable");
    await expect(tokens(grant(0), access.openBrowser).get()).rejects.toThrow();
    expect(access.authorizationUrl()).toBeUndefined();
  });
});
