/* oxlint-disable no-await-in-loop */
// Real fs in a temp dir: service.test.ts mocks node:fs/promises.
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { rotateLogs } from "../src/service.ts";

it("copy-truncates a log over the limit and keeps 3 generations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hive-logs-"));
  const log = join(dir, "stdout.log");
  const small = join(dir, "stderr.log");
  await writeFile(small, "ok\n");
  for (const gen of ["a", "b", "c", "d"]) {
    await writeFile(log, gen.repeat(11));
    await rotateLogs([log, small, join(dir, "missing.log")], 10);
  }
  expect((await stat(log)).size).toBe(0);
  expect(await readFile(`${log}.1`, "utf8")).toBe("d".repeat(11));
  expect(await readFile(`${log}.2`, "utf8")).toBe("c".repeat(11));
  expect(await readFile(`${log}.3`, "utf8")).toBe("b".repeat(11));
  await expect(stat(`${log}.4`)).rejects.toThrow();
  // Under the limit: untouched.
  expect(await readFile(small, "utf8")).toBe("ok\n");
  await expect(stat(`${small}.1`)).rejects.toThrow();
});
