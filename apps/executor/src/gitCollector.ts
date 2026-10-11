// Git / PR collector (GIT-01, docs/architecture.md §10.1, §20.5). For a Run in an environment checkout
// (`cwdMode: environment`), snapshots HEAD before the agent starts and, after it exits, sends one `git.collected`
// observation (commits made during the Run, PRs for the branch via `gh` when available) before the runner submits the
// result. Only `host/owner/repo`, SHAs, subjects, the branch and PR fields leave the device, never a local path.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitCollected } from "@hive/contracts";
import { runCwd } from "./environments.ts";
import type { AgentAdapter } from "./runner.ts";

/** Runs `file` with argv (no shell) in `cwd`; resolves trimmed stdout. Injected in tests. */
export type Exec = (file: string, args: string[], cwd: string) => Promise<string>;

const execFileAsync = promisify(execFile);
export const exec: Exec = async (file, args, cwd) =>
  (await execFileAsync(file, args, { cwd, timeout: 10_000 })).stdout.trim();

/**
 * `origin` URL → `host/owner/repo` without scheme, credentials, port or `.git`. Only URLs with a real host
 * (`scheme://[user@]host/path` or scp-style `[user@]host:path`) qualify; anything else (`file://`, a local path) is ''.
 */
export const normalizeRemote = (url: string) => {
  const m =
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:@]{2,})(?::\d+)?\/([^/].*?)(?:\.git)?\/?$/i.exec(
      url,
    ) ?? /^(?:[^@/:]+@)?([^/:@]{2,}):([^/].*?)(?:\.git)?\/?$/.exec(url);
  return m && m[2]!.includes("/") ? `${m[1]!.toLowerCase()}/${m[2]}` : "";
};

export type GitSnapshot = { before: string; repository: string; startedAt: string };

export const snapshot = async (cwd: string, run: Exec = exec): Promise<GitSnapshot> => {
  const [before, remote] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], cwd).catch(() => ""),
    run("git", ["remote", "get-url", "origin"], cwd).catch(() => ""),
  ]);
  return { before, repository: normalizeRemote(remote), startedAt: new Date().toISOString() };
};

// A fixed reason: gh's stderr may name local paths.
const ghFailure = (error: unknown) => {
  const e = error as { code?: unknown; killed?: boolean };
  if (e.code === "ENOENT") return "gh not found";
  if (e.killed) return "gh timed out";
  if (typeof e.code === "number") return `gh exited with ${e.code}`;
  return error instanceof SyntaxError ? "gh output was not JSON" : "gh failed";
};

/** What Git produced since `snap`; null when `cwd` has no HEAD (not a checkout, or still no commit). */
export const collect = async (
  cwd: string,
  snap: GitSnapshot,
  run: Exec = exec,
): Promise<GitCollected | null> => {
  const after = await run("git", ["rev-parse", "HEAD"], cwd).catch(() => null);
  if (after === null) return null;
  const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  // `before` gone from HEAD's history (branch switch, rewrite): fall back to commits since the Run started.
  const ancestor =
    snap.before === "" ||
    (await run("git", ["merge-base", "--is-ancestor", snap.before, "HEAD"], cwd).then(
      () => true,
      () => false,
    ));
  const range =
    snap.before === ""
      ? ["HEAD"]
      : ancestor
        ? [`${snap.before}..HEAD`]
        : ["HEAD", `--since=${snap.startedAt}`];
  const log = await run("git", ["log", "-n", "200", "--format=%H%x1f%aI%x1f%s", ...range], cwd);
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, authoredAt, subject] = line.split("\x1f");
      return { sha: sha!, authoredAt: authoredAt!, subject: subject!.slice(0, 1000) };
    });
  let prs: GitCollected["prs"] = [];
  let prError: string | undefined;
  if (snap.repository && branch !== "HEAD") {
    try {
      const listed = JSON.parse(
        await run(
          "gh",
          ["pr", "list", "--head", branch, "--json", "number,url,state,title", "--limit", "20"],
          cwd,
        ),
      ) as GitCollected["prs"];
      prs = listed.map(({ number, url, state, title }) => ({
        number,
        url,
        state,
        title: title.slice(0, 1000),
      }));
    } catch (error) {
      prError = ghFailure(error);
    }
  }
  return {
    repository: snap.repository,
    branch,
    before: snap.before,
    after,
    commits,
    partial: !ancestor,
    prs,
    ...(prError ? { prError } : {}),
  };
};

/**
 * Wraps an adapter: environment Runs get a snapshot before the start and one `git.collected` observation after the exit,
 * before `waitForExit` resolves (so before the result). Collection or send failures are logged; the Run still submits.
 * A SIGTERM exit reports nothing: the Run stays active for reconcile.
 */
export const withGitCollector = (
  inner: AgentAdapter,
  { stateDir, run = exec }: { stateDir: string; run?: Exec },
): AgentAdapter => ({
  start: async (ctx) => {
    const cwd =
      ctx.context.bot.toolPolicy.cwdMode === "environment"
        ? await runCwd(stateDir, ctx.runId, ctx.context)
        : null;
    const snap = cwd ? await snapshot(cwd, run) : null;
    const agent = await inner.start(ctx);
    if (!cwd || !snap) return agent;
    return {
      requestStop: (reason) => agent.requestStop(reason),
      waitForExit: async () => {
        const exit = await agent.waitForExit();
        if (exit.reason === "sigterm") return exit;
        try {
          const git = await collect(cwd, snap, run);
          if (git) await ctx.observe("git.collected", git);
        } catch (error) {
          console.error("git collection failed", error);
        }
        return exit;
      },
    };
  },
});
