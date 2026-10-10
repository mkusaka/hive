// User auth: Cloudflare Access assertion (docs/architecture.md §18.1).
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { Bindings } from "../app.ts";
import { HttpError } from "../errors.ts";
import type { Principal } from "./principal.ts";

const issuerOf = (env: Bindings) => `https://${env.ACCESS_TEAM_DOMAIN}`;

// One remote set per isolate so jose's key cache survives across requests.
let remote: { issuer: string; jwks: JWTVerifyGetKey } | undefined;
export const remoteJwks = (env: Bindings): JWTVerifyGetKey => {
  const issuer = issuerOf(env);
  if (remote?.issuer !== issuer) {
    remote = { issuer, jwks: createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)) };
  }
  return remote.jwks;
};

const unauthenticated = () => new HttpError("UNAUTHENTICATED", "valid Access assertion required");

/** Verifies the assertion, maps (issuer, sub) to a user (created on first login) and loads memberships. */
export const authenticateUser = async (
  request: Request,
  env: Bindings,
  jwks: JWTVerifyGetKey,
): Promise<Principal> => {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) throw unauthenticated();
  const issuer = issuerOf(env);
  const payload = await jwtVerify(assertion, jwks, { issuer, audience: env.ACCESS_AUD }).then(
    (result) => result.payload,
    () => null,
  );
  if (!payload?.sub) throw unauthenticated();
  const email = typeof payload.email === "string" ? payload.email : null;

  const db = env.DB;
  const find = db
    .prepare("SELECT id FROM users WHERE access_issuer = ? AND access_subject = ?")
    .bind(issuer, payload.sub);
  let user = await find.first<{ id: string }>();
  if (!user) {
    // ON CONFLICT: a concurrent first login may have inserted the row.
    await db
      .prepare(
        `INSERT INTO users (id, access_issuer, access_subject, email) VALUES (?, ?, ?, ?)
         ON CONFLICT (access_issuer, access_subject) DO NOTHING`,
      )
      .bind(crypto.randomUUID(), issuer, payload.sub, email)
      .run();
    user = await find.first<{ id: string }>();
  }
  const { results } = await db
    .prepare("SELECT workspace_id FROM workspace_members WHERE user_id = ?")
    .bind(user!.id)
    .all<{ workspace_id: string }>();
  return { kind: "user", userId: user!.id, workspaceIds: results.map((r) => r.workspace_id) };
};
