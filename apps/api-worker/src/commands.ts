// POST /v1/commands handlers (docs/architecture.md §22.3). Each runs inside `withOperationReceipt`.
import { commandEnvelope, DeviceRegister, DeviceRevoke, WorkspaceCreate } from "@hive/contracts";
import { digest, withOperationReceipt } from "@hive/db";
import * as v from "valibot";
import { hashSecret, newDeviceSecret } from "./auth/device.ts";
import type { Principal } from "./auth/principal.ts";
import { HttpError } from "./errors.ts";

export const CommandEnvelope = commandEnvelope(
  v.variant("type", [WorkspaceCreate, DeviceRegister, DeviceRevoke]),
);
type Envelope = v.InferOutput<typeof CommandEnvelope>;
type Command = Envelope["command"];
type User = Extract<Principal, { kind: "user" }>;
type Handler<T extends Command> = (
  db: D1Database,
  user: User,
  envelope: Envelope & { command: T },
) => Promise<{ status: number; response: unknown }>;

const receipt = async <T>(
  db: D1Database,
  user: User,
  envelope: Envelope,
  statements: D1PreparedStatement[],
  response: T,
) =>
  withOperationReceipt(
    db,
    {
      workspaceId: envelope.workspaceId,
      actorId: user.userId,
      idempotencyKey: envelope.idempotencyKey,
      requestDigest: await digest(envelope.command),
    },
    () => ({ statements, status: 200, response }),
  );

const workspaceCreate: Handler<v.InferOutput<typeof WorkspaceCreate>> = async (db, user, env) => {
  const { workspaceId } = env;
  const member = user.workspaceIds.includes(workspaceId);
  // Dev bootstrap only: a user with no Workspace creates the first one. A member may only replay.
  if (!member && user.workspaceIds.length > 0) {
    throw new HttpError(
      "FORBIDDEN",
      "workspace.create is only allowed before the first membership",
    );
  }
  const exists = await db
    .prepare("SELECT 1 FROM workspaces WHERE id = ?")
    .bind(workspaceId)
    .first();
  if (exists && !member) throw new HttpError("FORBIDDEN", "workspace already exists");
  return receipt(
    db,
    user,
    env,
    [
      db
        .prepare("INSERT INTO workspaces (id, name) VALUES (?, ?)")
        .bind(workspaceId, env.command.name),
      db
        .prepare(
          "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')",
        )
        .bind(workspaceId, user.userId),
    ],
    { operationId: env.operationId, status: "accepted", workspaceId },
  );
};

const deviceRegister: Handler<v.InferOutput<typeof DeviceRegister>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const deviceId = crypto.randomUUID();
  const secret = newDeviceSecret();
  const result = await receipt(
    db,
    user,
    env,
    [
      db
        .prepare(
          `INSERT INTO devices (id, workspace_id, owner_user_id, name, os, agent_version)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(deviceId, workspaceId, user.userId, command.name, command.os, command.agentVersion),
      db
        .prepare(
          "INSERT INTO device_credentials (id, workspace_id, device_id, secret_hash) VALUES (?, ?, ?, ?)",
        )
        .bind(crypto.randomUUID(), workspaceId, deviceId, await hashSecret(secret)),
    ],
    // The receipt keeps a redacted response: a replay never returns the plaintext token again.
    {
      operationId: env.operationId,
      status: "accepted",
      deviceId,
      deviceToken: null as string | null,
    },
  );
  if (result.replayed) return result;
  return {
    status: result.status,
    response: { ...result.response, deviceToken: `${deviceId}.${secret}` },
  };
};

const deviceRevoke: Handler<v.InferOutput<typeof DeviceRevoke>> = async (db, user, env) => {
  const { workspaceId, command } = env;
  const owned = await db
    .prepare("SELECT 1 FROM devices WHERE workspace_id = ? AND id = ? AND owner_user_id = ?")
    .bind(workspaceId, command.deviceId, user.userId)
    .first();
  if (!owned) throw new HttpError("NOT_FOUND", "device not found");
  const now = new Date().toISOString();
  return receipt(
    db,
    user,
    env,
    [
      db
        .prepare(
          `UPDATE devices SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
            WHERE workspace_id = ? AND id = ?`,
        )
        .bind(now, now, workspaceId, command.deviceId),
      db
        .prepare(
          `UPDATE device_credentials SET revoked_at = ?
            WHERE workspace_id = ? AND device_id = ? AND revoked_at IS NULL`,
        )
        .bind(now, workspaceId, command.deviceId),
    ],
    { operationId: env.operationId, status: "accepted", deviceId: command.deviceId },
  );
};

const handlers: { [T in Command["type"]]: Handler<Extract<Command, { type: T }>> } = {
  "workspace.create": workspaceCreate,
  "device.register": deviceRegister,
  "device.revoke": deviceRevoke,
};

export const runCommand = (db: D1Database, principal: Principal, envelope: Envelope) => {
  if (principal.kind !== "user") throw new HttpError("FORBIDDEN", "user principal required");
  const { type } = envelope.command;
  if (type !== "workspace.create" && !principal.workspaceIds.includes(envelope.workspaceId)) {
    throw new HttpError("FORBIDDEN", "not a member of this workspace");
  }
  return (handlers[type] as Handler<Command>)(db, principal, envelope);
};
