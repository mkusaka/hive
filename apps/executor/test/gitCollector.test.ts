import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAdapter } from "../src/adapters/fake.ts";
import { saveEnvironment } from "../src/environments.ts";
import {
  collect,
  exec,
  type Exec,
  normalizeRemote,
  snapshot,
  withGitCollector,
} from "../src/gitCollector.ts";
import type { LaunchContext } from "../src/runner.ts";
import { context } from "./helpers.ts";

const run = promisify(execFile);
const git = (cwd: string, ...args: string[]) => run("git", args, { cwd });
const commit = (cwd: string, subject: string) =>
  git(cwd, "commit", "--allow-empty", "-q", "-m", subject);

/** A fresh repository on `main` with one commit; `remote` sets `origin`. */
const repo = async (remote?: string) => {
  const cwd = await mkdtemp(join(tmpdir(), "hive-git-"));
  await git(cwd, "init", "-q", "-b", "main");
  await commit(cwd, "initial");
  if (remote) await git(cwd, "remote", "add", "origin", remote);
  return cwd;
};

/** Real git; `gh` answers `gh` (or throws it). */
const withGh =
  (gh: () => Promise<string>): Exec =>
  (file, args, cwd) =>
    file === "gh" ? gh() : exec(file, args, cwd);

beforeEach(() => {
  // Isolate from the developer's git config (signing, hooks, templates).
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_AUTHOR_NAME", "t");
  vi.stubEnv("GIT_AUTHOR_EMAIL", "t@example.test");
  vi.stubEnv("GIT_COMMITTER_NAME", "t");
  vi.stubEnv("GIT_COMMITTER_EMAIL", "t@example.test");
});
afterEach(() => void vi.unstubAllEnvs());

describe("normalizeRemote", () => {
  it("keeps host/owner/repo only; no credentials, scheme or local paths", () => {
    // Built at runtime so the secret scanner does not read the fixture as a credential.
    expect(
      normalizeRemote(["https://user", "placeholder@GitHub.com/owner/repo.git"].join(":")),
    ).toBe("github.com/owner/repo");
    expect(normalizeRemote("git@github.com:owner/repo.git")).toBe("github.com/owner/repo");
    expect(normalizeRemote("ssh://git@github.com:22/owner/repo")).toBe("github.com/owner/repo");
    expect(normalizeRemote("")).toBe("");
    expect(normalizeRemote("file:///srv/repo.git")).toBe("");
    expect(normalizeRemote("/srv/repo")).toBe("");
  });
});

describe("collect", () => {
  it("collects the Run's new commits and the branch's PRs", async () => {
    const cwd = await repo("https://token@github.com/owner/repo.git");
    const snap = await snapshot(cwd);
    await commit(cwd, "first change");
    await commit(cwd, "second change");
    const pr = {
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
      state: "OPEN",
      title: "t",
    };
    const gh = vi.fn(async () => JSON.stringify([pr]));

    const got = await collect(cwd, snap, withGh(gh));

    expect(got).toMatchObject({
      repository: "github.com/owner/repo",
      branch: "main",
      before: snap.before,
      partial: false,
      prs: [pr],
    });
    expect(got!.commits.map((c) => c.subject)).toEqual(["second change", "first change"]);
    expect(got!.after).toBe(got!.commits[0]!.sha);
    expect(got).not.toHaveProperty("prError");
    expect(JSON.stringify(got)).not.toContain(cwd);
  });

  it("flags partial when `before` left HEAD's history, and records a gh failure", async () => {
    const cwd = await repo("git@github.com:owner/repo.git");
    await commit(cwd, "to be dropped");
    const snap = await snapshot(cwd);
    await git(cwd, "reset", "-q", "--hard", "HEAD~1");
    await commit(cwd, "rewritten");

    const got = await collect(
      cwd,
      snap,
      withGh(() => Promise.reject(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }))),
    );

    expect(got).toMatchObject({ partial: true, prs: [], prError: "gh not found" });
    expect(got!.commits.map((c) => c.subject)).toContain("rewritten");
    expect(got!.commits.map((c) => c.subject)).not.toContain("to be dropped");
  });

  it("does not ask gh without a remote", async () => {
    const cwd = await repo();
    const gh = vi.fn(async () => "[]");
    const got = await collect(cwd, await snapshot(cwd), withGh(gh));
    expect(got).toMatchObject({ repository: "", commits: [], prs: [] });
    expect(gh).not.toHaveBeenCalled();
  });
});

describe("withGitCollector", () => {
  const launch = async (stateDir: string, cwdMode: "environment" | "run_scratch") => {
    const observed: { kind: string; payload: Record<string, unknown> }[] = [];
    const ctx: LaunchContext = {
      runId: "run-1",
      jobId: "job-1",
      executionGeneration: 1,
      inboxItemId: "inbox-1",
      context: {
        ...context,
        bot: { ...context.bot, toolPolicy: { tools: {}, cwdMode } },
        environment: "app",
      },
      run: null,
      observe: async (kind, payload) => void observed.push({ kind, payload }),
    };
    const adapter = withGitCollector(fakeAdapter({}), { stateDir, run: withGh(async () => "[]") });
    const exit = await (await adapter.start(ctx)).waitForExit();
    return { exit, observed };
  };

  it("observes git.collected for an environment Run before the exit resolves", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "hive-state-"));
    await saveEnvironment(stateDir, "app", await repo("https://github.com/owner/repo"));
    const { exit, observed } = await launch(stateDir, "environment");
    expect(exit.code).toBe(0);
    expect(observed).toEqual([
      {
        kind: "git.collected",
        payload: expect.objectContaining({ repository: "github.com/owner/repo" }),
      },
    ]);
  });

  it("observes nothing for a scratch-cwd Run", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "hive-state-"));
    await writeFile(join(stateDir, "environments.json"), "{}");
    const { observed } = await launch(stateDir, "run_scratch");
    expect(observed).toEqual([]);
  });
});
