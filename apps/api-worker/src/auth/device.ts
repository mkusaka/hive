// Device auth: `X-Hive-Token: <deviceId>.<secret>`; only SHA-256(secret) is stored.
import type { Bindings } from "../app.ts";
import { HttpError } from "../errors.ts";
import type { Principal } from "./principal.ts";

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

export const hashSecret = async (secret: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));

export const newDeviceSecret = () => hex(crypto.getRandomValues(new Uint8Array(32)));

const unauthenticated = () => new HttpError("UNAUTHENTICATED", "valid device token required");

/**
 * The hive token (device token or Run capability): `X-Hive-Token`, else `Authorization: Bearer` (local dev, older
 * clients). Behind Access with Managed OAuth, `Authorization: Bearer` belongs to Access, which would try to resolve
 * it as an OAuth token.
 */
export const hiveToken = (request: Request) =>
  request.headers.get("X-Hive-Token") ??
  request.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1];

export const authenticateDevice = async (request: Request, env: Bindings): Promise<Principal> => {
  const token = hiveToken(request);
  const dot = token?.indexOf(".") ?? -1;
  if (!token || dot <= 0) throw unauthenticated();
  const deviceId = token.slice(0, dot);
  const presented = new TextEncoder().encode(await hashSecret(token.slice(dot + 1)));
  const { results } = await env.DB.prepare(
    `SELECT c.secret_hash, d.owner_user_id, d.workspace_id
       FROM device_credentials c
       JOIN devices d ON d.workspace_id = c.workspace_id AND d.id = c.device_id
      WHERE c.device_id = ? AND c.revoked_at IS NULL AND d.revoked_at IS NULL`,
  )
    .bind(deviceId)
    .all<{ secret_hash: string; owner_user_id: string; workspace_id: string }>();
  const match = results.find((row) => {
    const stored = new TextEncoder().encode(row.secret_hash);
    return stored.length === presented.length && crypto.subtle.timingSafeEqual(stored, presented);
  });
  if (!match) throw unauthenticated();
  return {
    kind: "device",
    deviceId,
    ownerUserId: match.owner_user_id,
    workspaceIds: [match.workspace_id],
  };
};
