import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthToken } from "@hive/access";

const storage = vi.hoisted(() => ({ value: null as string | null }));
const grant = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => storage.value,
  setItemAsync: async (_key: string, value: string) => {
    storage.value = value;
  },
  deleteItemAsync: async () => {
    storage.value = null;
  },
}));
vi.mock("expo-crypto", () => ({}));
vi.mock("expo-web-browser", () => ({}));
vi.mock("@hive/access", () => ({
  refresh: grant.refresh,
  isInvalidGrant: () => false,
  prepareLogin: vi.fn(),
}));
import { accessToken, clearSession, loadSession, saveSession, type Session } from "../src/session";

const expired: OAuthToken = {
  authorizationServer: "https://access.example",
  clientId: "client",
  accessToken: "expired-test-token",
  refreshToken: "old-test-grant",
  expiresAt: 0,
};
const renewed: OAuthToken = {
  ...expired,
  accessToken: "renewed-test-token",
  refreshToken: "rotated-test-grant",
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const session = (): Session => ({
  apiUrl: "https://api.example",
  workspaceId: "workspace-a",
  instanceId: "instance-a",
  oauth: { ...expired },
});

beforeEach(() => {
  storage.value = null;
  grant.refresh.mockReset();
  vi.stubGlobal("__DEV__", false);
});

describe("stored OAuth refresh ownership", () => {
  it("preserves a workspace switch and shares rotated grants across the two screen sessions", async () => {
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<OAuthToken>();
    grant.refresh.mockImplementationOnce(() => {
      started.resolve();
      return result.promise;
    });
    grant.refresh.mockRejectedValue(new Error("Old refresh grant was already consumed"));
    const previous = session();
    await saveSession(previous);
    const first = accessToken(previous);
    await started.promise;
    const next = { ...previous, workspaceId: "workspace-b" };
    await saveSession(next);
    const second = accessToken(next);
    result.resolve(renewed);
    expect(await Promise.all([first, second])).toEqual([renewed.accessToken, renewed.accessToken]);
    expect((await loadSession())?.workspaceId).toBe("workspace-b");
    expect(next.oauth).toEqual(renewed);
  });

  it("does not restore credentials when sign-out occurs during refresh", async () => {
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<OAuthToken>();
    grant.refresh.mockImplementationOnce(() => {
      started.resolve();
      return result.promise;
    });
    const previous = session();
    await saveSession(previous);
    const attempt = accessToken(previous);
    const rejected = expect(attempt).rejects.toThrow("Sign in required");
    await started.promise;
    await clearSession();
    result.resolve(renewed);
    await rejected;
    expect(await loadSession()).toBeNull();
  });

  it("does not overwrite a different account while the former grant is refreshing", async () => {
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<OAuthToken>();
    grant.refresh.mockImplementationOnce(() => {
      started.resolve();
      return result.promise;
    });
    const previous = session();
    await saveSession(previous);
    const attempt = accessToken(previous);
    const rejected = expect(attempt).rejects.toThrow("Sign in required");
    await started.promise;
    const next = { ...session(), instanceId: "instance-b", workspaceId: "other-workspace" };
    await saveSession(next);
    result.resolve(renewed);
    await rejected;
    expect(await loadSession()).toEqual(next);
  });
});
