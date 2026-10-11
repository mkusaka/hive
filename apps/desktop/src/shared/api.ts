// The typed surface the preload exposes as `window.hive` (docs/architecture.md §20.1, §21). Types only.
import type {
  AgentSend,
  ApprovalResolve,
  ChannelJoin,
  ChannelLeave,
  ChannelUpdate,
  commandEnvelope,
  DmOpen,
  JobCancel,
  MemoryWrite,
  MessagePost,
  RoutineCreate,
  RoutineDelete,
  RoutinePause,
  RoutineResume,
  RoutineRun,
  RoutineRotateSecret,
  RoutineUpdate,
  SidebarUpdate,
  RunLinkTask,
  WorkspaceCreate,
} from "@hive/contracts";
import type * as v from "valibot";

/** IPC never throws: an error thrown in `ipcMain.handle` reaches the renderer with its message only. */
export type ApiResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string; body?: unknown } };

/** The commands the UI sends today: messaging, Job cancellation, approval, memory, Channel, DM, routine, sidebar, external Run task linking and workspace creation (Welcome). */
export type UiCommand = v.InferInput<
  ReturnType<
    typeof commandEnvelope<
      v.VariantSchema<
        "type",
        [
          typeof MessagePost,
          typeof AgentSend,
          typeof JobCancel,
          typeof ApprovalResolve,
          typeof MemoryWrite,
          typeof ChannelUpdate,
          typeof ChannelJoin,
          typeof ChannelLeave,
          typeof DmOpen,
          typeof RoutineCreate,
          typeof RoutineUpdate,
          typeof RoutineDelete,
          typeof RoutinePause,
          typeof RoutineResume,
          typeof RoutineRun,
          typeof RoutineRotateSecret,
          typeof RunLinkTask,
          typeof SidebarUpdate,
          typeof WorkspaceCreate,
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
 * Never contains the Access assertion or the device token. An empty `apiUrl` / `workspaceId`, `loginRequired` or
 * `deviceRegistered: false` puts the Welcome screen on that step. `connection` is the Realtime state when the reply
 * was sent (later changes arrive as `RealtimeEvent`s).
 */
export type HiveConfig = {
  apiUrl: string;
  workspaceId: string;
  /** Why the Welcome screen cannot go on (e.g. `GET /v1/me` failed), else null. */
  problem: string | null;
  /** No usable Access grant in the shared credentials file: show Sign in. */
  loginRequired: boolean;
  /** The credentials file has a device token for this PC. */
  deviceRegistered: boolean;
  /** Signed in without a `workspaceId`: the user's Workspaces from `GET /v1/me`; otherwise empty. */
  workspaces: { id: string; name: string }[];
  /** `os.hostname()`, the default name for "Set up this PC". */
  hostname: string;
  /** `HIVE_API_URL`, prefilled in the first-run API URL field. */
  defaultApiUrl: string;
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
  /** Writes `apiUrl` / `workspaceId` to the shared credentials file. */
  setConfig(patch: { apiUrl?: string; workspaceId?: string }): Promise<ApiResult>;
  login(): Promise<{ ok: true } | { ok: false; message: string }>;
  /** `hive logout`: drops the OAuth grant; the device token and the service stay. */
  logout(): Promise<ApiResult>;
  /** `hive device register --name <name>`, then the executor service reconcile. Never returns the token. */
  registerDevice(input: { name: string }): Promise<ApiResult>;
};

export const channels = {
  get: "hive:api.get",
  command: "hive:api.command",
  config: "hive:config",
  configSet: "hive:config.set",
  login: "hive:login",
  logout: "hive:logout",
  deviceRegister: "hive:device.register",
  realtime: "hive:realtime",
  executorStatus: "hive:executor.status",
  executorStart: "hive:executor.start",
  executorStop: "hive:executor.stop",
} as const;
