import { CliError } from "@hive/cli/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executorHandlers } from "../src/main/ipc.ts";

const service = vi.hoisted(() => ({
  status: vi.fn(async () => ({ loaded: true, pid: 1 })),
  install: vi.fn(async (_: unknown) => ({ installed: "com.hive.executor" })),
  stop: vi.fn(async () => ({ stopped: "com.hive.executor", wasLoaded: true })),
}));
vi.mock("@hive/cli/service", () => service);

const program = ["/app/Electron", "/app", "--executor"];

describe("executor IPC handlers", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["not an object", "x"],
    ["an unknown provider", { provider: "bash", concurrency: 1 }],
    ["concurrency 0", { provider: "fake", concurrency: 0 }],
    ["a fractional concurrency", { provider: "fake", concurrency: 1.5 }],
    ["a string concurrency", { provider: "fake", concurrency: "1" }],
    ["an extra field", { provider: "fake", concurrency: 1, program: ["/bin/sh"] }],
  ])("start rejects %s without touching the service", async (_, input) => {
    const e = executorHandlers(program, async () => true);
    expect(await e.start(input)).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    expect(service.install).not.toHaveBeenCalled();
  });

  it("start installs the app's program with the given options", async () => {
    const e = executorHandlers(program, async () => true);
    expect((await e.start({ provider: "fake", concurrency: 2 })).ok).toBe(true);
    expect(service.install).toHaveBeenCalledWith({ program, provider: "fake", concurrency: 2 });
  });

  it("start refuses an unregistered device; status says whether it is registered", async () => {
    const e = executorHandlers(program, async () => false);
    expect(await e.start({ provider: "fake", concurrency: 1 })).toMatchObject({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: expect.stringContaining("hive device register") },
    });
    expect(service.install).not.toHaveBeenCalled();
    expect(await e.status()).toEqual({
      ok: true,
      value: { loaded: true, pid: 1, registered: false },
    });
  });

  it("maps service errors to results", async () => {
    service.stop.mockRejectedValueOnce(new CliError("LAUNCHCTL_FAILED", 7, "launchctl: boom"));
    service.status.mockRejectedValueOnce(new Error("disk"));
    const e = executorHandlers(program, async () => true);
    expect(await e.stop()).toMatchObject({
      ok: false,
      error: { code: "LAUNCHCTL_FAILED", message: "launchctl: boom" },
    });
    expect(await e.status()).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });
});
