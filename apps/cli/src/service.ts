// `hive executor install | uninstall | status` (docs/architecture.md §20.1): the executor loop as a launchd user
// agent, so it keeps running after the UI or terminal closes and starts again at login. The program is the CLI
// (`bun main.ts executor run`) or the desktop app in its headless executor mode. macOS only for now.
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CliError, invalid } from "./client.ts";

export const label = "com.hive.executor";
// Same as deps.ts.
const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "hive");
const logDir = join(configDir, "executor", "logs");
const plistFile = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const logs = { stdout: join(logDir, "stdout.log"), stderr: join(logDir, "stderr.log") };

const ignoreMissing = (error: NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT") throw error;
};

/**
 * Copy-truncate rotation: launchd holds the logs open in append mode, so a file over `maxBytes` is copied to `.1`
 * (`.1` → `.2` → `.3`, older dropped) and truncated in place. Lines written between the copy and the truncate are lost.
 */
export const rotateLogs = async (
  files = [logs.stdout, logs.stderr],
  maxBytes = 5 * 1024 * 1024,
) => {
  for (const file of files) {
    // oxlint-disable-next-line no-await-in-loop
    const size = await stat(file).then(
      (s) => s.size,
      () => 0,
    );
    if (size <= maxBytes) continue;
    for (let i = 2; i >= 1; i--) {
      // oxlint-disable-next-line no-await-in-loop
      await rename(`${file}.${i}`, `${file}.${i + 1}`).catch(ignoreMissing);
    }
    // oxlint-disable-next-line no-await-in-loop
    await copyFile(file, `${file}.1`);
    // oxlint-disable-next-line no-await-in-loop
    await truncate(file, 0);
  }
};

/**
 * The environment the executor needs; launchd starts agents with almost none. The Claude variables carry the login a
 * store-backed resume can copy (docs/roadmap.md SESSION-01), so they are captured only when set at install time.
 */
const passthrough = [
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export const captureEnv = (env: Record<string, string | undefined>) => {
  const out = Object.fromEntries(
    passthrough.flatMap((name) => (env[name] ? [[name, env[name]]] : [])),
  );
  // `bun run` prepends node_modules/.bin on every start, so an undeduplicated PATH differs per start and `ensure`
  // would reinstall the service each time the desktop app runs from `dev`.
  if (out.PATH) out.PATH = [...new Set(out.PATH.split(":"))].join(":");
  return out;
};

const esc = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const unesc = (value: string) =>
  value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const str = (value: string) => `<string>${esc(value)}</string>`;

export const renderPlist = (input: {
  args: string[];
  env: Record<string, string>;
  workingDirectory: string;
  logs: { stdout: string; stderr: string };
}) =>
  [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>${str(label)}`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...input.args.map((arg) => `    ${str(arg)}`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...Object.entries(input.env).map(([name, value]) => `    <key>${esc(name)}</key>${str(value)}`),
    `  </dict>`,
    `  <key>WorkingDirectory</key>${str(input.workingDirectory)}`,
    `  <key>StandardOutPath</key>${str(input.logs.stdout)}`,
    `  <key>StandardErrorPath</key>${str(input.logs.stderr)}`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>KeepAlive</key><true/>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");

/**
 * The provider, concurrency and full argv of a plist written by `renderPlist`. Reads only `ProgramArguments`: the
 * `EnvironmentVariables` values may be tokens.
 */
export const parsePlist = (xml: string) => {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1] ?? "";
  const program = [...array.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unesc(m[1]!));
  const after = (flag: string) => {
    const i = program.indexOf(flag);
    return i < 0 ? null : (program[i + 1] ?? null);
  };
  const concurrency = Number(after("--concurrency"));
  return {
    provider: after("--provider"),
    concurrency: Number.isInteger(concurrency) && concurrency > 0 ? concurrency : null,
    program,
  };
};

/** Top-level `state` / `pid` / `last exit code` of `launchctl print gui/<uid>/<label>` (nested blocks ignored). */
export const parseLaunchctlPrint = (output: string) => {
  const field = (name: string) =>
    new RegExp(`^\\t${name} = (.+)$`, "m").exec(output)?.[1]?.trim() ?? null;
  const pid = field("pid");
  return {
    state: field("state"),
    pid: pid === null ? null : Number(pid),
    lastExitCode: field("last exit code"),
  };
};

const launchctl = (...args: string[]) =>
  promisify(execFile)("launchctl", args, { encoding: "utf8" }).then(
    ({ stdout }) => ({ ok: true, stdout }),
    (error: { stderr?: string; message: string }) => ({
      ok: false,
      stdout: (error.stderr || error.message).trim(),
    }),
  );

const macOnly = () => {
  if (process.platform !== "darwin")
    throw invalid(`executor service is not supported yet on ${process.platform} (macOS only)`);
  return `gui/${process.getuid!()}`;
};

/** `program` is the argv prefix (executable first); `--provider P --concurrency N` are appended. */
export type ServiceInput = { program: string[]; provider: string; concurrency: number };

const render = (input: ServiceInput) => {
  const env = captureEnv(process.env);
  const args = [
    ...input.program,
    "--provider",
    input.provider,
    "--concurrency",
    String(input.concurrency),
  ];
  return { env, xml: renderPlist({ args, env, workingDirectory: configDir, logs }) };
};

export const install = async (input: ServiceInput) => {
  const domain = macOnly();
  const { env, xml } = render(input);
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  await mkdir(join(plistFile, ".."), { recursive: true });
  // May hold CLAUDE_CODE_OAUTH_TOKEN: owner-only, also when the file already existed.
  await writeFile(plistFile, xml, { mode: 0o600 });
  await chmod(plistFile, 0o600);
  // Idempotent: unload a previous version first (fails harmlessly when none is loaded).
  await launchctl("bootout", `${domain}/${label}`);
  // ponytail: bootstrap right after bootout can fail with "5: Input/output error" while the old process exits;
  // retry a few times rather than polling launchctl for the exit.
  let loaded = await launchctl("bootstrap", domain, plistFile);
  for (let i = 0; !loaded.ok && i < 5; i++) {
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // oxlint-disable-next-line no-await-in-loop
    loaded = await launchctl("bootstrap", domain, plistFile);
  }
  if (!loaded.ok)
    throw new CliError("LAUNCHCTL_FAILED", 7, `launchctl bootstrap: ${loaded.stdout}`);
  // Names only: values may be tokens.
  return { installed: label, plist: plistFile, logs, capturedEnv: Object.keys(env) };
};

export const uninstall = async () => {
  const domain = macOnly();
  const out = await launchctl("bootout", `${domain}/${label}`);
  await rm(plistFile, { force: true });
  return { uninstalled: label, plist: plistFile, wasLoaded: out.ok };
};

const readPlist = () => readFile(plistFile, "utf8").catch(() => null);

/** Unloads the agent and keeps the plist, so `install` / the desktop app's start brings it back. */
export const stop = async () => {
  const domain = macOnly();
  const out = await launchctl("bootout", `${domain}/${label}`);
  return { stopped: label, wasLoaded: out.ok };
};

export const status = async () => {
  const domain = macOnly();
  const [out, xml] = await Promise.all([launchctl("print", `${domain}/${label}`), readPlist()]);
  return {
    label,
    loaded: out.ok,
    ...(out.ok ? parseLaunchctlPrint(out.stdout) : {}),
    installed: xml !== null,
    ...(xml === null ? {} : parsePlist(xml)),
    plist: plistFile,
    logs,
  };
};

/** Installs unless the plist on disk is byte-identical to `input`'s and the agent is running. */
export const ensure = async (input: ServiceInput) => {
  const current = await status();
  if ((await readPlist()) === render(input).xml && current.pid)
    return { changed: false, ...current };
  await install(input);
  return { changed: true, ...(await status()) };
};
