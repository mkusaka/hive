// What this executor reports with each heartbeat (docs/architecture.md §10.1): placement matches a Bot's
// `requiredCapabilities` against these and caps background root Runs at `capacity.background`.
import { access, constants } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { ExecutorHeartbeat } from "@hive/contracts";
import { readEnvironments } from "./environments.ts";

const onPath = async (binary: string, path: string) =>
  (
    await Promise.all(
      path
        .split(delimiter)
        .filter(Boolean)
        .map((dir) =>
          access(join(dir, binary), constants.X_OK).then(
            () => true,
            () => false,
          ),
        ),
    )
  ).includes(true);

/**
 * `bash` always; `claude` when this executor runs the Claude adapter (configured is enough, no probe); `codex` when it
 * runs the Codex adapter and a `codex` binary is on PATH; `env:<name>` per environment in `environments.json`.
 */
export const executorHeartbeat = async (input: {
  provider: string;
  stateDir: string;
  concurrency: number;
  path?: string;
}): Promise<ExecutorHeartbeat> => {
  const capabilities = ["bash"];
  if (input.provider === "claude") capabilities.push("claude");
  if (input.provider === "codex" && (await onPath("codex", input.path ?? process.env.PATH ?? ""))) {
    capabilities.push("codex");
  }
  for (const name of Object.keys(await readEnvironments(input.stateDir))) {
    capabilities.push(`env:${name}`);
  }
  return { capabilities, capacity: { background: input.concurrency } };
};

/** `--concurrency N`: background root Runs at once (1..64, the cloud's limit); null when invalid. */
export const parseConcurrency = (value: string | undefined) => {
  const n = Number(value ?? "1");
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : null;
};
