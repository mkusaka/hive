import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("expo-crypto", () => ({}));
vi.mock("../src/session", () => ({ accessToken: async () => "synthetic-test-token" }));
import { client } from "../src/api";

const api = client({
  apiUrl: "https://api.example",
  workspaceId: "workspace",
  instanceId: "instance",
});
afterEach(() => vi.unstubAllGlobals());

describe("Worker error contract", () => {
  it("preserves CURSOR_EXPIRED so the sync controller can re-bootstrap after HTTP 410", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json(
        {
          code: "CURSOR_EXPIRED",
          message: "cursor expired",
          requestId: "request",
          retryable: false,
        },
        { status: 410 },
      ),
    );
    expect(await api.get("/v1/sync?workspaceId=workspace&cursor=old")).toEqual({
      ok: false,
      error: { code: "CURSOR_EXPIRED", message: "cursor expired" },
    });
  });

  it("shows a Worker internal error instead of discarding its message when there is no code", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ message: "internal error", requestId: "request" }, { status: 500 }),
    );
    expect(await api.get("/v1/me")).toEqual({
      ok: false,
      error: { code: "HTTP_500", message: "internal error" },
    });
  });
});
