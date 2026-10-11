// hive Local Executor (Phase 1): `bun run apps/executor/src/main.ts --api-url ... --token-file ...
// --state-dir ... [--once] [--concurrency N] --provider fake|claude|codex`.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { claudeAdapter } from "./adapters/claude.ts";
import { codexAdapter } from "./adapters/codex.ts";
import { fakeAdapter } from "./adapters/fake.ts";
import { executorHeartbeat, parseConcurrency } from "./capabilities.ts";
import { createCloudClient } from "./cloudClient.ts";
import { fileJournal, transcriptReader } from "./journal.ts";
import { runLoop } from "./runner.ts";
import { sessionJournals, sessionStore } from "./sessionStore.ts";
import { transcriptUploader } from "./uploader.ts";

const { values } = parseArgs({
  options: {
    "api-url": { type: "string" },
    "token-file": { type: "string" },
    "state-dir": { type: "string" },
    provider: { type: "string", default: "fake" },
    once: { type: "boolean", default: false },
    concurrency: { type: "string", default: "1" },
  },
});
const apiUrl = values["api-url"];
const tokenFile = values["token-file"];
const stateDir = values["state-dir"];
if (!apiUrl || !tokenFile || !stateDir) {
  console.error(
    "usage: main.ts --api-url URL --token-file PATH --state-dir DIR [--once] [--concurrency N] --provider fake|claude|codex",
  );
  process.exit(2);
}
if (!["fake", "claude", "codex"].includes(values.provider)) {
  console.error(`unsupported provider: ${values.provider}`);
  process.exit(2);
}

const concurrency = parseConcurrency(values.concurrency);
if (concurrency === null) {
  console.error("--concurrency must be an integer in 1..64");
  process.exit(2);
}

const cloud = createCloudClient({ apiUrl, token: (await readFile(tokenFile, "utf8")).trim() });
const journal = await fileJournal(stateDir);
const result = await runLoop(
  {
    cloud,
    journal,
    heartbeat: await executorHeartbeat({ provider: values.provider, stateDir, concurrency }),
    uploader: transcriptUploader({
      cloud,
      journal,
      read: transcriptReader(stateDir),
      sessions: sessionJournals(stateDir),
      provider: values.provider,
    }),
    adapter:
      values.provider === "claude"
        ? claudeAdapter({ stateDir, sessionStore: sessionStore({ stateDir, cloud }) })
        : values.provider === "codex"
          ? codexAdapter({ stateDir })
          : fakeAdapter({
              delayMs: Number(process.env.FAKE_DELAY_MS ?? 50),
              fail: process.env.FAKE_FAIL === "1",
            }),
  },
  // docs/roadmap.md §1: executor Job reconcile every 30 s (no WebSocket yet).
  { once: values.once, pollMs: 30_000, concurrency },
);
console.log(JSON.stringify(result ?? { claimed: null }));
