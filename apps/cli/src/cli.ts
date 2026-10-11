// `hive` argv dispatcher (docs/architecture.md §23). I/O, credentials and the executor journal are injected
// by main.ts, so tests drive `run` with fakes.
import { fileURLToPath } from "node:url";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { FilterExpression, parse } from "@hive/contracts";
import { parseConcurrency } from "@hive/executor/capabilities";
import {
  type CloudClient,
  createCloudClient,
  serviceTokenHeaders,
} from "@hive/executor/cloudClient";
import { accessTokens, login, type OAuthToken, type OpenBrowser } from "./accessLogin.ts";
import { CliError, type Client, createClient, type Fetch, invalid } from "./client.ts";
import * as cmd from "./commands.ts";
import { uploadFile } from "./attachments.ts";

export type Credentials = {
  apiUrl?: string;
  accessJwt?: string;
  deviceToken?: string;
  workspaceId?: string;
  /** Managed OAuth grant from `hive login`. */
  oauth?: OAuthToken;
  /** This device's Access Service Token for `executor run` (env CF_ACCESS_CLIENT_ID / _SECRET override). */
  accessClientId?: string;
  accessClientSecret?: string;
};

export type Deps = {
  fetch: Fetch;
  loadCredentials(): Promise<Credentials>;
  /** Merges `patch` into the credentials file; a device token is also written to `tokenFile`. */
  saveCredentials(patch: Credentials): Promise<{ tokenFile?: string }>;
  /** `hive login` and a re-login after `invalid_grant`. */
  openBrowser: OpenBrowser;
  /** Text input, including `-` for stdin. */
  readInput(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  stdout(line: string): void;
  stderr(line: string): void;
  /** `concurrency`: background Runs at once, also reported as the device's capacity. */
  runExecutor(
    cloud: CloudClient,
    once: boolean,
    provider: Provider,
    concurrency: number,
  ): Promise<unknown>;
  /**
   * Maps an environment name to a local checkout root in the executor's `environments.json` (§10.1). Rejects a path
   * that is not an existing directory; returns the absolute path stored.
   */
  saveEnvironment(name: string, path: string): Promise<string>;
  loadCollectConfig(): Promise<{ enabled: boolean }>;
  saveCollectConfig(enabled: boolean): Promise<void>;
  runCollector(
    cloud: CloudClient,
    options: { sinceMs?: number; dryRun?: boolean },
  ): Promise<{ files: number; uploaded: number; dryRun: boolean }>;
  /** Watch interval; 2 s by default. */
  pollMs?: number;
};

export type Provider = "fake" | "claude" | "codex";

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

const duration = (value: string) => {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(value);
  if (!match) throw invalid("--since must be a duration such as 30m or 1h");
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
    match[2]!
  ]!;
  return Number(match[1]) * unit;
};
const exitForJob = (job: cmd.Json) => (job.state === "succeeded" ? 0 : 5);

/** `--tools Read=allow,Bash=ask` (+ `--cwd-mode`) → a ToolPolicy; the server validates names and modes. */
/** `Name=mode,...` for `--tools` / `--effects`. */
const modes = (option: string, value: string) =>
  Object.fromEntries(
    value
      .split(",")
      .filter(Boolean)
      .map((pair) => {
        const [name, mode, ...rest] = pair.split("=");
        if (!name || !mode || rest.length > 0) throw invalid(`--${option}: bad entry ${pair}`);
        return [name.trim(), mode.trim()];
      }),
  );

const manageFlags: Record<string, true> = {
  subscriptions: true,
  routines: true,
  channels: true,
  bots: true,
};

const managePolicy = (value: unknown, current?: cmd.Json) => {
  const currentManage = current?.manage;
  const existing =
    typeof currentManage === "object" && currentManage !== null && !Array.isArray(currentManage)
      ? currentManage
      : undefined;
  if (value === undefined) return existing;
  if (typeof value !== "string" || value === "") throw invalid("--manage is required");
  const change = Object.fromEntries(
    value.split(",").map((pair) => {
      const [name, enabled, ...rest] = pair.split("=");
      if (
        !name ||
        !manageFlags[name.trim()] ||
        (enabled !== "true" && enabled !== "false") ||
        rest.length > 0
      )
        throw invalid(`--manage: bad entry ${pair}`);
      return [name.trim(), enabled === "true"];
    }),
  );
  return { ...existing, ...change };
};

/** `--tools` / `--effects` replace their list; an omitted part keeps the Bot's own. */
const toolPolicy = (values: Values, current?: cmd.Json) => {
  const { tools, effects, "cwd-mode": cwdMode } = values;
  if (
    tools === undefined &&
    effects === undefined &&
    cwdMode === undefined &&
    values.manage === undefined
  )
    return undefined;
  const manage = managePolicy(values.manage, current);
  const currentEffects = current?.effects;
  const effectModes =
    typeof effects === "string"
      ? modes("effects", effects)
      : typeof currentEffects === "object" &&
          currentEffects !== null &&
          !Array.isArray(currentEffects)
        ? currentEffects
        : undefined;
  return {
    tools: typeof tools === "string" ? modes("tools", tools) : (current?.tools ?? {}),
    cwdMode: cwdMode ?? current?.cwdMode ?? "run_scratch",
    ...(effectModes ? { effects: effectModes } : {}),
    ...(manage ? { manage } : {}),
  };
};

const list = (value: unknown) =>
  typeof value === "string"
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : undefined;

const bool = { type: "boolean" } as const;
const placementOptions: ParseArgsOptionsConfig = {
  "allowed-device": { type: "string", multiple: true },
  allowed: str,
  preferred: str,
  mode: str,
  capabilities: str,
  environment: str,
  overflow: bool,
  "no-overflow": bool,
  fallback: bool,
  "no-fallback": bool,
};
const placementUsage =
  "[--mode any|preferred|pinned] [--preferred <id,...>] [--allowed <id,...>] [--allowed-device <id>]... [--overflow|--no-overflow] [--fallback|--no-fallback] [--capabilities <name,...>] [--environment <name>]";

/** Placement flags (§10.2) merged over `current`; undefined when none is given. The server validates the result. */
const placementPolicy = (values: Values, current: cmd.Json = {}) => {
  const allowed = [
    ...((values["allowed-device"] as string[] | undefined) ?? []),
    ...(list(values.allowed) ?? []),
  ];
  const either = (on: string, off: string) => (values[on] ? true : values[off] ? false : undefined);
  const change = Object.entries({
    mode: values.mode,
    allowedDeviceIds: allowed.length > 0 ? allowed : undefined,
    preferredDeviceIds: list(values.preferred),
    requiredCapabilities: list(values.capabilities),
    environmentId: values.environment,
    overflowToFallback: either("overflow", "no-overflow"),
    fallbackOnUnavailable: either("fallback", "no-fallback"),
  }).filter(([, value]) => value !== undefined);
  return change.length === 0 ? undefined : { ...current, ...Object.fromEntries(change) };
};

const instructionsOf = async (c: Ctx) => {
  const { instructions, "instructions-file": file } = c.values;
  if (instructions !== undefined && file !== undefined)
    throw invalid("use --instructions or --instructions-file, not both");
  return typeof file === "string" ? c.deps.readInput(file) : (instructions as string | undefined);
};

const memberTarget = (values: Values) => {
  const userId = values.user;
  const botId = values.bot;
  if (typeof userId === "string" && typeof botId !== "string")
    return { userId: need(values, "user") };
  if (typeof botId === "string" && typeof userId !== "string")
    return { botId: need(values, "bot") };
  throw invalid("exactly one of --user, --bot is required");
};

const memberRoles: Record<string, true> = { owner: true, member: true, viewer: true };

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
    usage:
      "--name <name> --os <os> --agent-version <version> [--access-client-id <id> --access-client-secret-file <path|->]",
    options: {
      name: str,
      os: str,
      "agent-version": str,
      "access-client-id": str,
      "access-client-secret-file": str,
    },
    run: async (c) => {
      const { "access-client-id": clientId, "access-client-secret-file": secretFile } = c.values;
      if ((clientId === undefined) !== (secretFile === undefined))
        throw invalid("--access-client-id and --access-client-secret-file go together");
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
      // The secret comes from a file so it never sits in shell history; it is never printed.
      if (typeof clientId === "string" && typeof secretFile === "string") {
        const accessClientSecret = (await c.deps.readInput(secretFile)).trim();
        if (!accessClientSecret) throw invalid("--access-client-secret-file is empty");
        await c.deps.saveCredentials({ accessClientId: clientId, accessClientSecret });
        c.deps.stderr("Access service token saved for `hive executor run`");
      }
    },
  },
  login: {
    usage: "",
    run: async (c) => {
      const oauth = await login(c.apiUrl(), c.deps.openBrowser).catch((error: unknown) => {
        throw new CliError("UNAUTHENTICATED", 3, `Access login failed: ${String(error)}`);
      });
      await c.deps.saveCredentials({ apiUrl: c.apiUrl(), oauth });
      c.deps.stderr("logged in");
    },
  },
  logout: {
    usage: "",
    run: async (c) => {
      // Local only: the Access session ends when the grant's session duration does.
      await c.deps.saveCredentials({ oauth: undefined });
      c.deps.stderr("logged out");
    },
  },
  "channel create": {
    usage: "--name <name>",
    options: { name: str },
    run: async (c) =>
      c.print(await cmd.channelCreate(c.client(), c.envelope(), need(c.values, "name"))),
  },
  "bot create": {
    usage: `--name <name> [--instructions <text> | --instructions-file <path|->] [--tools <Tool=allow|ask|deny,...>] [--effects <slack.post|github.comment=allow|ask|deny,...>] [--cwd-mode run_scratch|environment] ${placementUsage}`,
    options: {
      name: str,
      instructions: str,
      "instructions-file": str,
      tools: str,
      effects: str,
      "cwd-mode": str,
      ...placementOptions,
    },
    run: async (c) => {
      const instructions = await instructionsOf(c);
      c.print(
        await cmd.botCreate(c.client(), c.envelope(), need(c.values, "name"), instructions, {
          toolPolicy: toolPolicy(c.values),
          placementPolicy: placementPolicy(c.values),
        }),
      );
    },
  },
  "bot update": {
    usage: `<bot-id> [--instructions <text> | --instructions-file <path|->] [--tools <Tool=allow|ask|deny,...>] [--effects <slack.post|github.comment=allow|ask|deny,...>] [--manage subscriptions=true,routines=false,channels=true,bots=false] [--cwd-mode run_scratch|environment] ${placementUsage}`,
    args: 1,
    options: {
      instructions: str,
      "instructions-file": str,
      tools: str,
      effects: str,
      manage: str,
      "cwd-mode": str,
      ...placementOptions,
    },
    run: async (c) => {
      const instructions = await instructionsOf(c);
      const botId = c.args[0]!;
      const needsCurrent =
        toolPolicy(c.values) !== undefined || placementPolicy(c.values) !== undefined;
      const current = needsCurrent ? await cmd.getBot(c.client(), c.workspace(), botId) : undefined;
      const policy = toolPolicy(c.values, current?.toolPolicy);
      const placement = placementPolicy(c.values, current?.placementPolicy);
      if (instructions === undefined && policy === undefined && placement === undefined)
        throw invalid(
          "nothing to update: give --instructions(-file), --tools, --effects, --manage, --cwd-mode or placement flags",
        );
      c.print(
        await cmd.botUpdate(
          c.client(),
          c.envelope(),
          botId,
          {
            ...(instructions === undefined ? {} : { instructions }),
            ...(policy ? { toolPolicy: policy } : {}),
            ...(placement ? { placementPolicy: placement } : {}),
          },
          current,
        ),
      );
    },
  },
  "bot skill add": {
    usage:
      "<bot-id> --name <name> --description <text> (--instructions <text> | --instructions-file <path|->)",
    args: 1,
    options: { name: str, description: str, instructions: str, "instructions-file": str },
    run: async (c) => {
      const instructions = await instructionsOf(c);
      if (instructions === undefined)
        throw invalid("--instructions or --instructions-file is required");
      const botId = c.args[0]!;
      const name = need(c.values, "name");
      const description = need(c.values, "description");
      const current = await cmd.getBot(c.client(), c.workspace(), botId);
      const skills = Array.isArray(current.skills) ? current.skills : [];
      c.print(
        await cmd.botUpdate(
          c.client(),
          c.envelope(),
          botId,
          {
            skills: [...skills, { name, description, instructions }],
          },
          current,
        ),
      );
    },
  },
  "bot skill remove": {
    usage: "<bot-id> --name <name>",
    args: 1,
    options: { name: str },
    run: async (c) => {
      const botId = c.args[0]!;
      const name = need(c.values, "name");
      const current = await cmd.getBot(c.client(), c.workspace(), botId);
      const skills = Array.isArray(current.skills) ? current.skills : [];
      const remaining = skills.filter((skill) => {
        if (typeof skill !== "object" || skill === null || !("name" in skill)) return true;
        return skill.name !== name;
      });
      if (remaining.length === skills.length) throw invalid(`skill not found: ${name}`);
      c.print(await cmd.botUpdate(c.client(), c.envelope(), botId, { skills: remaining }, current));
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
  "effect list": {
    usage: "[--state prepared|approved|executing|succeeded|failed|unknown] [--run <run-id>]",
    options: { state: str, run: str },
    run: async (c) =>
      c.print(
        await cmd.listEffects(c.client(), c.workspace(), {
          state: c.values.state as string | undefined,
          runId: c.values.run as string | undefined,
        }),
      ),
  },
  "effect resolve": {
    usage: "<effect-id> (--succeeded <external-id> [--url <url>] | --failed | --retry)",
    args: 1,
    options: { succeeded: str, url: str, failed: flag, retry: flag },
    run: async (c) => {
      const { succeeded, failed, retry, url } = c.values;
      if ([succeeded !== undefined, failed === true, retry === true].filter(Boolean).length !== 1)
        throw invalid("exactly one of --succeeded <external-id>, --failed, --retry is required");
      c.print(
        await cmd.effectResolve(
          c.client(),
          c.envelope(),
          c.args[0]!,
          succeeded !== undefined
            ? {
                action: "mark_succeeded",
                externalId: succeeded as string,
                ...(url ? { externalUrl: url as string } : {}),
              }
            : { action: failed ? "mark_failed" : "retry" },
        ),
      );
    },
  },
  "audit list": {
    usage: "[--kind <kind,...>] [--since <ISO>] [--cursor <cursor>] [--actor <actor-id>]",
    options: { kind: str, since: str, cursor: str, actor: str },
    run: async (c) =>
      c.print(
        await cmd.listAudit(c.client(), c.workspace(), {
          kind: c.values.kind as string | undefined,
          since: c.values.since as string | undefined,
          cursor: c.values.cursor as string | undefined,
          actor: c.values.actor as string | undefined,
        }),
      ),
  },
  status: {
    usage: "",
    run: async (c) => c.print(await cmd.getStatus(c.client(), c.workspace())),
  },
  search: {
    usage: "<query> [--kinds message,task,memory,run]",
    args: 1,
    options: { kinds: str },
    run: async (c) =>
      c.print(
        await cmd.search(
          c.client(),
          c.workspace(),
          c.args[0]!,
          c.values.kinds as string | undefined,
        ),
      ),
  },
  "memory write": {
    usage:
      "--scope <workspace|channel:<id>|project:<id>|bot:<id>|task:<id>> (--content <text> | --file <path|->)",
    options: { scope: str, content: str, file: str },
    run: async (c) => {
      const { content, file } = c.values;
      if ((content === undefined) === (file === undefined))
        throw invalid("exactly one of --content, --file is required");
      const text = typeof file === "string" ? await c.deps.readInput(file) : (content as string);
      c.print(
        await cmd.memoryWrite(
          c.client(),
          c.envelope(),
          cmd.parseScope(need(c.values, "scope"), c.workspace()),
          text,
        ),
      );
    },
  },
  "memory list": {
    usage: "--scope <workspace|channel:<id>|project:<id>|bot:<id>|task:<id>>",
    options: { scope: str },
    run: async (c) =>
      c.print(
        await cmd.listMemories(
          c.client(),
          c.workspace(),
          cmd.parseScope(need(c.values, "scope"), c.workspace()),
        ),
      ),
  },
  "memory delete": {
    // A memory's content never changes, so a live one is at revision 1.
    usage: "<memory-id> [--revision <n>]",
    args: 1,
    options: { revision: { type: "string", default: "1" } },
    run: async (c) => {
      const revision = Number(c.values.revision);
      if (!Number.isInteger(revision) || revision < 1)
        throw invalid("--revision must be a positive integer");
      c.print(await cmd.memoryDelete(c.client(), c.envelope(), c.args[0]!, revision));
    },
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
  "message post": {
    usage:
      "(--channel <channel-id> | --conversation <dm-conversation-id>) [--thread-of <message-id>] [--reply-to <message-id>] --text <text with <@bot:ID> tokens> [--attach <path>...] [--resolve-names]",
    options: {
      channel: str,
      conversation: str,
      "thread-of": str,
      "reply-to": str,
      text: str,
      attach: { type: "string", multiple: true },
      "resolve-names": flag,
    },
    run: async (c) => {
      const { channel, conversation } = c.values as { channel?: string; conversation?: string };
      if ((channel === undefined) === (conversation === undefined))
        throw invalid("exactly one of --channel / --conversation is required");
      const threadOf = c.values["thread-of"] as string | undefined;
      const replyTo = c.values["reply-to"] as string | undefined;
      const target = {
        ...(channel ? { channelId: channel } : { conversationId: conversation! }),
        ...(threadOf ? { threadOf } : {}),
      };
      const attach = c.values.attach;
      const paths = typeof attach === "string" ? [attach] : ((attach ?? []) as string[]);
      const attachmentIds = await Promise.all(
        paths.map(
          async (path) =>
            (await uploadFile(c.client(), { workspaceId: c.workspace(), ...target }, path)).id,
        ),
      );
      c.print(
        await cmd.messagePost(c.client(), c.envelope(), {
          target: { ...target, ...(replyTo ? { replyToMessageId: replyTo } : {}) },
          text: need(c.values, "text"),
          ...(attachmentIds.length ? { attachmentIds } : {}),
          resolveNames: c.values["resolve-names"] === true,
        }),
      );
    },
  },
  "attachment get": {
    usage: "<attachment-id> --out <path>",
    args: 1,
    options: { out: str },
    run: async (c) => {
      const id = c.args[0]!;
      const out = need(c.values, "out");
      await c.deps.writeBytes(
        out,
        await c.client().getBytes(`/v1/attachments/${encodeURIComponent(id)}`),
      );
      c.print({ id, out });
    },
  },
  "thread list": {
    usage: "",
    run: async (c) => c.print(await cmd.listThreads(c.client(), c.workspace())),
  },
  "dm open": {
    usage: "<bot-id>",
    args: 1,
    run: async (c) => c.print(await cmd.dmOpen(c.client(), c.envelope(), c.args[0]!)),
  },
  "dm list": {
    usage: "",
    run: async (c) => c.print(await cmd.listDms(c.client(), c.workspace())),
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
  "collect enable": {
    usage: "",
    run: async (c) => {
      await c.deps.saveCollectConfig(true);
      c.print({ enabled: true });
    },
  },
  "collect disable": {
    usage: "",
    run: async (c) => {
      await c.deps.saveCollectConfig(false);
      c.print({ enabled: false });
    },
  },
  "collect status": {
    usage: "",
    run: async (c) => c.print(await c.deps.loadCollectConfig()),
  },
  "collect run": {
    usage: "[--since <duration>] [--dry-run]",
    options: { since: str, "dry-run": flag },
    run: async (c) => {
      if (!c.creds.deviceToken)
        throw new CliError("UNAUTHENTICATED", 3, "no deviceToken: run `hive device register`");
      const { accessClientId: clientId, accessClientSecret: clientSecret } = c.creds;
      c.print(
        await c.deps.runCollector(
          createCloudClient({
            apiUrl: c.apiUrl(),
            token: c.creds.deviceToken,
            accessService: clientId && clientSecret ? { clientId, clientSecret } : undefined,
            fetch: c.deps.fetch,
          }),
          {
            ...(typeof c.values.since === "string" ? { sinceMs: duration(c.values.since) } : {}),
            ...(c.values["dry-run"] === true ? { dryRun: true } : {}),
          },
        ),
      );
    },
  },
  "run list": {
    usage: "[--kind job|external]",
    options: { kind: str },
    run: async (c) => {
      const kind = c.values.kind;
      if (kind !== undefined && kind !== "job" && kind !== "external")
        throw invalid("--kind must be job or external");
      c.print(await cmd.listRuns(c.client(), c.workspace(), kind));
    },
  },
  "run link-task": {
    usage: "<run-id> <task-id>",
    args: 2,
    run: async (c) =>
      c.print(await cmd.runLinkTask(c.client(), c.envelope(), c.args[0]!, c.args[1]!)),
  },
  "job get": {
    usage: "<job-id>",
    args: 1,
    run: async (c) => c.print(await cmd.getJob(c.client(), c.args[0]!)),
  },
  "run get": {
    usage: "<run-id>",
    args: 1,
    run: async (c) => c.print(await cmd.getRun(c.client(), c.args[0]!)),
  },
  "run transcript": {
    usage: "<run-id> [--raw]",
    args: 1,
    options: { raw: flag },
    run: async (c) => {
      // Raw: the provider's JSONL as stored (workspace owner only).
      if (c.values.raw)
        return void c.deps.stdout(
          (await cmd.rawTranscript(c.client(), c.args[0]!)).replace(/\n$/, ""),
        );
      const entries = await cmd.runTranscript(c.client(), c.args[0]!);
      if (c.values.format === "json") return c.print({ entries });
      for (const e of entries) {
        c.deps.stdout(`${e.seq} ${e.kind}${e.toolName ? `(${e.toolName})` : ""}: ${e.text}`);
      }
    },
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
  "channel update": {
    usage: "<channel-id> --topic <text>",
    args: 1,
    options: { topic: str },
    run: async (c) =>
      c.print(
        await cmd.channelUpdate(c.client(), c.envelope(), c.args[0]!, need(c.values, "topic")),
      ),
  },
  "channel join": {
    usage: "<channel-id> --bot <bot-id>",
    args: 1,
    options: { bot: str },
    run: async (c) =>
      c.print(await cmd.channelJoin(c.client(), c.envelope(), c.args[0]!, need(c.values, "bot"))),
  },
  "channel leave": {
    usage: "<channel-id> --bot <bot-id>",
    args: 1,
    options: { bot: str },
    run: async (c) =>
      c.print(await cmd.channelLeave(c.client(), c.envelope(), c.args[0]!, need(c.values, "bot"))),
  },
  "channel member add": {
    usage: "<channel-id> (--user <user-id> | --bot <bot-id>) [--role owner|member|viewer]",
    args: 1,
    options: { user: str, bot: str, role: str },
    run: async (c) => {
      const role = c.values.role ?? "member";
      if (typeof role !== "string" || !memberRoles[role])
        throw invalid("--role must be owner, member or viewer");
      c.print(
        await cmd.channelMember(
          c.client(),
          c.envelope(),
          "channel.member.add",
          c.args[0]!,
          memberTarget(c.values),
          role,
        ),
      );
    },
  },
  "channel member update": {
    usage: "<channel-id> (--user <user-id> | --bot <bot-id>) --role owner|member|viewer",
    args: 1,
    options: { user: str, bot: str, role: str },
    run: async (c) => {
      const role = need(c.values, "role");
      if (!memberRoles[role]) throw invalid("--role must be owner, member or viewer");
      c.print(
        await cmd.channelMember(
          c.client(),
          c.envelope(),
          "channel.member.update",
          c.args[0]!,
          memberTarget(c.values),
          role,
        ),
      );
    },
  },
  "channel member remove": {
    usage: "<channel-id> (--user <user-id> | --bot <bot-id>)",
    args: 1,
    options: { user: str, bot: str },
    run: async (c) =>
      c.print(
        await cmd.channelMember(
          c.client(),
          c.envelope(),
          "channel.member.remove",
          c.args[0]!,
          memberTarget(c.values),
        ),
      ),
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
  "task get": {
    usage: "<task>",
    args: 1,
    run: async (c) => {
      const task = await cmd.findTask(c.client(), c.workspace(), c.args[0]!);
      c.print(await cmd.getTask(c.client(), task.id));
    },
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
  "task delegate": {
    usage:
      "<task> --to <bot-id> --mode <read|write> --instructions <text> [--deadline <iso-timestamp>]",
    args: 1,
    options: { to: str, mode: str, instructions: str, deadline: str },
    run: async (c) => {
      const mode = need(c.values, "mode");
      if (mode !== "read" && mode !== "write") throw invalid("--mode must be read or write");
      const task = await cmd.findTask(c.client(), c.workspace(), c.args[0]!);
      c.print(
        await cmd.taskDelegate(c.client(), c.envelope(), task, {
          toBotId: need(c.values, "to"),
          mode,
          instructions: need(c.values, "instructions"),
          deadline: c.values.deadline as string | undefined,
        }),
      );
    },
  },
  "task delegations": {
    usage: "<task>",
    args: 1,
    run: async (c) => {
      const task = await cmd.findTask(c.client(), c.workspace(), c.args[0]!);
      c.print({ delegations: ((await cmd.getTask(c.client(), task.id)) as cmd.Json).delegations });
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
      '--bot <bot-id> --name <name> (--cron "<m h dom mon dow>" | --webhook | --event-filter <json>) --input <text> [--tz <zone>] [--channel <channel-id>] [--misfire skip|coalesce]',
    options: {
      bot: str,
      name: str,
      cron: str,
      webhook: flag,
      "event-filter": str,
      input: str,
      tz: str,
      channel: str,
      misfire: str,
    },
    run: async (c) => {
      const { cron, webhook, "event-filter": eventFilter } = c.values;
      if (
        [cron, webhook || undefined, eventFilter].filter((value) => value !== undefined).length !==
        1
      )
        throw invalid("exactly one of --cron, --webhook, --event-filter is required");
      let schedule:
        | { kind: "cron"; expr: string; timezone: string }
        | { kind: "webhook" }
        | { kind: "event"; filter: cmd.Json };
      if (webhook) {
        schedule = { kind: "webhook" };
      } else if (eventFilter !== undefined) {
        let filter: unknown;
        try {
          filter = JSON.parse(eventFilter as string);
        } catch {
          throw invalid("--event-filter must contain valid JSON");
        }
        const parsed = parse(FilterExpression, filter);
        if (!parsed.ok) throw invalid("--event-filter must be a valid filter expression");
        schedule = { kind: "event", filter: parsed.value as cmd.Json };
      } else {
        schedule = {
          kind: "cron",
          expr: need(c.values, "cron"),
          // Default: this machine's zone.
          timezone:
            (c.values.tz as string | undefined) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
      }
      const channel = c.values.channel as string | undefined;
      c.print(
        await cmd.routineCreate(c.client(), c.envelope(), {
          botId: need(c.values, "bot"),
          name: need(c.values, "name"),
          schedule,
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
  "routine rotate-secret": {
    usage: "<routine-id>",
    args: 1,
    run: async (c) => c.print(await cmd.routineRotateSecret(c.client(), c.envelope(), c.args[0]!)),
  },
  ...Object.fromEntries(
    (["run", "pause", "resume", "delete"] as const).map((action) => [
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
    usage: "[--once] [--provider fake|claude|codex] [--concurrency N]",
    options: {
      once: flag,
      provider: { type: "string", default: "fake" },
      concurrency: { type: "string", default: "1" },
    },
    run: async (c) => {
      const provider = c.values.provider;
      if (provider !== "fake" && provider !== "claude" && provider !== "codex")
        throw invalid("--provider must be fake, claude or codex");
      const concurrency = parseConcurrency(c.values.concurrency as string);
      if (concurrency === null) throw invalid("--concurrency must be an integer in 1..64");
      const token = c.creds.deviceToken;
      if (!token)
        throw new CliError("UNAUTHENTICATED", 3, "no deviceToken: run `hive device register`");
      const apiUrl = c.apiUrl();
      const { accessClientId: clientId, accessClientSecret: clientSecret } = c.creds;
      const accessService = clientId && clientSecret ? { clientId, clientSecret } : undefined;
      const cloud = createCloudClient({ apiUrl, token, accessService, fetch: c.deps.fetch });
      // ponytail: no Queue consumer yet and `wrangler dev` fires no cron, so each poll pumps the outbox
      // first (POST /v1/executor/pump). Drop this once Queues route events.
      const pumping: CloudClient = {
        ...cloud,
        listQueuedJobs: async (limit) => {
          await c.deps
            .fetch(new URL("/v1/executor/pump", apiUrl), {
              method: "POST",
              headers: { ...serviceTokenHeaders(accessService), "X-Hive-Token": token },
            })
            .catch(() => undefined);
          return cloud.listQueuedJobs(limit);
        },
      };
      c.print(
        (await c.deps.runExecutor(pumping, c.values.once === true, provider, concurrency)) ?? {
          claimed: null,
        },
      );
    },
  },
  "executor install": {
    usage: "[--provider fake|claude|codex] [--concurrency N]",
    options: {
      provider: { type: "string", default: "fake" },
      concurrency: { type: "string", default: "1" },
    },
    run: async (c) => {
      const provider = c.values.provider as string;
      if (!["fake", "claude", "codex"].includes(provider))
        throw invalid("--provider must be fake, claude or codex");
      const concurrency = parseConcurrency(c.values.concurrency as string);
      if (concurrency === null) throw invalid("--concurrency must be an integer in 1..64");
      // The service runs `executor run`, which needs both; without them KeepAlive restarts a failing process forever.
      if (!c.creds.deviceToken)
        throw new CliError("UNAUTHENTICATED", 3, "no deviceToken: run `hive device register`");
      if (!c.creds.apiUrl) throw invalid("no apiUrl in the credentials file");
      const service = await import("./service.ts");
      const main = fileURLToPath(new URL("main.ts", import.meta.url));
      c.print(
        await service.install({
          program: [process.execPath, main, "executor", "run"],
          provider,
          concurrency,
        }),
      );
    },
  },
  "executor uninstall": {
    usage: "",
    run: async (c) => c.print(await (await import("./service.ts")).uninstall()),
  },
  "executor status": {
    usage: "",
    run: async (c) => c.print(await (await import("./service.ts")).status()),
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
  // Prefer the longest registered command (`bot skill add`), then two-word and one-word commands.
  const names = [`${argv[0]} ${argv[1]} ${argv[2]}`, `${argv[0]} ${argv[1]}`, argv[0] ?? ""];
  const name = names.find((candidate) => candidate in specs) ?? "";
  const rest = argv.slice(name.split(" ").length);
  const spec = specs[name];
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
    if (positionals.length !== (spec.args ?? 0)) throw invalid(`usage: hive ${name} ${spec.usage}`);
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
    // One getter per invocation, so a refreshed token is reused by later requests of the same command.
    let tokens: (() => Promise<string>) | undefined;
    const oauthToken = () =>
      (tokens ??= accessTokens({
        apiUrl: apiUrl(),
        // The file, not `creds`: Electron may have refreshed the shared grant since this command started.
        load: async () => (await deps.loadCredentials()).oauth,
        save: async (oauth) => void (await deps.saveCredentials({ oauth })),
        openBrowser: deps.openBrowser,
      }));
    const timeout = Number(values.timeout ?? 300);
    if (!(timeout > 0)) throw invalid("--timeout must be a positive number of seconds");
    const code = await spec.run({
      values,
      args: positionals,
      deps,
      creds,
      apiUrl,
      client: () =>
        createClient({
          apiUrl: apiUrl(),
          accessJwt: creds.accessJwt,
          accessToken: oauthToken(),
          fetch: deps.fetch,
        }),
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
