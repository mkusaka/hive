import { importPKCS8, SignJWT } from "jose";

export type MobilePushKind = "approval" | "mention" | "job";

type FcmServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};
type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type PushEnv = { FCM_SERVICE_ACCOUNT_JSON?: string };

type CachedAccessToken = { serviceAccount: string; token: string; expiresAt: number };
let cachedAccessToken: CachedAccessToken | undefined;

const fcmScope = "https://www.googleapis.com/auth/firebase.messaging";
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const genericNotification = { title: "Hive", body: "New activity is ready" };

const serviceAccount = (json: string): FcmServiceAccount => {
  const parsed: unknown = JSON.parse(json);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("project_id" in parsed) ||
    !("client_email" in parsed) ||
    !("private_key" in parsed) ||
    typeof parsed.project_id !== "string" ||
    typeof parsed.client_email !== "string" ||
    typeof parsed.private_key !== "string"
  ) {
    throw new Error("invalid FCM service account");
  }
  return {
    project_id: parsed.project_id,
    client_email: parsed.client_email,
    private_key: parsed.private_key,
  };
};

const accessToken = async (account: FcmServiceAccount, raw: string, fetchImpl: Fetch) => {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken?.serviceAccount === raw && cachedAccessToken.expiresAt > now + 60) {
    return cachedAccessToken.token;
  }
  const key = await importPKCS8(account.private_key.replaceAll("\\n", "\n"), "RS256");
  const assertion = await new SignJWT({ scope: fcmScope })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(account.client_email)
    .setAudience(tokenEndpoint)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 3600)
    .sign(key);
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error("FCM OAuth failed");
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("access_token" in body) ||
    typeof body.access_token !== "string"
  ) {
    throw new Error("FCM OAuth response is invalid");
  }
  const expiresIn =
    "expires_in" in body && typeof body.expires_in === "number" ? body.expires_in : 3600;
  cachedAccessToken = { serviceAccount: raw, token: body.access_token, expiresAt: now + expiresIn };
  return body.access_token;
};

export const registerMobilePushToken = async (
  db: D1Database,
  userId: string,
  input: { instanceId: string; token: string },
) => {
  await db.batch([
    db
      .prepare("DELETE FROM mobile_push_tokens WHERE user_id = ? AND instance_id = ?")
      .bind(userId, input.instanceId),
    db
      .prepare(
        `INSERT INTO mobile_push_tokens (user_id, instance_id, token) VALUES (?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, instance_id = excluded.instance_id,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .bind(userId, input.instanceId, input.token),
  ]);
};

export const unregisterMobilePushToken = async (
  db: D1Database,
  userId: string,
  instanceId: string,
) =>
  db
    .prepare("DELETE FROM mobile_push_tokens WHERE user_id = ? AND instance_id = ?")
    .bind(userId, instanceId)
    .run();

export const approvalRecipients = async (db: D1Database, workspaceId: string) =>
  (
    await db
      .prepare("SELECT user_id FROM workspace_members WHERE workspace_id = ?")
      .bind(workspaceId)
      .all<{ user_id: string }>()
  ).results.map((row) => row.user_id);

export const mentionedUserRecipients = async (
  db: D1Database,
  workspaceId: string,
  channelId: string,
  userIds: string[],
) => {
  if (userIds.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT DISTINCT a.user_id FROM actors a
       JOIN channel_members m ON m.workspace_id = a.workspace_id AND m.actor_id = a.id
       WHERE a.workspace_id = ? AND m.channel_id = ? AND a.kind = 'user' AND a.user_id IN (${userIds
         .map(() => "?")
         .join(", ")})`,
    )
    .bind(workspaceId, channelId, ...userIds)
    .all<{ user_id: string }>();
  return results.map((row) => row.user_id);
};

export const dmReplyRecipient = async (
  db: D1Database,
  workspaceId: string,
  conversationId: string,
) =>
  (
    await db
      .prepare(
        `SELECT parent.dm_user_id FROM conversations c
         JOIN conversations parent
           ON parent.workspace_id = c.workspace_id
          AND parent.id = COALESCE(c.parent_conversation_id, c.id)
         WHERE c.workspace_id = ? AND c.id = ? AND parent.kind = 'dm'`,
      )
      .bind(workspaceId, conversationId)
      .first<{ dm_user_id: string }>()
  )?.dm_user_id ?? null;

/** Delivers identifier-only data. A missing or invalid service-account secret never affects an API response. */
export const sendMobilePush = async (
  db: D1Database,
  env: PushEnv,
  input: { recipients: string[]; kind: MobilePushKind; id: string },
  fetchImpl: Fetch = fetch,
) => {
  if (!env.FCM_SERVICE_ACCOUNT_JSON || input.recipients.length === 0) return;
  try {
    const account = serviceAccount(env.FCM_SERVICE_ACCOUNT_JSON);
    const { results } = await db
      .prepare(
        `SELECT token FROM mobile_push_tokens WHERE user_id IN (${input.recipients
          .map(() => "?")
          .join(", ")})`,
      )
      .bind(...input.recipients)
      .all<{ token: string }>();
    if (results.length === 0) return;
    const token = await accessToken(account, env.FCM_SERVICE_ACCOUNT_JSON, fetchImpl);
    await Promise.all(
      results.map(async ({ token: registrationToken }) => {
        const response = await fetchImpl(
          `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              message: {
                token: registrationToken,
                data: { kind: input.kind, id: input.id },
                notification: genericNotification,
                android: { priority: "high", notification: { channel_id: "hive" } },
              },
            }),
          },
        );
        if (!response.ok) throw new Error("FCM send failed");
      }),
    );
  } catch {
    console.error("mobile push delivery failed");
  }
};
