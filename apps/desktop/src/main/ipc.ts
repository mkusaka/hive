// IPC argument validation and the HTTP calls behind it. No `electron` import, so it runs under vitest.
import { CliError, type Client } from "@hive/cli/client";
import * as service from "@hive/cli/service";
import {
  AgentSend,
  ApprovalResolve,
  BotUpdate,
  ChannelJoin,
  ChannelLeave,
  ChannelMemberAdd,
  ChannelMemberRemove,
  ChannelMemberUpdate,
  ChannelUpdate,
  commandEnvelope,
  DmOpen,
  JobCancel,
  MemoryWrite,
  MessagePost,
  parse,
  RoutineCreate,
  RoutineDelete,
  RoutinePause,
  RoutineResume,
  RoutineRun,
  RoutineRotateSecret,
  RoutineUpdate,
  RunLinkTask,
  SidebarUpdate,
  WorkspaceCreate,
} from "@hive/contracts";
import * as v from "valibot";
import type { ApiResult } from "../shared/api.ts";

/**
 * A `/v1/...` path with an optional query. Path segments allow no `.` or `%`, so neither a literal nor an
 * encoded `..` can climb out of `/v1/`; `..` is rejected anywhere anyway. The query allows URLSearchParams output
 * (`+` for a space, `*`).
 */
export const ApiPath = v.pipe(
  v.string(),
  v.maxLength(2048),
  v.regex(/^\/v1(\/[\w-]+)+(\?[\w\-=&%.~+*]*)?$/, "must be a /v1/... path"),
  v.check((path) => !path.includes(".."), "must not contain .."),
);

export const UiCommandSchema = commandEnvelope(
  v.variant("type", [
    MessagePost,
    AgentSend,
    JobCancel,
    ApprovalResolve,
    MemoryWrite,
    ChannelUpdate,
    ChannelJoin,
    ChannelLeave,
    ChannelMemberAdd,
    ChannelMemberUpdate,
    ChannelMemberRemove,
    DmOpen,
    BotUpdate,
    RoutineCreate,
    RoutineUpdate,
    RoutineDelete,
    RoutinePause,
    RoutineResume,
    RoutineRun,
    RoutineRotateSecret,
    RunLinkTask,
    SidebarUpdate,
    WorkspaceCreate,
  ]),
);

const invalid = (issues: string[]): ApiResult => ({
  ok: false,
  error: { code: "INVALID_ARGS", message: issues.join("; ") },
});

/** Maps the CLI client's `CliError` (which carries the `ApiError` code and body) to a result. */
export const toResult = async (
  call: () => Promise<Record<string, unknown>>,
): Promise<ApiResult> => {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (error instanceof CliError) {
      return { ok: false, error: { code: error.code, message: error.message, body: error.body } };
    }
    return { ok: false, error: { code: "INTERNAL", message: String(error) } };
  }
};

export const handlers = (client: Client) => ({
  get: (path: unknown) => {
    const parsed = parse(ApiPath, path);
    return parsed.ok
      ? toResult(() => client.get(parsed.value))
      : Promise.resolve(invalid(parsed.issues));
  },
  command: (envelope: unknown) => {
    const parsed = parse(UiCommandSchema, envelope);
    if (!parsed.ok) return Promise.resolve(invalid(parsed.issues));
    const { command, ...rest } = parsed.value;
    return toResult(() => client.command(rest, command));
  },
});

/** `executor.start` input: the CLI's `--provider` and `--concurrency` (1..64). */
export const ExecutorStart = v.strictObject({
  provider: v.picklist(["fake", "claude", "codex"]),
  concurrency: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(64)),
});

const notRegistered = "this device is not registered: run `hive device register`";

/**
 * The executor launchd service (README "Executor service"). `program` is the headless Electron argv prefix; the plist's
 * environment values never leave main (status returns names and argv only).
 */
export const executorHandlers = (program: string[], registered: () => Promise<boolean>) => ({
  status: () =>
    toResult(async () => ({ ...(await service.status()), registered: await registered() })),
  /** Installs (or replaces) the service with this provider / concurrency. */
  start: (input: unknown) => {
    const parsed = parse(ExecutorStart, input);
    if (!parsed.ok) return Promise.resolve(invalid(parsed.issues));
    return toResult(async () => {
      if (!(await registered())) throw new CliError("UNAUTHENTICATED", 3, notRegistered);
      return service.install({ program, ...parsed.value });
    });
  },
  /** `launchctl bootout` only: the plist stays, so the next app start brings the service back. */
  stop: () => toResult(service.stop),
});

/** An https API URL, or http://localhost for `wrangler dev`. */
const ApiUrl = v.pipe(
  v.string(),
  v.trim(),
  v.maxLength(2048),
  v.check((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost")
      );
    } catch {
      return false;
    }
  }, "must be an https URL (or http://localhost)"),
);

/** `config.set` input: what the Welcome screen saves to the shared credentials file. */
export const ConfigSet = v.pipe(
  v.strictObject({
    apiUrl: v.optional(ApiUrl),
    workspaceId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
  }),
  v.check((patch) => Object.keys(patch).length > 0, "nothing to set"),
);

export const DeviceRegisterInput = v.strictObject({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
});

/**
 * Welcome / sign-out IPC. `cli` runs a `hive` command (the CLI's own `run` + deps in main, a fake in tests) and returns
 * its exit code and stderr lines; stdout is dropped because `device register` prints the device token.
 */
export const setupHandlers = (opts: {
  save(patch: v.InferOutput<typeof ConfigSet>): Promise<unknown>;
  cli(argv: string[]): Promise<{ code: number; stderr: string[] }>;
  os: string;
  agentVersion: string;
  /** The executor service reconcile after a registration. */
  reconcile(): Promise<void>;
}) => {
  const cli = async (argv: string[]) => {
    const { code, stderr } = await opts.cli(argv);
    if (code !== 0) throw new CliError("COMMAND_FAILED", code, stderr.join("\n"));
    return {};
  };
  return {
    configSet: (input: unknown) => {
      const parsed = parse(ConfigSet, input);
      if (!parsed.ok) return Promise.resolve(invalid(parsed.issues));
      return toResult(async () => (await opts.save(parsed.value), {}));
    },
    logout: () => toResult(() => cli(["logout"])),
    deviceRegister: (input: unknown) => {
      const parsed = parse(DeviceRegisterInput, input);
      if (!parsed.ok) return Promise.resolve(invalid(parsed.issues));
      const { name } = parsed.value;
      return toResult(async () => {
        await cli([
          "device",
          "register",
          "--name",
          name,
          "--os",
          opts.os,
          "--agent-version",
          opts.agentVersion,
        ]);
        await opts.reconcile();
        return {};
      });
    },
  };
};
