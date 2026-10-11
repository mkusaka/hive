// `hive` argv dispatcher (docs/architecture.md §23). I/O, credentials and the executor journal are injected
// by main.ts, so tests drive `run` with fakes.
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { type CloudClient, createCloudClient } from "@hive/executor/cloudClient";
import { CliError, type Client, createClient, type Fetch, invalid } from "./client.ts";
import * as cmd from "./commands.ts";

export type Credentials = {
  apiUrl?: string;
  accessJwt?: string;
  deviceToken?: string;
  workspaceId?: string;
};

export type Deps = {
  fetch: Fetch;
  loadCredentials(): Promise<Credentials>;
  /** Merges `patch` into the credentials file; a device token is also written to `tokenFile`. */
  saveCredentials(patch: Credentials): Promise<{ tokenFile?: string }>;
  /** File contents; `-` is stdin. */
  readInput(path: string): Promise<string>;
  stdout(line: string): void;
  stderr(line: string): void;
  runExecutor(cloud: CloudClient, once: boolean): Promise<unknown>;
  /** Watch interval; 2 s by default. */
  pollMs?: number;
};

type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;
type Ctx = {
  values: Values;
  args: string[];
  deps: Deps;
  creds: Credentials;
  apiUrl(): string;
  client(): Client;
  workspace(): string;
  envelope(workspaceId?: string): cmd.Envelope;
  print(body: unknown): void;
  wait(): cmd.WaitOptions;
};
type Spec = {
  usage: string;
  args?: number;
  options?: ParseArgsOptionsConfig;
  run(ctx: Ctx): Promise<number | void>;
};

const str = { type: "string" } as const;
const flag = { type: "boolean", default: false } as const;
const globals: ParseArgsOptionsConfig = {
  format: { type: "string", default: "text" },
  "api-url": str,
  workspace: str,
  "idempotency-key": str,
  "operation-id": str,
};

const need = (values: Values, name: string) => {
  const value = values[name];
  if (typeof value !== "string" || value === "") throw invalid(`--${name} is required`);
  return value;
};

const exitForJob = (job: cmd.Json) => (job.state === "succeeded" ? 0 : 5);

const specs: Record<string, Spec> = {
  "workspace create": {
    usage: "--id <id> --name <name>",
    options: { id: str, name: str },
    run: async (c) => {
      const id = need(c.values, "id");
      c.print(await cmd.workspaceCreate(c.client(), c.envelope(id), need(c.values, "name")));
      await c.deps.saveCredentials({ apiUrl: c.apiUrl(), workspaceId: id });
    },
  },
  "device register": {
    usage: "--name <name> --os <os> --agent-version <version>",
    options: { name: str, os: str, "agent-version": str },
    run: async (c) => {
      const res = await cmd.deviceRegister(c.client(), c.envelope(), {
        name: need(c.values, "name"),
        os: need(c.values, "os"),
        agentVersion: need(c.values, "agent-version"),
      });
      c.print(res);
      // Returned only once (a replay has `deviceToken: null`), so keep it for `hive executor run`.
      if (typeof res.deviceToken === "string") {
        const saved = await c.deps.saveCredentials({
          apiUrl: c.apiUrl(),
          deviceToken: res.deviceToken,
        });
        c.deps.stderr(`device token saved; executor --token-file ${saved.tokenFile}`);
      }
    },
  },
  "channel create": {
    usage: "--name <name>",
    options: { name: str },
    run: async (c) =>
      c.print(await cmd.channelCreate(c.client(), c.envelope(), need(c.values, "name"))),
  },
  "bot create": {
    usage: "--name <name> [--allowed-device <device-id>]...",
    options: { name: str, "allowed-device": { type: "string", multiple: true } },
    run: async (c) =>
      c.print(
        await cmd.botCreate(
          c.client(),
          c.envelope(),
          need(c.values, "name"),
          c.values["allowed-device"] as string[] | undefined,
        ),
      ),
  },
  "agent send": {
    usage: "<bot-id> --channel <channel-id> --message <text> [--notify] [--wait [--timeout <s>]]",
    args: 1,
    options: { channel: str, message: str, notify: flag, wait: flag, timeout: str },
    run: async (c) => {
      if (c.values.notify && c.values.wait)
        throw invalid("--wait needs a Job; --notify creates none");
      const envelope = c.envelope();
      c.print(
        await cmd.agentSend(c.client(), envelope, {
          botId: c.args[0]!,
          channelId: need(c.values, "channel"),
          text: need(c.values, "message"),
          notify: c.values.notify === true,
        }),
      );
      if (!c.values.wait) return;
      const job = await cmd.waitForOperationJob(c.client(), envelope.operationId, c.wait());
      c.print(job);
      return exitForJob(job);
    },
  },
  "event emit": {
    usage: "<type> [--data-file <path|->] [--subject <kind:id>]",
    args: 1,
    options: { "data-file": str, subject: str },
    run: async (c) => {
      const file = c.values["data-file"];
      let data: unknown = {};
      if (typeof file === "string") {
        const text = await c.deps.readInput(file);
        try {
          data = JSON.parse(text);
        } catch {
          throw invalid("--data-file must contain JSON");
        }
      }
      const subject = c.values.subject as string | undefined;
      const colon = subject?.indexOf(":") ?? -1;
      if (subject !== undefined && colon <= 0) throw invalid("--subject must be <kind>:<id>");
      c.print(
        await cmd.eventEmit(c.client(), c.envelope(), {
          type: c.args[0]!,
          data,
          ...(subject
            ? { subject: { kind: subject.slice(0, colon), id: subject.slice(colon + 1) } }
            : {}),
        }),
      );
    },
  },
  "op get": {
    usage: "<operation-id>",
    args: 1,
    run: async (c) => c.print(await cmd.getOperation(c.client(), c.args[0]!)),
  },
  "job get": {
    usage: "<job-id>",
    args: 1,
    run: async (c) => c.print(await cmd.getJob(c.client(), c.args[0]!)),
  },
  "job watch": {
    usage: "<job-id> [--timeout <s>]",
    args: 1,
    options: { timeout: str },
    run: async (c) => {
      const job = await cmd.watchJob(c.client(), c.args[0]!, c.wait());
      c.print(job);
      return exitForJob(job);
    },
  },
  "channel list": {
    usage: "",
    run: async (c) => c.print(await cmd.listChannels(c.client(), c.workspace())),
  },
  "bot list": {
    usage: "",
    run: async (c) => c.print(await cmd.listBots(c.client(), c.workspace())),
  },
  "device list": {
    usage: "",
    run: async (c) => c.print(await cmd.listDevices(c.client(), c.workspace())),
  },
  "sync changes": {
    usage: "[--cursor <cursor>]",
    options: { cursor: str },
    run: async (c) =>
      c.print(
        await cmd.syncChanges(c.client(), c.workspace(), c.values.cursor as string | undefined),
      ),
  },
  "inbox list": {
    usage: "--bot <bot-id>",
    options: { bot: str },
    run: async (c) => c.print(await cmd.listInbox(c.client(), need(c.values, "bot"))),
  },
  "executor run": {
    usage: "[--once]",
    options: { once: flag },
    run: async (c) => {
      const token = c.creds.deviceToken;
      if (!token)
        throw new CliError("UNAUTHENTICATED", 3, "no deviceToken: run `hive device register`");
      const apiUrl = c.apiUrl();
      const cloud = createCloudClient({ apiUrl, token, fetch: c.deps.fetch });
      // ponytail: no Queue consumer yet and `wrangler dev` fires no cron, so each poll pumps the outbox
      // first (POST /v1/executor/pump). Drop this once Queues route events.
      const pumping: CloudClient = {
        ...cloud,
        listQueuedJobs: async (limit) => {
          await c.deps
            .fetch(new URL("/v1/executor/pump", apiUrl), {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
            })
            .catch(() => undefined);
          return cloud.listQueuedJobs(limit);
        },
      };
      c.print((await c.deps.runExecutor(pumping, c.values.once === true)) ?? { claimed: null });
    },
  },
};

const usage = () =>
  ["usage: hive <command> [options] [--format json|text] [--api-url <url>] [--workspace <id>]", ""]
    .concat(Object.entries(specs).map(([name, spec]) => `  hive ${name} ${spec.usage}`))
    .join("\n");

const line = (value: unknown) =>
  typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);

/** Runs one `hive` invocation and returns its exit code (§23). */
export const run = async (argv: string[], deps: Deps): Promise<number> => {
  const [group, action, ...rest] = argv;
  const spec = specs[`${group} ${action}`];
  if (!spec) {
    deps.stderr(usage());
    return 2;
  }
  let json = false;
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: rest,
        options: { ...globals, ...spec.options },
        allowPositionals: true,
      });
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : String(error));
    }
    const { values, positionals } = parsed;
    if (values.format !== "json" && values.format !== "text")
      throw invalid("--format must be json or text");
    json = values.format === "json";
    if (positionals.length !== (spec.args ?? 0))
      throw invalid(`usage: hive ${group} ${action} ${spec.usage}`);
    const creds = await deps.loadCredentials();
    const apiUrl = () => {
      const url = (values["api-url"] as string | undefined) ?? creds.apiUrl;
      if (!url) throw invalid("--api-url is required (or apiUrl in the credentials file)");
      return url;
    };
    const workspace = () => {
      const id = (values.workspace as string | undefined) ?? creds.workspaceId;
      if (!id) throw invalid("--workspace is required (or run `hive workspace create`)");
      return id;
    };
    const timeout = Number(values.timeout ?? 300);
    if (!(timeout > 0)) throw invalid("--timeout must be a positive number of seconds");
    const code = await spec.run({
      values,
      args: positionals,
      deps,
      creds,
      apiUrl,
      client: () =>
        createClient({ apiUrl: apiUrl(), accessJwt: creds.accessJwt, fetch: deps.fetch }),
      workspace,
      envelope: (workspaceId = workspace()) => ({
        operationId: (values["operation-id"] as string | undefined) ?? crypto.randomUUID(),
        idempotencyKey: (values["idempotency-key"] as string | undefined) ?? crypto.randomUUID(),
        workspaceId,
      }),
      print: (body) => {
        if (json) return deps.stdout(JSON.stringify(body));
        for (const [key, value] of Object.entries(body as cmd.Json))
          deps.stdout(`${key}: ${line(value)}`);
      },
      wait: () => ({
        deadline: Date.now() + timeout * 1000,
        pollMs: deps.pollMs ?? 2000,
        onState: (state) => deps.stderr(`job state: ${state}`),
      }),
    });
    return code ?? 0;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    if (json && error.body !== undefined) deps.stdout(JSON.stringify(error.body));
    deps.stderr(`error: ${error.code}: ${error.message}`);
    return error.exitCode;
  }
};
