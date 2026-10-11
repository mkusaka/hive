import * as oauth from "oauth4webapi";

export type OAuthToken = {
  authorizationServer: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

/** PKCE primitives for runtimes without Web Crypto, such as React Native Hermes. */
export type LoginCrypto = {
  verifier(): string;
  state(): string;
  challenge(verifier: string): Promise<string>;
};

const discover = async (issuer: string) => {
  const url = new URL(issuer);
  return oauth.processDiscoveryResponse(
    url,
    await oauth.discoveryRequest(url, { algorithm: "oauth2" }),
  );
};

const toStored = (
  server: oauth.AuthorizationServer,
  clientId: string,
  token: oauth.TokenEndpointResponse,
  previousRefreshToken?: string,
): OAuthToken => {
  const refreshToken = token.refresh_token ?? previousRefreshToken;
  if (!refreshToken) throw new Error("Access did not return a refresh token");
  return {
    authorizationServer: server.issuer,
    clientId,
    accessToken: token.access_token,
    refreshToken,
    expiresAt: Date.now() + (token.expires_in ?? 900) * 1000,
  };
};

export const refresh = async (stored: OAuthToken): Promise<OAuthToken> => {
  const server = await discover(stored.authorizationServer);
  const client: oauth.Client = { client_id: stored.clientId };
  const token = await oauth.processRefreshTokenResponse(
    server,
    client,
    await oauth.refreshTokenGrantRequest(server, client, oauth.None(), stored.refreshToken),
  );
  return toStored(server, client.client_id, token, stored.refreshToken);
};

export const isInvalidGrant = (error: unknown) =>
  error instanceof oauth.ResponseBodyError && error.error === "invalid_grant";

/**
 * Starts an Access Managed OAuth authorization-code flow. `complete` must receive the full redirect URL after the
 * system browser returns. Supply `crypto` on React Native Hermes when Web Crypto is unavailable.
 */
export const prepareLogin = async (
  apiUrl: string,
  redirectUri: string,
  crypto?: LoginCrypto,
): Promise<{ authorizationUrl: string; complete(callbackUrl: string): Promise<OAuthToken> }> => {
  const resource = new URL(apiUrl).href;
  const probe = await fetch(resource, {
    headers: { accept: "application/json" },
    redirect: "manual",
  });
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(
    probe.headers.get("www-authenticate") ?? "",
  )?.[1];
  if (!metadataUrl) throw new Error(`Access Managed OAuth is not enabled for ${resource}`);
  const metadata = await fetch(metadataUrl);
  if (!metadata.ok) throw new Error(`resource metadata fetch failed: HTTP ${metadata.status}`);
  const document: unknown = await metadata.json();
  if (
    typeof document !== "object" ||
    document === null ||
    !("authorization_servers" in document) ||
    !Array.isArray(document.authorization_servers) ||
    typeof document.authorization_servers[0] !== "string"
  ) {
    throw new Error("no authorization server in the resource metadata");
  }
  const server = await discover(document.authorization_servers[0]);
  if (!server.authorization_endpoint || !server.registration_endpoint) {
    throw new Error("Access OAuth endpoints are incomplete");
  }

  const client = await oauth.processDynamicClientRegistrationResponse(
    await oauth.dynamicClientRegistrationRequest(server, {
      client_name: "hive",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      resource,
    }),
  );
  const pkce =
    crypto ??
    ({
      verifier: oauth.generateRandomCodeVerifier,
      state: oauth.generateRandomState,
      challenge: oauth.calculatePKCECodeChallenge,
    } satisfies LoginCrypto);
  const verifier = pkce.verifier();
  const state = pkce.state();
  const authorizationUrl = new URL(server.authorization_endpoint);
  for (const [key, value] of Object.entries({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    code_challenge: await pkce.challenge(verifier),
    code_challenge_method: "S256",
    state,
    resource,
  })) {
    authorizationUrl.searchParams.set(key, value);
  }

  return {
    authorizationUrl: authorizationUrl.href,
    complete: async (callbackUrl) => {
      const params = oauth.validateAuthResponse(server, client, new URL(callbackUrl), state);
      const token = await oauth.processAuthorizationCodeResponse(
        server,
        client,
        await oauth.authorizationCodeGrantRequest(
          server,
          client,
          oauth.None(),
          params,
          redirectUri,
          verifier,
        ),
      );
      return toStored(server, client.client_id, token);
    },
  };
};
