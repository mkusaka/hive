// External effect broker (docs/architecture.md §19): the cloud performs a Bot's external writes with the integration's
// credentials, which never reach a device or a model. claim (`approved → executing`) → perform → `succeeded` /
// `failed` / `unknown`. An `unknown` effect is never re-sent blindly: reconcile looks the object up by its operation
// marker and re-performs only when it is definitely absent (AT-28), at most `maxAttempts` performs in all.
import type { Effect, EffectKind, EffectState } from "@hive/contracts";
import { enqueueOutbox } from "@hive/db";
import { importPKCS8, SignJWT } from "jose";
import { HttpError } from "./errors.ts";

export const maxAttempts = 3;
const maxReconcileRounds = 5;
const reconcileDelaySeconds = 30;
const providerTimeoutMs = 10_000;
const activeRunStates = "('starting', 'running', 'waiting_approval', 'stopping')";

type SlackPost = { channel: string; text: string; threadTs?: string };
type GithubComment = { owner: string; repo: string; issueNumber: number; body: string };

export type EffectRow = {
  id: string;
  workspace_id: string;
  run_id: string;
  bot_id: string;
  integration_id: string;
  kind: EffectKind;
  request: string;
  operation_marker: string;
  state: EffectState;
  approval_id: string | null;
  external_id: string | null;
  external_url: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};
const effectColumns =
  "id, workspace_id, run_id, bot_id, integration_id, kind, request, operation_marker, state, approval_id, " +
  "external_id, external_url, attempts, last_error, created_at, updated_at";

/** UTF-8 prefix of at most `max` bytes, cut on a code point boundary. */
const truncate = (text: string, max: number) => {
  const encoder = new TextEncoder();
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    bytes += encoder.encode(ch).length;
    if (bytes > max) break;
    out += ch;
  }
  return out;
};

/** What a human approves and lists show: target and text, at most 2 KiB (the approvals `args_summary` limit). */
export const summarize = (kind: EffectKind, request: unknown) => {
  if (kind === "slack.post") {
    const r = request as SlackPost;
    return truncate(`${r.channel}${r.threadTs ? ` thread ${r.threadTs}` : ""}: ${r.text}`, 2048);
  }
  const r = request as GithubComment;
  return truncate(`${r.owner}/${r.repo}#${r.issueNumber}: ${r.body}`, 2048);
};

const toEffect = (row: EffectRow): Effect => ({
  id: row.id,
  runId: row.run_id,
  botId: row.bot_id,
  integrationId: row.integration_id,
  kind: row.kind,
  state: row.state,
  summary: summarize(row.kind, JSON.parse(row.request)),
  approvalId: row.approval_id,
  externalId: row.external_id,
  externalUrl: row.external_url,
  attempts: row.attempts,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** `GET /v1/run/effects/:id`: only the Run's own effects. */
export const getRunEffect = async (db: D1Database, runId: string, effectId: string) => {
  const row = await db
    .prepare(`SELECT ${effectColumns} FROM effects WHERE id = ? AND run_id = ?`)
    .bind(effectId, runId)
    .first<EffectRow>();
  if (!row) throw new HttpError("NOT_FOUND", "effect not found");
  return toEffect(row);
};

/** `GET /v1/effects?state=&runId=`: newest first, at most 200. */
export const listEffects = async (
  db: D1Database,
  workspaceId: string,
  filter: { state?: string; runId?: string },
) => {
  const { results } = await db
    .prepare(
      `SELECT ${effectColumns} FROM effects
        WHERE workspace_id = ? AND (?2 IS NULL OR state = ?2) AND (?3 IS NULL OR run_id = ?3)
        ORDER BY created_at DESC, id LIMIT 200`,
    )
    .bind(workspaceId, filter.state ?? null, filter.runId ?? null)
    .all<EffectRow>();
  return { effects: results.map(toEffect) };
};

// ------------------------------------------------------------------ Performers

export type PerformResult =
  | { outcome: "succeeded"; externalId: string; externalUrl: string | null }
  /** `failed`: definitely not written. `unknown`: may have been written. */
  | { outcome: "failed" | "unknown"; error: string };
type Failure = Exclude<PerformResult, { outcome: "succeeded" }>;
export type Performer = {
  perform(effect: EffectRow): Promise<PerformResult>;
  /** The object carrying the effect's marker, or null when it is definitely absent. Throws when the lookup failed. */
  find(effect: EffectRow): Promise<{ externalId: string; externalUrl: string | null } | null>;
};
export type Performers = Record<EffectKind, Performer>;

/**
 * Provider credentials (Workers secrets, `.dev.vars` locally). Environment-level: one Slack app and one GitHub App
 * installation per deployment; per-installation credentials are a known gap.
 */
export type EffectSecrets = {
  SLACK_BOT_TOKEN?: string;
  GITHUB_APP_ID?: string;
  /** PKCS#8 PEM (not the PKCS#1 file GitHub downloads); `\n` escapes are accepted. */
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_INSTALLATION_ID?: string;
};
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

// 408 / 429 / 5xx: the request may have been processed. Any other non-2xx: it definitely was not.
const indefinite = (status: number) => status === 408 || status === 429 || status >= 500;
const httpFailure = (status: number, what: string): Failure => ({
  outcome: indefinite(status) ? "unknown" : "failed",
  error: `${what}: HTTP ${status}`,
});
// Slack answers HTTP 200 with `ok: false`; these errors are transient server-side states.
const slackIndefinite = new Set([
  "ratelimited",
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
]);
const slackMetadataType = "hive_effect";
const githubMarker = (marker: string) => `<!-- ${marker} -->`;
// Lookups read objects created since the effect, minus clock skew.
const since = (effect: EffectRow) => new Date(Date.parse(effect.created_at) - 60_000);
const maxLookupPages = 10;

/** GitHub App JWT (RS256): `iat` 60 s in the past against clock drift, `exp` 9 min ahead (GitHub allows ≤ 10). */
export const githubAppJwt = async (appId: string, privateKeyPem: string, now = Date.now()) => {
  const key = await importPKCS8(privateKeyPem.replaceAll("\\n", "\n"), "RS256");
  const iat = Math.floor(now / 1000) - 60;
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(appId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 600)
    .sign(key);
};

const githubHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "hive-effect-broker",
});

/** The real providers over `fetch`; tests inject a fake `fetch` that answers with the providers' shapes. */
export const createPerformers = (secrets: EffectSecrets, fetchImpl: Fetch = fetch): Performers => {
  const call = (url: string, init: RequestInit) =>
    fetchImpl(url, { ...init, signal: AbortSignal.timeout(providerTimeoutMs) });

  const slack = (method: string, init: RequestInit) =>
    call(`https://slack.com/api/${method}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${secrets.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json; charset=utf-8",
      },
    });

  // ponytail: a new installation token per call; cache it until `expires_at` if volume matters.
  const installationToken = async (): Promise<string | Failure> => {
    const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_INSTALLATION_ID } = secrets;
    if (!GITHUB_APP_ID || !GITHUB_APP_PRIVATE_KEY || !GITHUB_INSTALLATION_ID) {
      return { outcome: "failed", error: "github app credentials are not configured" };
    }
    const jwt = await githubAppJwt(GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY);
    const res = await call(
      `https://api.github.com/app/installations/${GITHUB_INSTALLATION_ID}/access_tokens`,
      { method: "POST", headers: githubHeaders(jwt) },
    );
    if (res.status !== 201) return httpFailure(res.status, "installation token");
    return ((await res.json()) as { token: string }).token;
  };

  return {
    "slack.post": {
      perform: async (effect) => {
        if (!secrets.SLACK_BOT_TOKEN) {
          return { outcome: "failed", error: "slack bot token is not configured" };
        }
        const r = JSON.parse(effect.request) as SlackPost;
        const res = await slack("chat.postMessage", {
          method: "POST",
          body: JSON.stringify({
            channel: r.channel,
            text: r.text,
            ...(r.threadTs ? { thread_ts: r.threadTs } : {}),
            metadata: {
              event_type: slackMetadataType,
              event_payload: { marker: effect.operation_marker },
            },
          }),
        });
        if (!res.ok) return httpFailure(res.status, "chat.postMessage");
        const body = (await res.json()) as { ok: boolean; ts?: string; error?: string };
        if (body.ok && body.ts)
          return { outcome: "succeeded", externalId: body.ts, externalUrl: null };
        const error = body.error ?? "unknown_error";
        return {
          outcome: slackIndefinite.has(error) ? "unknown" : "failed",
          error: `chat.postMessage: ${error}`,
        };
      },
      // Thread replies or channel history since the effect, with metadata (needs a `*:history` scope).
      find: async (effect) => {
        const r = JSON.parse(effect.request) as SlackPost;
        const method = r.threadTs ? "conversations.replies" : "conversations.history";
        let cursor = "";
        for (let page = 0; page < maxLookupPages; page++) {
          const params = new URLSearchParams({
            channel: r.channel,
            oldest: String(since(effect).getTime() / 1000),
            inclusive: "true",
            include_all_metadata: "true",
            limit: "200",
            ...(r.threadTs ? { ts: r.threadTs } : {}),
            ...(cursor ? { cursor } : {}),
          });
          // oxlint-disable-next-line no-await-in-loop -- pages are sequential
          const res = await slack(`${method}?${params}`, { method: "GET" });
          if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
          // oxlint-disable-next-line no-await-in-loop -- pages are sequential
          const body = (await res.json()) as {
            ok: boolean;
            error?: string;
            messages?: {
              ts: string;
              metadata?: { event_type?: string; event_payload?: { marker?: string } };
            }[];
            response_metadata?: { next_cursor?: string };
          };
          if (!body.ok) throw new Error(`${method}: ${body.error ?? "unknown_error"}`);
          const hit = body.messages?.find(
            (m) =>
              m.metadata?.event_type === slackMetadataType &&
              m.metadata.event_payload?.marker === effect.operation_marker,
          );
          if (hit) return { externalId: hit.ts, externalUrl: null };
          cursor = body.response_metadata?.next_cursor ?? "";
          if (!cursor) return null;
        }
        throw new Error(`${method}: more than ${maxLookupPages} pages to search`);
      },
    },
    "github.comment": {
      perform: async (effect) => {
        const token = await installationToken();
        if (typeof token !== "string") return token;
        const r = JSON.parse(effect.request) as GithubComment;
        const res = await call(
          `https://api.github.com/repos/${r.owner}/${r.repo}/issues/${r.issueNumber}/comments`,
          {
            method: "POST",
            headers: { ...githubHeaders(token), "Content-Type": "application/json" },
            body: JSON.stringify({
              body: `${r.body}\n\n${githubMarker(effect.operation_marker)}`,
            }),
          },
        );
        if (res.status !== 201) return httpFailure(res.status, "create comment");
        const body = (await res.json()) as { id: number; html_url: string };
        return { outcome: "succeeded", externalId: String(body.id), externalUrl: body.html_url };
      },
      // The issue's comments updated since the effect (ascending by id; the API has no sort for this list).
      find: async (effect) => {
        const token = await installationToken();
        if (typeof token !== "string") throw new Error(token.error);
        const r = JSON.parse(effect.request) as GithubComment;
        const marker = githubMarker(effect.operation_marker);
        for (let page = 1; page <= maxLookupPages; page++) {
          const params = new URLSearchParams({
            since: since(effect).toISOString(),
            per_page: "100",
            page: String(page),
          });
          // oxlint-disable-next-line no-await-in-loop -- pages are sequential
          const res = await call(
            `https://api.github.com/repos/${r.owner}/${r.repo}/issues/${r.issueNumber}/comments?${params}`,
            { method: "GET", headers: githubHeaders(token) },
          );
          if (res.status !== 200) throw new Error(`list comments: HTTP ${res.status}`);
          // oxlint-disable-next-line no-await-in-loop -- pages are sequential
          const comments = (await res.json()) as { id: number; html_url: string; body?: string }[];
          const hit = comments.find((c) => c.body?.includes(marker));
          if (hit) return { externalId: String(hit.id), externalUrl: hit.html_url };
          if (comments.length < 100) return null;
        }
        throw new Error(`list comments: more than ${maxLookupPages} pages to search`);
      },
    },
  };
};

// ------------------------------------------------------------------ Consumers

const iso = (ms = Date.now()) => new Date(ms).toISOString();

/** A change row only when the statement right before it changed a row (same batch, same connection). */
export const effectChange = (db: D1Database, workspaceId: string, effectId: string) =>
  db
    .prepare(
      `INSERT INTO change_log (workspace_id, entity_kind, entity_id, op, scope)
       SELECT ?, 'effect', ?, 'upsert', ? WHERE changes() = 1`,
    )
    .bind(workspaceId, effectId, `workspace:${workspaceId}`);

/** `effect.perform` for an `approved` effect at `attempt` performs; for the batch that made it `approved`. */
export const queuePerform = (db: D1Database, effectId: string) =>
  db
    .prepare(
      `INSERT INTO outbox (id, workspace_id, topic, payload)
       SELECT ?, workspace_id, 'effect.perform', json_object('effectId', id, 'attempt', attempts)
         FROM effects WHERE id = ? AND state = 'approved'`,
    )
    .bind(crypto.randomUUID(), effectId);

const queueReconcile = (db: D1Database, effect: EffectRow, round: number) =>
  enqueueOutbox(db, {
    workspaceId: effect.workspace_id,
    topic: "effect.reconcile",
    payload: { effectId: effect.id, round },
    availableAt: iso(Date.now() + reconcileDelaySeconds * 1000 * 2 ** round),
  });

const loadEffect = (db: D1Database, effectId: string) =>
  db.prepare(`SELECT ${effectColumns} FROM effects WHERE id = ?`).bind(effectId).first<EffectRow>();

/** `executing` → `unknown` with a reconcile scheduled. */
const markUnknown = (db: D1Database, effect: EffectRow, error: string) =>
  db.batch([
    db
      .prepare(
        "UPDATE effects SET state = 'unknown', last_error = ?, updated_at = ? WHERE id = ? AND state = 'executing'",
      )
      .bind(error, iso(), effect.id),
    effectChange(db, effect.workspace_id, effect.id),
    queueReconcile(db, effect, 0),
  ]);

/**
 * `effect.perform {effectId, attempt}`. The claim CAS needs `attempts = attempt`, so a duplicate message is a no-op.
 * The first perform also needs the requesting Run to be active at its generation (AT-40): a Run that lost its
 * capability never writes. A later attempt only re-sends an object reconcile proved absent, or a human's retry.
 * Provider errors never throw (the outbox would re-send): they settle the effect.
 */
export const performEffect = async (
  db: D1Database,
  performers: Performers,
  input: { effectId: string; attempt: number },
) => {
  const effect = await loadEffect(db, input.effectId);
  if (!effect) return null;
  const [claimed] = await db.batch([
    db
      .prepare(
        `UPDATE effects SET state = 'executing', attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND state = 'approved' AND attempts = ?
            AND (attempts > 0 OR EXISTS (SELECT 1 FROM runs r WHERE r.workspace_id = effects.workspace_id
                   AND r.id = effects.run_id AND r.execution_generation = effects.execution_generation
                   AND r.state IN ${activeRunStates}))`,
      )
      .bind(iso(), effect.id, input.attempt),
    effectChange(db, effect.workspace_id, effect.id),
  ]);
  if (!claimed!.meta.changes) {
    if (effect.state === "executing" && effect.attempts === input.attempt + 1) {
      // This message's earlier delivery claimed it and died before settling: the write may have happened.
      await markUnknown(db, effect, "performer interrupted");
      return effect.workspace_id;
    }
    if (effect.state === "approved" && effect.attempts === 0 && input.attempt === 0) {
      await db.batch([
        db
          .prepare(
            `UPDATE effects SET state = 'failed', last_error = 'run_not_current', updated_at = ?
              WHERE id = ? AND state = 'approved' AND attempts = 0`,
          )
          .bind(iso(), effect.id),
        effectChange(db, effect.workspace_id, effect.id),
      ]);
      return effect.workspace_id;
    }
    return null;
  }
  let result: PerformResult;
  try {
    result = await performers[effect.kind].perform(effect);
  } catch (error) {
    result = { outcome: "unknown", error: error instanceof Error ? error.message : String(error) };
  }
  if (result.outcome === "unknown") {
    await markUnknown(db, effect, result.error);
  } else {
    await db.batch([
      db
        .prepare(
          `UPDATE effects SET state = ?, external_id = ?, external_url = ?, last_error = ?, updated_at = ?
            WHERE id = ? AND state = 'executing'`,
        )
        .bind(
          result.outcome,
          result.outcome === "succeeded" ? result.externalId : null,
          result.outcome === "succeeded" ? result.externalUrl : null,
          result.outcome === "succeeded" ? null : result.error,
          iso(),
          effect.id,
        ),
      effectChange(db, effect.workspace_id, effect.id),
    ]);
  }
  return effect.workspace_id;
};

/**
 * `effect.reconcile {effectId, round}` for an `unknown` effect: found → `succeeded`; definitely absent → `approved`
 * and performed again while attempts < `maxAttempts`, else it stays `unknown` for `effect.resolve`; a failed lookup is
 * retried with backoff up to `maxReconcileRounds`.
 */
export const reconcileEffect = async (
  db: D1Database,
  performers: Performers,
  input: { effectId: string; round: number },
) => {
  const effect = await loadEffect(db, input.effectId);
  if (!effect || effect.state !== "unknown") return null;
  const settle = (sql: string, ...params: unknown[]) =>
    db.batch([
      db
        .prepare(
          `UPDATE effects SET ${sql}, updated_at = ? WHERE id = ? AND state = 'unknown' AND attempts = ?`,
        )
        .bind(...params, iso(), effect.id, effect.attempts),
      effectChange(db, effect.workspace_id, effect.id),
    ]);
  let found: Awaited<ReturnType<Performer["find"]>>;
  try {
    found = await performers[effect.kind].find(effect);
  } catch (error) {
    const message = `reconcile: ${error instanceof Error ? error.message : String(error)}`;
    const next = input.round + 1;
    if (next < maxReconcileRounds) {
      await db.batch([
        db
          .prepare("UPDATE effects SET last_error = ?, updated_at = ? WHERE id = ?")
          .bind(message, iso(), effect.id),
        queueReconcile(db, effect, next),
      ]);
    } else {
      await settle("last_error = ?", `${message}; resolve manually`);
    }
    return effect.workspace_id;
  }
  if (found) {
    await settle(
      "state = 'succeeded', external_id = ?, external_url = ?, last_error = NULL",
      found.externalId,
      found.externalUrl,
    );
  } else if (effect.attempts < maxAttempts) {
    await db.batch([
      db
        .prepare(
          "UPDATE effects SET state = 'approved', updated_at = ? WHERE id = ? AND state = 'unknown' AND attempts = ?",
        )
        .bind(iso(), effect.id, effect.attempts),
      effectChange(db, effect.workspace_id, effect.id),
      queuePerform(db, effect.id),
    ]);
  } else {
    await settle("last_error = ?", `not found after ${effect.attempts} attempts; resolve manually`);
  }
  return effect.workspace_id;
};
