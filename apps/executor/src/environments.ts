// Local environment mapping (docs/architecture.md §10.1): `<state-dir>/environments.json` maps an environment name to
// its checkout root on this device. Local paths never leave the device; the cloud knows only name + repository.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const file = (stateDir: string) => join(stateDir, "environments.json");

export const readEnvironments = async (stateDir: string): Promise<Record<string, string>> =>
  readFile(file(stateDir), "utf8").then(
    (text) => JSON.parse(text) as Record<string, string>,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return {};
      throw error;
    },
  );

export const saveEnvironment = async (stateDir: string, name: string, checkoutRoot: string) => {
  await mkdir(stateDir, { recursive: true });
  const environments = { ...(await readEnvironments(stateDir)), [name]: checkoutRoot };
  await writeFile(file(stateDir), `${JSON.stringify(environments, null, 2)}\n`, { mode: 0o600 });
};
