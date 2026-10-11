// The typed surface the preload exposes as `window.hive` (docs/architecture.md §20.1, §21). Types only.
import type {
  AgentSend,
  ApprovalResolve,
  commandEnvelope,
  JobCancel,
  MemoryWrite,
  RoutinePause,
  RoutineResume,
  RoutineRun,
} from "@hive/contracts";
import type * as v from "valibot";

/** IPC never throws: an error thrown in `ipcMain.handle` reaches the renderer with its message only. */
export type ApiResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string; body?: unknown } };

/** The commands the UI sends today: agent.send, job.cancel, approval.resolve, memory.write and routine pause / resume / run. */
export type UiCommand = v.InferInput<
  ReturnType<
    typeof commandEnvelope<
      v.VariantSchema<
        "type",
        [
          typeof AgentSend,
          typeof JobCancel,
          typeof ApprovalResolve,
          typeof MemoryWrite,
          typeof RoutinePause,
          typeof RoutineResume,
          typeof RoutineRun,
        ],
        undefined
      >
    >
  >
>;

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
  /** No usable Access grant in the shared credentials file: show the Login button. */
  loginRequired: boolean;
  connection: "connected" | "reconnecting";
  /** Dev only (`HIVE_OPEN_BOT`, unpackaged app): the Bot whose panel opens at start, for screenshots. */
  openBot?: string;
};

export type ExecutorProvider = "fake" | "claude" | "codex";

export type HiveApi = {
  api: { get(path: string): Promise<ApiResult>; command(envelope: UiCommand): Promise<ApiResult> };
  /** The executor launchd service: status (with `registered`), start (= install with these options), stop. */
  executor: {
    status(): Promise<ApiResult>;
    start(input: { provider: ExecutorProvider; concurrency: number }): Promise<ApiResult>;
    stop(): Promise<ApiResult>;
  };
  onRealtime(cb: (event: RealtimeEvent) => void): () => void;
  getConfig(): Promise<HiveConfig>;
  login(): Promise<{ ok: true } | { ok: false; message: string }>;
};

export const channels = {
  get: "hive:api.get",
  command: "hive:api.command",
  config: "hive:config",
  login: "hive:login",
  realtime: "hive:realtime",
  executorStatus: "hive:executor.status",
  executorStart: "hive:executor.start",
  executorStop: "hive:executor.stop",
} as const;
