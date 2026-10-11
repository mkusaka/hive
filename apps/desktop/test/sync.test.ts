import { describe, expect, it } from "vitest";
import type { ApiResult } from "../src/shared/api.ts";
import { allLists, createSync, type ListKey, type SyncStatus } from "../src/renderer/src/sync.ts";

const ok = (value: Record<string, unknown>): ApiResult => ({ ok: true, value });
const page = (cursor: string, changes: { scope: string; entityKind: string }[], hasMore = false) =>
  ok({ changes, cursor, hasMore });

/** `responses` are consumed in order; requested paths and refetch sets are recorded. */
const harness = (responses: ApiResult[]) => {
  const paths: string[] = [];
  const refetched: ListKey[][] = [];
  const statuses: SyncStatus[] = [];
  const sync = createSync({
    workspaceId: "ws-1",
    get: async (path) => {
      paths.push(path);
      const next = responses.shift();
      if (!next) throw new Error(`unexpected GET ${path}`);
      return next;
    },
    refetch: (keys) => void refetched.push([...keys].toSorted()),
    onStatus: (status) => void statuses.push(status),
  });
  return { sync, paths, refetched, statuses };
};

describe("sync controller", () => {
  it("bootstraps from the head cursor, then refetches by the scopes of the changes", async () => {
    const h = harness([
      page("H0", []),
      page("C1", [{ scope: "channel:ch-1", entityKind: "message" }], true),
      page("C2", [{ scope: "workspace:ws-1", entityKind: "job" }]),
    ]);
    await h.sync.pull();
    expect(h.paths).toEqual(["/v1/sync/changes?workspaceId=ws-1"]);
    expect(h.refetched).toEqual([[...allLists].toSorted()]);

    await h.sync.hint();
    expect(h.paths.slice(1)).toEqual([
      "/v1/sync/changes?workspaceId=ws-1&cursor=H0",
      "/v1/sync/changes?workspaceId=ws-1&cursor=C1",
    ]);
    expect(h.refetched[1]).toEqual(["bots", "devices", "inbox", "jobs", "messages"]);
    expect(h.statuses.at(-1)).toEqual({ cursor: "C2", unsynced: 0, error: null });
  });

  it("adds the channel list for a new channel and refetches nothing for an empty page", async () => {
    const h = harness([
      page("H0", []),
      page("C1", [{ scope: "channel:ch-2", entityKind: "channel" }]),
      page("C1", []),
    ]);
    await h.sync.pull();
    await h.sync.hint();
    await h.sync.pull();
    expect(h.refetched.slice(1)).toEqual([["channels", "inbox", "messages"]]);
  });

  it("re-bootstraps on 410 CURSOR_EXPIRED", async () => {
    const h = harness([
      page("H0", []),
      { ok: false, error: { code: "CURSOR_EXPIRED", message: "bootstrap again" } },
      page("H1", []),
    ]);
    await h.sync.pull();
    await h.sync.hint();
    expect(h.paths.at(-1)).toBe("/v1/sync/changes?workspaceId=ws-1");
    expect(h.refetched).toHaveLength(2);
    expect(h.statuses.at(-1)).toEqual({ cursor: "H1", unsynced: 0, error: null });
  });

  it("keeps the hint unsynced when the pull fails", async () => {
    const h = harness([page("H0", []), { ok: false, error: { code: "NETWORK", message: "down" } }]);
    await h.sync.pull();
    await h.sync.hint();
    expect(h.statuses.at(-1)).toMatchObject({ cursor: "H0", unsynced: 1 });
    expect(h.statuses.at(-1)?.error).toContain("down");
  });
});
