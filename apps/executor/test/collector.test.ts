import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectExternalRuns, redact } from "../src/collector.ts";
import { fakeCloud } from "./helpers.ts";

const roots: string[] = [];
const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "hive-collector-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const claudeLine = (content: unknown, timestamp = "2026-10-12T00:00:00.000Z") =>
  JSON.stringify({
    type: "user",
    timestamp,
    cwd: "/external/repo",
    sessionId: "session-1",
    message: { content },
  });

const layout = async (root: string, contents: string) => {
  const projects = join(root, "claude", "projects", "external");
  await mkdir(projects, { recursive: true });
  const file = join(projects, "session-1.jsonl");
  await writeFile(file, contents);
  return { claudeRoot: join(root, "claude", "projects"), file };
};

describe("Claude source boundaries", () => {
  it("imports the main session without attributing nested subagent messages to it", async () => {
    const root = await makeRoot();
    const source = await layout(root, `${claudeLine("main request")}\n`);
    const subagents = join(source.claudeRoot, "external", "session-1", "subagents");
    await mkdir(subagents, { recursive: true });
    await writeFile(join(subagents, "agent-1.jsonl"), `${claudeLine("subagent request")}\n`);
    const parts: string[] = [];
    const { cloud } = fakeCloud({
      uploadPart: async (_id, bytes) => void parts.push(new TextDecoder().decode(bytes)),
    });
    await collectExternalRuns(cloud, {
      stateDir: join(root, "state"),
      claudeRoot: source.claudeRoot,
      codexRoot: join(root, "none"),
    });
    const entries = parts.flatMap((part) =>
      part
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
    expect(entries).toEqual([{ kind: "user", text: "main request" }]);
  });
});
describe("external collector", () => {
  it("keeps a UTF-8 torn tail until it completes", async () => {
    const root = await makeRoot();
    const source = await layout(root, `${claudeLine("first 😀")}\n${claudeLine("tail")}`);
    const { cloud, calls } = fakeCloud();
    const stateDir = join(root, "state");

    await collectExternalRuns(cloud, {
      stateDir,
      claudeRoot: source.claudeRoot,
      codexRoot: join(root, "none"),
    });
    expect(calls).toEqual(["init:0", "put:up-0", "complete:0"]);
    const state = JSON.parse(await readFile(join(stateDir, "collector.json"), "utf8")) as {
      files: Record<string, { offset: number }>;
    };
    expect(state.files[source.file]!.offset).toBe(
      new TextEncoder().encode(`${claudeLine("first 😀")}\n`).length,
    );

    await appendFile(source.file, "\n");
    await collectExternalRuns(cloud, {
      stateDir,
      claudeRoot: source.claudeRoot,
      codexRoot: join(root, "none"),
    });
    expect(calls).toContain("init:1");
  });

  it("retries the same immutable part after an ACK failure and appends a later delta", async () => {
    const root = await makeRoot();
    const source = await layout(root, `${claudeLine("first")}\n`);
    let fail = true;
    const { cloud, calls } = fakeCloud({
      uploadComplete: async (input) => {
        calls.push(`complete:${input.lastPartSeq}`);
        if (fail) {
          fail = false;
          throw new Error("lost ACK");
        }
      },
    });
    const stateDir = join(root, "state");
    await expect(
      collectExternalRuns(cloud, {
        stateDir,
        claudeRoot: source.claudeRoot,
        codexRoot: join(root, "none"),
      }),
    ).rejects.toThrow("lost ACK");
    await appendFile(source.file, `${claudeLine("second", "2026-10-12T00:01:00.000Z")}\n`);
    await collectExternalRuns(cloud, {
      stateDir,
      claudeRoot: source.claudeRoot,
      codexRoot: join(root, "none"),
    });
    expect(calls.filter((call) => call === "init:0")).toHaveLength(2);

    await collectExternalRuns(cloud, {
      stateDir,
      claudeRoot: source.claudeRoot,
      codexRoot: join(root, "none"),
    });
    expect(calls).toContain("init:1");
  });

  it("recovers a dead-owner lock and leaves a live-owner pass busy", async () => {
    const root = await makeRoot();
    const source = await layout(root, `${claudeLine("first")}\n`);
    const stateDir = join(root, "state");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "collector.lock"), "99999999\n");
    const { cloud, calls } = fakeCloud();
    await collectExternalRuns(cloud, {
      stateDir,
      claudeRoot: source.claudeRoot,
      codexRoot: join(root, "none"),
    });
    expect(calls).toContain("init:0");

    await writeFile(join(stateDir, "collector.lock"), `${process.pid}\n`);
    await expect(
      collectExternalRuns(cloud, {
        stateDir,
        claudeRoot: source.claudeRoot,
        codexRoot: join(root, "none"),
      }),
    ).resolves.toMatchObject({ busy: true });
  });

  it("dry-run leaves the source unchanged and creates no state directory", async () => {
    const root = await makeRoot();
    const original = `${claudeLine("dry")}\n`;
    const source = await layout(root, original);
    const { cloud } = fakeCloud({
      externalRun: async () => {
        throw new Error("dry-run must not contact the Worker");
      },
      uploadInit: async () => {
        throw new Error("dry-run must not upload");
      },
    });
    const stateDir = join(root, "state");
    await collectExternalRuns(cloud, {
      stateDir,
      claudeRoot: source.claudeRoot,
      codexRoot: join(root, "none"),
      dryRun: true,
    });
    await expect(stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(source.file, "utf8")).toBe(original);
  });

  it("derives the title from the first prompt when it arrives after the session metadata", async () => {
    const root = await makeRoot();
    const source = await layout(
      root,
      `${JSON.stringify({
        type: "system",
        sessionId: "session-1",
        cwd: "/external/repo",
        timestamp: "2026-10-12T00:00:00.000Z",
      })}\n`,
    );
    const titles: string[] = [];
    const { cloud } = fakeCloud({
      externalRun: async (input) => {
        titles.push(input.title);
        return { runId: "run-external-1", state: "active" };
      },
    });
    const options = {
      stateDir: join(root, "state"),
      claudeRoot: source.claudeRoot,
      codexRoot: join(root, "none"),
    };
    await collectExternalRuns(cloud, options);
    const first = "First prompt ".repeat(10).trim();
    await appendFile(source.file, `${claudeLine(first)}\n`);
    await collectExternalRuns(cloud, options);
    await appendFile(source.file, `${claudeLine("Later prompt")}\n`);
    await collectExternalRuns(cloud, options);
    expect(titles).toEqual(["External session", first.slice(0, 120), first.slice(0, 120)]);
  });

  it("normalizes Codex response items once and redacts tool input", async () => {
    const root = await makeRoot();
    const sessions = join(root, "codex", "sessions", "2026", "10");
    await mkdir(sessions, { recursive: true });
    const file = join(sessions, "session.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-10-12T00:00:00.000Z",
          payload: { id: "codex-1", cwd: "/external/repo", timestamp: "2026-10-12T00:00:00.000Z" },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-10-12T00:00:01.000Z",
          payload: { type: "user_message", message: "duplicate" },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-10-12T00:00:01.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "duplicate" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-10-12T00:00:02.000Z",
          payload: {
            type: "function_call",
            name: "Bash",
            arguments: JSON.stringify({ API_KEY: "fake-sensitive" }),
          },
        }),
        "",
      ].join("\n"),
    );
    const parts: string[] = [];
    const { cloud } = fakeCloud({
      uploadPart: async (_id, bytes) => void parts.push(new TextDecoder().decode(bytes)),
    });
    await collectExternalRuns(cloud, {
      stateDir: join(root, "state"),
      claudeRoot: join(root, "none"),
      codexRoot: join(root, "codex", "sessions"),
    });
    expect(parts.join("")).toContain('{"kind":"user","text":"duplicate"}');
    expect(parts.join("").match(/duplicate/g)).toHaveLength(1);
    expect(parts.join("")).toContain("[redacted]");
    expect(parts.join("")).not.toContain("fake-sensitive");
  });

  it("redacts token prefixes and assignments", () => {
    expect(redact('API_TOKEN="secret" ghp_abc sk-value')).toBe("[redacted] [redacted] [redacted]");
    expect(redact('{"API_KEY":"fake-sensitive"}')).not.toContain("fake-sensitive");
  });
});
