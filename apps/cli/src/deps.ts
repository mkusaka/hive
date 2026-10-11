// The real `Deps` of `run` (src/cli.ts): credentials file, stdin and the Local Executor journal. Shared by the `hive`
// entrypoint (main.ts) and the desktop app's headless executor mode (apps/desktop/src/main/index.ts).
import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { claudeAdapter } from "@hive/executor/adapters/claude";
import { codexAdapter } from "@hive/executor/adapters/codex";
import { executorHeartbeat } from "@hive/executor/capabilities";
import { collectExternalRuns } from "@hive/executor/collector";
import { saveEnvironment } from "@hive/executor/environments";
import { fakeAdapter } from "@hive/executor/adapters/fake";
import { withGitCollector } from "@hive/executor/gitCollector";
import { fileJournal, transcriptReader } from "@hive/executor/journal";
import { pruneRunData } from "@hive/executor/retention";
import { runLoop } from "@hive/executor/runner";
import { sessionJournals, sessionStore } from "@hive/executor/sessionStore";
import { transcriptUploader } from "@hive/executor/uploader";
import { systemBrowser } from "./accessLogin.ts";
import { rotateLogs } from "./service.ts";
import type { Credentials, Deps } from "./cli.ts";

const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "hive");
const credentialsFile = join(dir, "credentials.json");
const tokenFile = join(dir, "device-token");
const executorDir = join(dir, "executor");
const configFile = join(dir, "config.json");

const readCollectConfig = async () =>
  readFile(configFile, "utf8").then(
    (data) => {
      const parsed = JSON.parse(data) as { collect?: { enabled?: unknown } };
      return { enabled: parsed.collect?.enabled === true };
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return { enabled: false };
      throw error;
    },
  );

const writeCollectConfig = async (enabled: boolean) => {
  await writePrivate(configFile, `${JSON.stringify({ collect: { enabled } }, null, 2)}\n`);
};

const readCredentials = async (): Promise<Credentials> =>
  readFile(credentialsFile, "utf8").then(
    (data) => JSON.parse(data) as Credentials,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return {};
      throw error;
    },
  );

// Owner-only: the file holds the Access assertion / OAuth grant, the device and service tokens (§23).
const writePrivate = async (path: string, data: string) => {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path, data, { mode: 0o600 });
  await chmod(path, 0o600);
};

const rotate = () => rotateLogs().catch((error) => console.error("log rotation failed", error));

export const deps: Deps = {
  fetch: (input, init) => fetch(input, init),
  loadCredentials: async () => {
    const { HIVE_ACCESS_JWT, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET } = process.env;
    return {
      ...(await readCredentials()),
      ...(HIVE_ACCESS_JWT ? { accessJwt: HIVE_ACCESS_JWT } : {}),
      ...(CF_ACCESS_CLIENT_ID && CF_ACCESS_CLIENT_SECRET
        ? { accessClientId: CF_ACCESS_CLIENT_ID, accessClientSecret: CF_ACCESS_CLIENT_SECRET }
        : {}),
    };
  },
  saveCredentials: async (patch) => {
    await writePrivate(
      credentialsFile,
      `${JSON.stringify({ ...(await readCredentials()), ...patch }, null, 2)}\n`,
    );
    if (!patch.deviceToken) return {};
    await writePrivate(tokenFile, `${patch.deviceToken}\n`);
    return { tokenFile };
  },
  openBrowser: systemBrowser((line) => console.error(line)),
  readInput: (path) => (path === "-" ? text(process.stdin) : readFile(path, "utf8")),
  saveEnvironment: async (name, path) => {
    const root = await realpath(path);
    if (!(await stat(root)).isDirectory()) throw new Error(`not a directory: ${root}`);
    await saveEnvironment(executorDir, name, root);
    return root;
  },
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  loadCollectConfig: readCollectConfig,
  saveCollectConfig: writeCollectConfig,
  runCollector: (cloud, options) =>
    collectExternalRuns(cloud, { stateDir: executorDir, ...options }),
  runExecutor: async (cloud, once, provider, concurrency) => {
    // Retention (docs/roadmap.md LOG-01): Run data once before the journal opens, the service logs now and hourly.
    await pruneRunData(executorDir).catch((error) =>
      console.error("run data pruning failed", error),
    );
    await rotate();
    const timer = setInterval(rotate, 60 * 60 * 1000);
    timer.unref();
    const journal = await fileJournal(executorDir);
    return runLoop(
      {
        cloud,
        journal,
        heartbeat: await executorHeartbeat({ provider, stateDir: executorDir, concurrency }),
        uploader: transcriptUploader({
          cloud,
          journal,
          read: transcriptReader(executorDir),
          sessions: sessionJournals(executorDir),
          provider,
        }),
        collect: async () => {
          if ((await readCollectConfig()).enabled)
            await collectExternalRuns(cloud, { stateDir: executorDir });
        },
        adapter: withGitCollector(
          provider === "claude"
            ? claudeAdapter({
                stateDir: executorDir,
                sessionStore: sessionStore({ stateDir: executorDir, cloud }),
              })
            : provider === "codex"
              ? codexAdapter({ stateDir: executorDir })
              : fakeAdapter({
                  delayMs: Number(process.env.FAKE_DELAY_MS ?? 50),
                  fail: process.env.FAKE_FAIL === "1",
                }),
          { stateDir: executorDir },
        ),
      },
      // docs/roadmap.md §1: executor Job reconcile every 30 s (no WebSocket yet).
      { once, pollMs: 30_000, concurrency },
    ).finally(() => clearInterval(timer));
  },
};
