// hive Local Executor (Phase 1): `bun run apps/executor/src/main.ts --api-url ... --token-file ...
// --state-dir ... [--once] --provider fake|claude`.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { claudeAdapter } from "./adapters/claude.ts";
import { fakeAdapter } from "./adapters/fake.ts";
import { createCloudClient } from "./cloudClient.ts";
import { fileJournal } from "./journal.ts";
import { runLoop } from "./runner.ts";

const { values } = parseArgs({
  options: {
    "api-url": { type: "string" },
    "token-file": { type: "string" },
    "state-dir": { type: "string" },
    provider: { type: "string", default: "fake" },
    once: { type: "boolean", default: false },
  },
});
const apiUrl = values["api-url"];
const tokenFile = values["token-file"];
const stateDir = values["state-dir"];
if (!apiUrl || !tokenFile || !stateDir) {
  console.error(
    "usage: main.ts --api-url URL --token-file PATH --state-dir DIR [--once] --provider fake|claude",
  );
  process.exit(2);
}
if (values.provider !== "fake" && values.provider !== "claude") {
  console.error(`unsupported provider: ${values.provider}`);
  process.exit(2);
}

const result = await runLoop(
  {
    cloud: createCloudClient({ apiUrl, token: (await readFile(tokenFile, "utf8")).trim() }),
    journal: await fileJournal(stateDir),
    adapter:
      values.provider === "claude"
        ? claudeAdapter({ stateDir })
        : fakeAdapter({
            delayMs: Number(process.env.FAKE_DELAY_MS ?? 50),
            fail: process.env.FAKE_FAIL === "1",
          }),
  },
  // docs/roadmap.md §1: executor Job reconcile every 30 s (no WebSocket yet).
  { once: values.once, pollMs: 30_000 },
);
console.log(JSON.stringify(result ?? { claimed: null }));
