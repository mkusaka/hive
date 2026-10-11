#!/usr/bin/env bun
// `hive` entrypoint: real credentials file, stdin and the Local Executor journal for `run` (src/cli.ts).
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { claudeAdapter } from "@hive/executor/adapters/claude";
import { fakeAdapter } from "@hive/executor/adapters/fake";
import { fileJournal } from "@hive/executor/journal";
import { runLoop } from "@hive/executor/runner";
import { type Credentials, run } from "./cli.ts";

const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "hive");
const credentialsFile = join(dir, "credentials.json");
const tokenFile = join(dir, "device-token");

const readCredentials = async (): Promise<Credentials> =>
  readFile(credentialsFile, "utf8").then(
    (data) => JSON.parse(data) as Credentials,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return {};
      throw error;
    },
  );

// Owner-only: the file holds the Access assertion and the device token (§23).
const writePrivate = async (path: string, data: string) => {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(path, data, { mode: 0o600 });
  await chmod(path, 0o600);
};

process.exitCode = await run(process.argv.slice(2), {
  fetch: (input, init) => fetch(input, init),
  loadCredentials: async () => {
    const creds = await readCredentials();
    return process.env.HIVE_ACCESS_JWT
      ? { ...creds, accessJwt: process.env.HIVE_ACCESS_JWT }
      : creds;
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
  readInput: (path) => (path === "-" ? text(process.stdin) : readFile(path, "utf8")),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  runExecutor: async (cloud, once, provider) =>
    runLoop(
      {
        cloud,
        journal: await fileJournal(join(dir, "executor")),
        adapter:
          provider === "claude"
            ? claudeAdapter({ stateDir: join(dir, "executor") })
            : fakeAdapter({
                delayMs: Number(process.env.FAKE_DELAY_MS ?? 50),
                fail: process.env.FAKE_FAIL === "1",
              }),
      },
      // docs/roadmap.md §1: executor Job reconcile every 30 s (no WebSocket yet).
      { once, pollMs: 30_000 },
    ),
});
