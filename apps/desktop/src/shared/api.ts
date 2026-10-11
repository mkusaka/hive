// The typed surface the preload exposes as `window.hive` (docs/architecture.md §20.1, §21). Types only.
import type { AgentSend, commandEnvelope } from "@hive/contracts";
import type * as v from "valibot";

/** IPC never throws: an error thrown in `ipcMain.handle` reaches the renderer with its message only. */
export type ApiResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string; body?: unknown } };

/** The only command the UI sends today. */
export type UiCommand = v.InferInput<ReturnType<typeof commandEnvelope<typeof AgentSend>>>;

export type RealtimeEvent =
  | { type: "connection"; state: "connected" | "reconnecting" }
  | { type: "sync.changed"; cursor: string; scopes: string[] };

/**
 * Never contains the Access assertion or the device token. `problem` is set when the app cannot connect;
 * `connection` is the Realtime state when the reply was sent (later changes arrive as `RealtimeEvent`s).
 */
export type HiveConfig = {
  apiUrl: string;
  workspaceId: string;
  problem: string | null;
  connection: "connected" | "reconnecting";
};

export type HiveApi = {
  api: { get(path: string): Promise<ApiResult>; command(envelope: UiCommand): Promise<ApiResult> };
  onRealtime(cb: (event: RealtimeEvent) => void): () => void;
  getConfig(): Promise<HiveConfig>;
};

export const channels = {
  get: "hive:api.get",
  command: "hive:api.command",
  config: "hive:config",
  realtime: "hive:realtime",
} as const;
