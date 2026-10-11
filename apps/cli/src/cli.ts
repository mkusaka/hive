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
  runExecutor(cloud: CloudClient, once: boolean, provider: Provider): Promise<unknown>;
  /**
   * Maps an environment name to a local checkout root in the executor's `environments.json` (§10.1). Rejects a path
   * that is not an existing directory; returns the absolute path stored.
   */
  saveEnvironment(name: string, path: string): Promise<string>;
  /** Watch interval; 2 s by default. */
  pollMs?: number;
};

export type Provider = "fake" | "claude";

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

/** `--tools Read=allow,Bash=ask` (+ `--cwd-mode`) → a ToolPolicy; the server validates names and modes. */
const toolPolicy = (values: Values, current?: cmd.Json) => {
  const { tools, "cwd-mode": cwdMode } = values;
  if (tools === undefined && cwdMode === undefined) return undefined;
  const parsed =
    typeof tools === "string"
      ? Object.fromEntries(
          tools
            .split(",")
            .filter(Boolean)
            .map((pair) => {
              const [name, mode, ...rest] = pair.split("=");
              if (!name || !mode || rest.length > 0) throw invalid(`--tools: bad entry ${pair}`);
              return [name.trim(), mode.trim()];
            }),
        )
      : (current?.tools ?? {});
  return { tools: parsed, cwdMode: cwdMode ?? current?.cwdMode ?? "run_scratch" };
};

const instructionsOf = async (c: Ctx) => {
  const { instructions, "instructions-file": file } = c.values;
  if (instructions !== undefined && file !== undefined)
    throw invalid("use --instructions or --instructions-file, not both");
  return typeof file === "string" ? c.deps.readInput(file) : (instructions as string | undefined);
};

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
    usage:
      "--name <name> [--allowed-device <device-id>]... [--instructions <text> | --instructions-file <path|->] [--tools <Tool=allow|ask|deny,...>] [--cwd-mode run_scratch|environment] [--environment <name>]",
    options: {
      name: str,
      "allowed-device": { type: "string", multiple: true },
      instructions: str,
      "instructions-file": str,
      tools: str,
      "cwd-mode": str,
      environment: str,
    },
    run: async (c) => {
      const instructions = await instructionsOf(c);
      c.print(
        await cmd.botCreate(
          c.client(),
          c.envelope(),
          need(c.values, "name"),
          c.values["allowed-device"] as string[] | undefined,
          instructions,
          {
            toolPolicy: toolPolicy(c.values),
            environment: c.values.environment as string | undefined,
          },
        ),
      );
    },
  },
  "bot update": {
    usage:
      "<bot-id> [--instructions <text> | --instructions-file <path|->] [--tools <Tool=allow|ask|deny,...>] [--cwd-mode run_scratch|environment]",
    args: 1,
    options: { instructions: str, "instructions-file": str, tools: str, "cwd-mode": str },
    run: async (c) => {
      const instructions = await instructionsOf(c);
      const botId = c.args[0]!;
      // `--tools` replaces the tool list; an omitted part keeps the Bot's current one.
      const current =
        c.values.tools === undefined && c.values["cwd-mode"] === undefined
          ? undefined
          : (
              (await cmd.listBots(c.client(), c.workspace())) as {
                bots: { id: string; toolPolicy: cmd.Json }[];
              }
            ).bots.find((b) => b.id === botId)?.toolPolicy;
      const policy = toolPolicy(c.values, current);
      if (instructions === undefined && policy === undefined)
        throw invalid("nothing to update: give --instructions(-file), --tools or --cwd-mode");
      c.print(
        await cmd.botUpdate(c.client(), c.envelope(), botId, {
          ...(instructions === undefined ? {} : { instructions }),
          ...(policy ? { toolPolicy: policy } : {}),
        }),
      );
    },
  },
  "device env": {
    usage: "add --name <name> --repo <url> --path <local checkout root>",
    args: 1,
    options: { name: str, repo: str, path: str },
    run: async (c) => {
      if (c.args[0] !== "add") throw invalid("usage: hive device env add --name --repo --path");
      const deviceId = c.creds.deviceToken?.split(".")[0];
      if (!deviceId)
        throw new CliError("UNAUTHENTICATED", 3, "no deviceToken: run `hive device register`");
      const name = need(c.values, "name");
      // Local first: the checkout root never leaves this device, the cloud gets name + repository only.
      const path = await c.deps.saveEnvironment(name, need(c.values, "path"));
      c.print({
        ...(await cmd.deviceEnvironmentRegister(c.client(), c.envelope(), {
          deviceId,
          name,
          repository: need(c.values, "repo"),
        })),
        localPath: path,
      });
    },
  },
  "approval list": {
    usage: "[--state pending|approved|denied|expired]",
    options: { state: { type: "string", default: "pending" } },
    run: async (c) =>
      c.print(await cmd.listApprovals(c.client(), c.workspace(), c.values.state as string)),
  },
  "approval resolve": {
    usage: "<approval-id> (--allow | --deny) [--reason <text>]",
    args: 1,
    options: { allow: flag, deny: flag, reason: str },
    run: async (c) => {
      if (c.values.allow === c.values.deny)
        throw invalid("exactly one of --allow, --deny is required");
      c.print(
        await cmd.approvalResolve(
          c.client(),
          c.envelope(),
          c.args[0]!,
          c.values.allow ? "allow" : "deny",
          c.values.reason as string | undefined,
        ),
      );
    },
  },
  "approval watch": {
    usage: "[--timeout <s>]",
    options: { timeout: str },
    run: async (c) =>
      cmd.watchApprovals(c.client(), c.workspace(), { ...c.wait(), onApproval: c.print }),
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
  "channel messages": {
    usage: "<channel-id>",
    args: 1,
    run: async (c) => c.print(await cmd.listMessages(c.client(), c.workspace(), c.args[0]!)),
  },
  "bot list": {
    usage: "",
    run: async (c) => c.print(await cmd.listBots(c.client(), c.workspace())),
  },
  "bot conversations": {
    usage: "",
    run: async (c) => c.print(await cmd.listBotConversations(c.client(), c.workspace())),
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
  "project create": {
    usage: "--key <KEY> --name <name>",
    options: { key: str, name: str },
    run: async (c) =>
      c.print(
        await cmd.projectCreate(c.client(), c.envelope(), {
          key: need(c.values, "key"),
          name: need(c.values, "name"),
        }),
      ),
  },
  "task create": {
    usage: "(--project <key> | --parent <task>) --title <title> [--priority <n>]",
    options: { project: str, parent: str, title: str, priority: str },
    run: async (c) => {
      const priority = c.values.priority === undefined ? undefined : Number(c.values.priority);
      if (priority !== undefined && !Number.isInteger(priority))
        throw invalid("--priority must be an integer");
      const parent = c.values.parent as string | undefined;
      c.print(
        await cmd.taskCreate(c.client(), c.envelope(), {
          projectKey: c.values.project as string | undefined,
          parentTaskId: parent && (await cmd.findTask(c.client(), c.workspace(), parent)).id,
          title: need(c.values, "title"),
          priority,
        }),
      );
    },
  },
  "task list": {
    usage: "[--project <key>] [--status <status>]",
    options: { project: str, status: str },
    run: async (c) =>
      c.print(
        await cmd.listTasks(c.client(), c.workspace(), {
          projectKey: c.values.project as string | undefined,
          status: c.values.status as string | undefined,
        }),
      ),
  },
  "task plan": {
    usage: "<task> --after <task>...",
    args: 1,
    options: { after: { type: "string", multiple: true } },
    run: async (c) => {
      const after = (c.values.after as string[] | undefined) ?? [];
      if (after.length === 0) throw invalid("--after is required");
      const ws = c.workspace();
      const task = await cmd.findTask(c.client(), ws, c.args[0]!);
      const ids = await Promise.all(
        after.map(async (ref) => (await cmd.findTask(c.client(), ws, ref)).id),
      );
      c.print(await cmd.taskPlan(c.client(), c.envelope(), task, ids));
    },
  },
  "task assign": {
    usage: "<task> (--bot <bot-id> | --user <user-id> | --none)",
    args: 1,
    options: { bot: str, user: str, none: flag },
    run: async (c) => {
      const { bot, user, none } = c.values;
      if ([bot, user, none || undefined].filter((v) => v !== undefined).length !== 1)
        throw invalid("exactly one of --bot, --user, --none is required");
      const assignee = none
        ? null
        : bot
          ? { kind: "bot" as const, id: bot as string }
          : { kind: "user" as const, id: user as string };
      const task = await cmd.findTask(c.client(), c.workspace(), c.args[0]!);
      c.print(await cmd.taskAssign(c.client(), c.envelope(), task, assignee));
    },
  },
  "task complete": {
    usage: "<task>",
    args: 1,
    run: async (c) => {
      const task = await cmd.findTask(c.client(), c.workspace(), c.args[0]!);
      c.print(await cmd.taskComplete(c.client(), c.envelope(), task));
    },
  },
  "job start": {
    usage: "--task <task> --bot <bot-id> [--device <device-id>] [--wait [--timeout <s>]]",
    options: { task: str, bot: str, device: str, wait: flag, timeout: str },
    run: async (c) => {
      const task = await cmd.findTask(c.client(), c.workspace(), need(c.values, "task"));
      const started = await cmd.jobStart(c.client(), c.envelope(), {
        taskId: task.id,
        botId: need(c.values, "bot"),
        deviceId: c.values.device as string | undefined,
      });
      c.print(started);
      if (!c.values.wait) return;
      const job = await cmd.watchJob(c.client(), String(started.jobId), c.wait());
      c.print(job);
      return exitForJob(job);
    },
  },
  "subscription create": {
    usage: "--file <path|->",
    options: { file: str },
    run: async (c) => {
      let spec: unknown;
      try {
        spec = JSON.parse(await c.deps.readInput(need(c.values, "file")));
      } catch {
        throw invalid("--file must contain a JSON object");
      }
      if (typeof spec !== "object" || spec === null || Array.isArray(spec))
        throw invalid("--file must contain a JSON object");
      c.print(await cmd.subscriptionCreate(c.client(), c.envelope(), spec as cmd.Json));
    },
  },
  "subscription list": {
    usage: "",
    run: async (c) => c.print(await cmd.listSubscriptions(c.client(), c.workspace())),
  },
  "subscription pause": {
    usage: "<subscription-id>",
    args: 1,
    run: async (c) => c.print(await cmd.subscriptionPause(c.client(), c.envelope(), c.args[0]!)),
  },
  "subscription test": {
    usage: "<subscription-id> [--limit <n>]",
    args: 1,
    options: { limit: str },
    run: async (c) => {
      const limit = c.values.limit === undefined ? undefined : Number(c.values.limit);
      if (limit !== undefined && !Number.isInteger(limit))
        throw invalid("--limit must be an integer");
      c.print(await cmd.subscriptionTest(c.client(), c.envelope(), c.args[0]!, limit));
    },
  },
  "integration create": {
    usage: "--kind github|slack [--external-account-id <id>]",
    options: { kind: str, "external-account-id": str },
    run: async (c) =>
      c.print(
        await cmd.integrationCreate(c.client(), c.envelope(), {
          kind: need(c.values, "kind"),
          externalAccountId: c.values["external-account-id"] as string | undefined,
        }),
      ),
  },
  "job cancel": {
    usage: "<job-id>",
    args: 1,
    run: async (c) => c.print(await cmd.jobCancel(c.client(), c.envelope(), c.args[0]!)),
  },
  "job resolve": {
    usage: "<job-id> (--retry | --cancel | --mark-failed)",
    args: 1,
    options: { retry: flag, cancel: flag, "mark-failed": flag },
    run: async (c) => {
      const actions = (["retry", "cancel", "mark-failed"] as const).filter((a) => c.values[a]);
      if (actions.length !== 1)
        throw invalid("exactly one of --retry, --cancel, --mark-failed is required");
      const action = actions[0] === "mark-failed" ? "mark_failed" : actions[0]!;
      c.print(await cmd.jobResolve(c.client(), c.envelope(), c.args[0]!, action));
    },
  },
  "routine create": {
    usage:
      '--bot <bot-id> --name <name> --cron "<m h dom mon dow>" --input <text> [--tz <zone>] [--channel <channel-id>] [--misfire skip|coalesce]',
    options: { bot: str, name: str, cron: str, input: str, tz: str, channel: str, misfire: str },
    run: async (c) => {
      const channel = c.values.channel as string | undefined;
      c.print(
        await cmd.routineCreate(c.client(), c.envelope(), {
          botId: need(c.values, "bot"),
          name: need(c.values, "name"),
          cron: need(c.values, "cron"),
          // Default: this machine's zone.
          timezone:
            (c.values.tz as string | undefined) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          inputText: need(c.values, "input"),
          conversationId:
            channel && (await cmd.findConversation(c.client(), c.workspace(), channel)),
          misfire: c.values.misfire as string | undefined,
        }),
      );
    },
  },
  "routine list": {
    usage: "",
    run: async (c) => c.print(await cmd.listRoutines(c.client(), c.workspace())),
  },
  ...Object.fromEntries(
    (["run", "pause", "resume"] as const).map((action) => [
      `routine ${action}`,
      {
        usage: "<routine-id>",
        args: 1,
        run: async (c: Ctx) =>
          c.print(
            await cmd.routineAction(c.client(), c.envelope(), `routine.${action}`, c.args[0]!),
          ),
      },
    ]),
  ),
  "executor run": {
    usage: "[--once] [--provider fake|claude]",
    options: { once: flag, provider: { type: "string", default: "fake" } },
    run: async (c) => {
      const provider = c.values.provider;
      if (provider !== "fake" && provider !== "claude")
        throw invalid("--provider must be fake or claude");
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
      c.print(
        (await c.deps.runExecutor(pumping, c.values.once === true, provider)) ?? { claimed: null },
      );
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
