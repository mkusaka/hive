// `hive executor install | uninstall | status` (docs/architecture.md §20.1): the executor loop as a launchd user
// agent, so it keeps running after the UI or terminal closes and starts again at login. macOS only for now.
import { execFile } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CliError, invalid } from "./client.ts";

const label = "com.hive.executor";
// Same as main.ts.
const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "hive");
const logDir = join(configDir, "executor", "logs");
const plistFile = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const logs = { stdout: join(logDir, "stdout.log"), stderr: join(logDir, "stderr.log") };

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

export const captureEnv = (env: Record<string, string | undefined>) =>
  Object.fromEntries(passthrough.flatMap((name) => (env[name] ? [[name, env[name]]] : [])));

const esc = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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

export const install = async (provider: string, concurrency: number) => {
  const domain = macOnly();
  const env = captureEnv(process.env);
  const args = [
    process.execPath,
    fileURLToPath(new URL("main.ts", import.meta.url)),
    "executor",
    "run",
    "--provider",
    provider,
    "--concurrency",
    String(concurrency),
  ];
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  await mkdir(join(plistFile, ".."), { recursive: true });
  // May hold CLAUDE_CODE_OAUTH_TOKEN: owner-only, also when the file already existed.
  await writeFile(plistFile, renderPlist({ args, env, workingDirectory: configDir, logs }), {
    mode: 0o600,
  });
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

export const status = async () => {
  const domain = macOnly();
  const out = await launchctl("print", `${domain}/${label}`);
  return {
    label,
    loaded: out.ok,
    ...(out.ok ? parseLaunchctlPrint(out.stdout) : {}),
    plist: plistFile,
    logs,
  };
};
