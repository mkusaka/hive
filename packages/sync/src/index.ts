// Sync controller (docs/architecture.md §12.2, §12.3). Pure: HTTP and refetching are injected.
/* oxlint-disable no-await-in-loop */
export type ApiResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string; body?: unknown } };

/** `run`: the Run open in the Run Inspector (state, persistence, transcript); `thread`: the open Thread panel. */
export type ListKey =
  | "channels"
  | "dms"
  | "messages"
  | "thread"
  | "threads"
  | "inbox"
  | "jobs"
  | "bots"
  | "devices"
  | "approvals"
  | "sidebar"
  | "run";
export const allLists: ListKey[] = [
  "channels",
  "dms",
  "messages",
  "thread",
  "threads",
  "inbox",
  "jobs",
  "bots",
  "devices",
  "approvals",
  "sidebar",
  "run",
];

type Change = { scope: string; entityKind: string };

/**
 * `channel:*` (a DM's too; thread replies carry their parent's) → messages / the open thread / threads / inbox and the
 * channel and DM lists (their `lastMessage` previews);
 * `workspace:*` → jobs / bots / devices / approvals / sidebar / DMs (and the inspected Run for a `run` or `effect` row).
 */
export const refetchFor = (changes: Change[]) => {
  const keys = new Set<ListKey>();
  for (const { scope, entityKind } of changes) {
    if (scope.startsWith("channel:")) {
      keys.add("messages").add("thread").add("threads").add("inbox").add("channels").add("dms");
    } else if (scope.startsWith("workspace:")) {
      keys.add("jobs").add("bots").add("devices").add("approvals").add("sidebar").add("dms");
      if (entityKind === "run" || entityKind === "effect") keys.add("run");
    }
  }
  return keys;
};

/** `unsynced`: `sync.changed` hints received whose changes have not been fetched yet. */
export type SyncStatus = { cursor: string | null; unsynced: number; error: string | null };

export const createSync = (deps: {
  workspaceId: string;
  get: (path: string) => Promise<ApiResult>;
  refetch: (keys: Set<ListKey>) => void | Promise<void>;
  onStatus: (status: SyncStatus) => void;
}) => {
  let cursor: string | null = null;
  let unsynced = 0;
  let running: Promise<void> | null = null;
  let dirty = false;

  const changes = async (from?: string) => {
    const query = `workspaceId=${encodeURIComponent(deps.workspaceId)}${from ? `&cursor=${encodeURIComponent(from)}` : ""}`;
    const result = await deps.get(`/v1/sync/changes?${query}`);
    if (!result.ok)
      throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.value as { changes: Change[]; cursor: string; hasMore: boolean };
  };

  // Head cursor first, then the lists: replaying from it converges (§12.3).
  const bootstrap = async () => {
    const head = (await changes()).cursor;
    await deps.refetch(new Set(allLists));
    cursor = head;
  };

  const pullOnce = async () => {
    if (cursor === null) return bootstrap();
    const keys = new Set<ListKey>();
    let nextCursor = cursor;
    for (;;) {
      let page;
      try {
        page = await changes(nextCursor);
      } catch (error) {
        if ((error as { code?: string }).code !== "CURSOR_EXPIRED") throw error;
        cursor = null;
        return bootstrap();
      }
      nextCursor = page.cursor;
      for (const key of refetchFor(page.changes)) keys.add(key);
      if (!page.hasMore) break;
    }
    if (keys.size > 0) await deps.refetch(keys);
    cursor = nextCursor;
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
