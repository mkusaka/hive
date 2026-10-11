// Sync controller (docs/architecture.md §12.2, §12.3). Pure: HTTP and refetching are injected.
/* oxlint-disable no-await-in-loop */
import type { ApiResult } from "../../shared/api.ts";

export type ListKey = "channels" | "messages" | "inbox" | "jobs" | "bots" | "devices" | "approvals";
export const allLists: ListKey[] = [
  "channels",
  "messages",
  "inbox",
  "jobs",
  "bots",
  "devices",
  "approvals",
];

type Change = { scope: string; entityKind: string };

/**
 * `channel:*` → messages / inbox (and the channel list for a new channel); `workspace:*` → jobs / bots / devices /
 * approvals.
 */
export const refetchFor = (changes: Change[]) => {
  const keys = new Set<ListKey>();
  for (const { scope, entityKind } of changes) {
    if (scope.startsWith("channel:")) {
      keys.add("messages").add("inbox");
      if (entityKind === "channel") keys.add("channels");
    } else if (scope.startsWith("workspace:")) {
      keys.add("jobs").add("bots").add("devices").add("approvals");
    }
  }
  return keys;
};

/** `unsynced`: `sync.changed` hints received whose changes have not been fetched yet. */
export type SyncStatus = { cursor: string | null; unsynced: number; error: string | null };

export const createSync = (deps: {
  workspaceId: string;
  get: (path: string) => Promise<ApiResult>;
  refetch: (keys: Set<ListKey>) => void;
  onStatus: (status: SyncStatus) => void;
}) => {
  let cursor: string | null = null;
  let unsynced = 0;
  let running: Promise<void> | null = null;
  let dirty = false;

  const changes = async (from?: string) => {
    const query = new URLSearchParams({
      workspaceId: deps.workspaceId,
      ...(from ? { cursor: from } : {}),
    });
    const result = await deps.get(`/v1/sync/changes?${query}`);
    if (!result.ok)
      throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.value as { changes: Change[]; cursor: string; hasMore: boolean };
  };

  // Head cursor first, then the lists: replaying from it converges (§12.3).
  const bootstrap = async () => {
    cursor = (await changes()).cursor;
    deps.refetch(new Set(allLists));
  };

  const pullOnce = async () => {
    if (cursor === null) return bootstrap();
    const keys = new Set<ListKey>();
    for (;;) {
      let page;
      try {
        page = await changes(cursor);
      } catch (error) {
        if ((error as { code?: string }).code !== "CURSOR_EXPIRED") throw error;
        cursor = null;
        return bootstrap();
      }
      cursor = page.cursor;
      for (const key of refetchFor(page.changes)) keys.add(key);
      if (!page.hasMore) break;
    }
    if (keys.size > 0) deps.refetch(keys);
  };

  /** Serialized; a hint arriving mid-pull runs one more pull after it. */
  const pull = (): Promise<void> => {
    if (running) {
      dirty = true;
      return running;
    }
    running = (async () => {
      let error: string | null = null;
      try {
        do {
          dirty = false;
          const seen = unsynced;
          await pullOnce();
          unsynced -= seen;
        } while (dirty);
      } catch (e) {
        error = String(e);
      } finally {
        running = null;
      }
      deps.onStatus({ cursor, unsynced, error });
    })();
    return running;
  };

  return {
    /** Bootstrap, reconnect, focus and periodic reconcile all just pull. */
    pull,
    hint: () => {
      unsynced += 1;
      deps.onStatus({ cursor, unsynced, error: null });
      return pull();
    },
  };
};
