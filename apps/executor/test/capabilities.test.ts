import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { executorHeartbeat, parseConcurrency } from "../src/capabilities.ts";
import { saveEnvironment } from "../src/environments.ts";

const dir = () => mkdtemp(join(tmpdir(), "hive-caps-"));

describe("executorHeartbeat", () => {
  it("reports bash, the configured provider, codex only when on PATH, environments and the concurrency", async () => {
    const stateDir = await dir();
    const empty = await dir();
    expect(await executorHeartbeat({ provider: "fake", stateDir, concurrency: 1 })).toEqual({
      capabilities: ["bash"],
      capacity: { background: 1 },
    });
    expect(
      (await executorHeartbeat({ provider: "claude", stateDir, concurrency: 1 })).capabilities,
    ).toEqual(["bash", "claude"]);

    const codex = { provider: "codex", stateDir, concurrency: 3 };
    expect((await executorHeartbeat({ ...codex, path: empty })).capabilities).toEqual(["bash"]);
    const bin = await dir();
    await writeFile(join(bin, "codex"), "#!/bin/sh\n");
    await chmod(join(bin, "codex"), 0o755);
    await saveEnvironment(stateDir, "backend", bin);
    expect(await executorHeartbeat({ ...codex, path: [empty, bin].join(delimiter) })).toEqual({
      capabilities: ["bash", "codex", "env:backend"],
      capacity: { background: 3 },
    });
  });

  it("parses --concurrency as an integer in 1..64", () => {
    expect(parseConcurrency(undefined)).toBe(1);
    expect(parseConcurrency("4")).toBe(4);
    for (const bad of ["0", "65", "1.5", "x"]) expect(parseConcurrency(bad)).toBeNull();
  });
});
