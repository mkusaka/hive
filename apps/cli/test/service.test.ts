import { describe, expect, it } from "vitest";
import { captureEnv, parseLaunchctlPrint, renderPlist } from "../src/service.ts";

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
