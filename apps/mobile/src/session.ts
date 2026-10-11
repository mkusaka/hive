import { isInvalidGrant, prepareLogin, refresh, type OAuthToken } from "@hive/access";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import * as v from "valibot";

export type Session = {
  apiUrl: string;
  workspaceId: string;
  instanceId: string;
  userId?: string;
  oauth?: OAuthToken;
  devToken?: string;
};
const storageKey = "hive.session";
const sessionSchema = v.object({
  apiUrl: v.string(),
  workspaceId: v.string(),
  instanceId: v.string(),
  userId: v.optional(v.string()),
  devToken: v.optional(v.string()),
  oauth: v.optional(
    v.object({
      authorizationServer: v.string(),
      clientId: v.string(),
      accessToken: v.string(),
      refreshToken: v.string(),
      expiresAt: v.number(),
    }),
  ),
});
export const loadSession = async () => {
  const stored = await SecureStore.getItemAsync(storageKey);
  return stored ? v.parse(sessionSchema, JSON.parse(stored)) : null;
};
export const saveSession = (session: Session) =>
  SecureStore.setItemAsync(storageKey, JSON.stringify(session));
export const clearSession = () => SecureStore.deleteItemAsync(storageKey);

const refreshing = new Map<string, Promise<OAuthToken>>();
export const accessToken = async (session: Session) => {
  if (__DEV__ && session.devToken) return session.devToken;
  if (!session.oauth) throw new Error("Sign in required");
  if (session.oauth.expiresAt > Date.now() + 30_000) return session.oauth.accessToken;
  const key = JSON.stringify([session.apiUrl, session.instanceId]);
  let pending = refreshing.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const stored = await loadSession();
        if (
          !stored?.oauth ||
          stored.instanceId !== session.instanceId ||
          stored.apiUrl !== session.apiUrl
        )
          throw new Error("Sign in required");
        if (stored.oauth.expiresAt > Date.now() + 30_000) return stored.oauth;
        const token = await refresh(stored.oauth);
        const saved = await loadSession();
        if (
          !saved ||
          saved.instanceId !== session.instanceId ||
          saved.apiUrl !== session.apiUrl ||
          saved.oauth?.refreshToken !== stored.oauth.refreshToken
        )
          throw new Error("Sign in required");
        // Preserve a workspace change made while the network request was pending.
        await saveSession({ ...saved, oauth: token });
        return token;
      } catch (error) {
        if (isInvalidGrant(error))
          throw new Error("Access session expired. Sign in again.", { cause: error });
        throw error;
      } finally {
        refreshing.delete(key);
      }
    })();
    refreshing.set(key, pending);
  }
  session.oauth = await pending;
  return session.oauth.accessToken;
};

const random = () =>
  Array.from(Crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
export const signIn = async (apiUrl: string, devScheme: boolean) => {
  const redirectUri = devScheme ? "hive://callback" : `${apiUrl}/mobile/callback`;
  const attempt = await prepareLogin(apiUrl, redirectUri, {
    verifier: random,
    state: random,
    challenge: async (verifier) =>
      (
        await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
          encoding: Crypto.CryptoEncoding.BASE64,
        })
      )
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, ""),
  });
  const response = await WebBrowser.openAuthSessionAsync(attempt.authorizationUrl, redirectUri);
  if (response.type !== "success") throw new Error("Sign in cancelled");
  return attempt.complete(response.url);
};
