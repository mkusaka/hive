import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureEnv,
  ensure,
  parseLaunchctlPrint,
  parsePlist,
  renderPlist,
  status,
} from "../src/service.ts";

// launchctl and the plist file, faked: `loaded` answers `launchctl print`, `files` is the disk.
const fake = vi.hoisted(() => ({
  files: new Map<string, string>(),
  loaded: "" as string | null,
  calls: [] as string[],
}));
vi.mock("node:fs/promises", () => ({
  mkdir: async () => undefined,
  chmod: async () => undefined,
  rm: async (path: string) => void fake.files.delete(path),
  writeFile: async (path: string, data: string) => void fake.files.set(path, data),
  readFile: async (path: string) => {
    const data = fake.files.get(path);
    if (data === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return data;
  },
}));
vi.mock("node:child_process", () => ({
  execFile: (
    _: string,
    args: string[],
    __: unknown,
    cb: (error: unknown, out?: { stdout: string }) => void,
  ) => {
    fake.calls.push(args[0]!);
    if (args[0] === "print" && fake.loaded === null)
      return cb(Object.assign(new Error("x"), { stderr: "Could not find service" }));
    cb(null, { stdout: args[0] === "print" ? (fake.loaded ?? "") : "" });
  },
}));

describe("captureEnv", () => {
  it("keeps only the executor's variables, and the optional ones only when set", () => {
    expect(
      captureEnv({
        PATH: "/usr/bin",
        HOME: "/Users/u",
        XDG_CONFIG_HOME: "",
        CLAUDE_CODE_OAUTH_TOKEN: "tok",
        HIVE_ACCESS_JWT: "jwt",
        SHELL: "/bin/zsh",
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/Users/u", CLAUDE_CODE_OAUTH_TOKEN: "tok" });
  });
  it("deduplicates PATH entries so repeated `bun run` starts render the same plist", () => {
    expect(captureEnv({ PATH: "/a/.bin:/usr/bin:/a/.bin:/b" }).PATH).toBe("/a/.bin:/usr/bin:/b");
  });
});

describe("renderPlist", () => {
  it("runs `executor run` under launchd with KeepAlive, RunAtLoad, logs and the captured env, escaped", () => {
    const xml = renderPlist({
      args: ["/opt/bun", "/repo/apps/cli/src/main.ts", "executor", "run", "--provider", "claude"],
      env: { PATH: "/a&b:/usr/bin", HOME: "/Users/u" },
      workingDirectory: "/Users/u/.config/hive",
      logs: { stdout: "/l/stdout.log", stderr: "/l/stderr.log" },
    });
    expect(xml).toContain("<key>Label</key><string>com.hive.executor</string>");
    expect(xml).toContain(
      [
        "  <array>",
        "    <string>/opt/bun</string>",
        "    <string>/repo/apps/cli/src/main.ts</string>",
        "    <string>executor</string>",
        "    <string>run</string>",
        "    <string>--provider</string>",
        "    <string>claude</string>",
        "  </array>",
      ].join("\n"),
    );
    expect(xml).toContain("<key>PATH</key><string>/a&amp;b:/usr/bin</string>");
    expect(xml).toContain("<key>HOME</key><string>/Users/u</string>");
    expect(xml).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(xml).toContain("<key>WorkingDirectory</key><string>/Users/u/.config/hive</string>");
    expect(xml).toContain("<key>StandardOutPath</key><string>/l/stdout.log</string>");
    expect(xml).toContain("<key>StandardErrorPath</key><string>/l/stderr.log</string>");
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
    expect(xml).toContain("<key>KeepAlive</key><true/>");
  });
});

// Hand-written in the shape of `launchctl print gui/<uid>/<label>` (macOS 15); nested blocks repeat `state`.
const printed = `gui/501/com.hive.executor = {
	active count = 1
	path = /Users/u/Library/LaunchAgents/com.hive.executor.plist
	type = LaunchAgent
	state = running

	program = /opt/bun
	arguments = {
		/opt/bun
		/repo/apps/cli/src/main.ts
		executor
		run
	}

	working directory = /Users/u/.config/hive

	stdout path = /Users/u/.config/hive/executor/logs/stdout.log
	stderr path = /Users/u/.config/hive/executor/logs/stderr.log
	environment = {
		PATH => /usr/bin
		XPC_SERVICE_NAME => com.hive.executor
	}

	domain = gui/501 [100005]
	runs = 2
	pid = 4242
	immediate reason = speculative
	last exit code = 0

	endpoints = {
		"com.example" = {
			port = 0x1234
			state = inactive
		}
	}
}
`;

describe("parseLaunchctlPrint", () => {
  it("reads the top-level state, pid and last exit code", () => {
    expect(parseLaunchctlPrint(printed)).toEqual({
      state: "running",
      pid: 4242,
      lastExitCode: "0",
    });
  });

  it("has no pid when the agent is not running", () => {
    const stopped = printed
      .replace("\tpid = 4242\n", "")
      .replace("state = running", "state = not running");
    expect(parseLaunchctlPrint(stopped)).toEqual({
      state: "not running",
      pid: null,
      lastExitCode: "0",
    });
  });
});

const input = {
  program: ["/app/Electron", "/app", "--executor"],
  provider: "fake",
  concurrency: 2,
};

describe("parsePlist", () => {
  it("reads provider, concurrency and argv from ProgramArguments only", () => {
    const xml = renderPlist({
      args: [...input.program, "--provider", "claude", "--concurrency", "3"],
      env: { CLAUDE_CODE_OAUTH_TOKEN: "secret-token", PATH: "/a&b" },
      workingDirectory: "/w",
      logs: { stdout: "/o", stderr: "/e" },
    });
    const parsed = parsePlist(xml);
    expect(parsed).toEqual({
      provider: "claude",
      concurrency: 3,
      program: [...input.program, "--provider", "claude", "--concurrency", "3"],
    });
    expect(JSON.stringify(parsed)).not.toContain("secret-token");
  });
});

describe("ensure", () => {
  beforeEach(() => {
    // CI runs on Linux; the module is macOS-only.
    Object.defineProperty(process, "platform", { value: "darwin" });
    fake.files.clear();
    fake.calls.length = 0;
    fake.loaded = null;
  });
  // Installs once for real (through the fakes) so the plist on disk is the rendered one.
  const installed = async () => {
    await ensure(input);
    fake.calls.length = 0;
  };

  it("leaves an identical plist that is loaded with a pid alone", async () => {
    await installed();
    fake.loaded = printed;
    expect(await ensure(input)).toMatchObject({ changed: false, pid: 4242, provider: "fake" });
    expect(fake.calls).not.toContain("bootstrap");
  });

  it("reinstalls when the plist differs", async () => {
    await installed();
    fake.loaded = printed;
    const result = await ensure({ ...input, provider: "claude" });
    expect(result).toMatchObject({ changed: true, provider: "claude", concurrency: 2 });
    expect(fake.calls).toEqual(["print", "bootout", "bootstrap", "print"]);
  });

  it("reinstalls an identical plist that is not loaded, or loaded without a pid", async () => {
    await installed();
    expect(await ensure(input)).toMatchObject({ changed: true });
    expect(fake.calls).toContain("bootstrap");
    fake.loaded = printed.replace("\tpid = 4242\n", "");
    fake.calls.length = 0;
    expect(await ensure(input)).toMatchObject({ changed: true });
    expect(fake.calls).toContain("bootstrap");
  });

  it("reports a missing plist as not installed", async () => {
    expect(await status()).toMatchObject({ loaded: false, installed: false });
  });
});
