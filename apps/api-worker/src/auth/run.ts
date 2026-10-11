// Run capability (docs/architecture.md §18.2): `Authorization: Bearer cap.<runId>.<secret>`, issued with job.claim.
// Only SHA-256(secret) is stored. Valid while the Run is active at the capability's generation, before `expires_at`
// and not revoked.
import type { Bindings } from "../app.ts";
import { HttpError } from "../errors.ts";
import { hashSecret } from "./device.ts";
import type { Principal } from "./principal.ts";

/** docs/roadmap.md §1 lease (90 s) plus this grace: a renewal extends both. */
export const capabilityGraceSeconds = 5 * 60;

export const capabilityExpiresAt = (leaseExpiresAt: string) =>
  new Date(Date.parse(leaseExpiresAt) + capabilityGraceSeconds * 1000).toISOString();

/** The row behind a new token `cap.<runId>.<secret>`; goes in the claim batch. */
export const insertCapability = (
  db: D1Database,
  input: {
    workspaceId: string;
    runId: string;
    executionGeneration: number;
    tokenHash: string;
    scopes: string[];
    expiresAt: string;
  },
) =>
  db
    .prepare(
      `INSERT INTO run_capabilities (id, workspace_id, run_id, execution_generation, token_hash, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.workspaceId,
      input.runId,
      input.executionGeneration,
      input.tokenHash,
      JSON.stringify(input.scopes),
      input.expiresAt,
    );

const unauthenticated = () => new HttpError("UNAUTHENTICATED", "valid run capability required");

type Row = {
  token_hash: string;
  scopes: string;
  execution_generation: number;
  workspace_id: string;
  job_id: string;
  bot_id: string;
  actor_id: string;
  conversation_id: string | null;
  hop: number | null;
  correlation_id: string | null;
  task_id: string | null;
  project_id: string | null;
};

export const authenticateRun = async (request: Request, env: Bindings): Promise<Principal> => {
  const token = request.headers.get("Authorization")?.match(/^Bearer cap\.([^.]+)\.(.+)$/);
  if (!token) throw unauthenticated();
  const runId = token[1]!;
  const secret = token[2]!;
  // Fencing (§10.3): the Run must still be active at the generation the capability was issued for.
  const { results } = await env.DB.prepare(
    `SELECT c.token_hash, c.scopes, c.execution_generation, r.workspace_id, r.job_id, j.bot_id, b.actor_id,
            i.conversation_id, i.hop, j.correlation_id, j.task_id, t.project_id
       FROM run_capabilities c
       JOIN runs r ON r.workspace_id = c.workspace_id AND r.id = c.run_id
       JOIN jobs j ON j.workspace_id = r.workspace_id AND j.id = r.job_id
       JOIN bots b ON b.workspace_id = j.workspace_id AND b.id = j.bot_id
       LEFT JOIN inbox_items i ON i.workspace_id = j.workspace_id AND 'inbox:' || i.id = j.trigger_key
       LEFT JOIN tasks t ON t.workspace_id = j.workspace_id AND t.id = j.task_id
      WHERE c.run_id = ? AND c.revoked_at IS NULL AND c.expires_at > ?
        AND r.execution_generation = c.execution_generation
        AND r.state IN ('starting', 'running', 'waiting_approval', 'stopping')`,
  )
    .bind(runId, new Date().toISOString())
    .all<Row>();
  const presented = new TextEncoder().encode(await hashSecret(secret));
  const match = results.find((row) => {
    const stored = new TextEncoder().encode(row.token_hash);
    return stored.length === presented.length && crypto.subtle.timingSafeEqual(stored, presented);
  });
  if (!match) throw unauthenticated();
  return {
    kind: "run",
    runId,
    jobId: match.job_id,
    botId: match.bot_id,
    botActorId: match.actor_id,
    workspaceId: match.workspace_id,
    workspaceIds: [match.workspace_id],
    executionGeneration: match.execution_generation,
    conversationId: match.conversation_id,
    hop: match.hop ?? 0,
    correlationId: match.correlation_id ?? match.job_id,
    taskId: match.task_id,
    taskProjectId: match.project_id,
    scopes: JSON.parse(match.scopes) as string[],
  };
};
