// Job runner (docs/architecture.md §9.2, §20.2): heartbeat → list → claim → journal intent → adapter →
// result, renewing the lease while the agent runs. Web-standard APIs only; the journal is injected.
// Claims, runs and reconciles are sequential on purpose: one Run at a time per executor (capacity 1).
/* oxlint-disable no-await-in-loop */
import { CloudError, type CloudClient } from "./cloudClient.ts";

export type JournalEntry =
  | {
      kind: "claim";
      runId: string;
      jobId: string;
      executionGeneration: number;
      inboxItemId: string | null;
    }
  | { kind: "intent"; runId: string }
  | { kind: "result"; runId: string; state: string };

/** Local Journal (§20.2): append-only; an entry is durable once `append` resolves. */
export type Journal = {
  append(entry: JournalEntry): Promise<void>;
  readAll(): Promise<JournalEntry[]>;
};

// The subset of the §20.4 adapter contract the runner uses.
export type LaunchContext = {
  runId: string;
  jobId: string;
  executionGeneration: number;
  inboxItemId: string | null;
};
export type RunningAgent = {
  requestStop(reason: string): Promise<void>;
  waitForExit(): Promise<{ code: number | null; reason: string; summary: string }>;
};
export type AgentAdapter = { start(input: LaunchContext): Promise<RunningAgent> };

export type RunnerDeps = { cloud: CloudClient; journal: Journal; adapter: AgentAdapter };

const isStale = (error: unknown) =>
  error instanceof CloudError && error.code === "STALE_GENERATION";

/**
 * Runs one claimed (or resumed) Run to its result. Records the launch intent before starting the agent and
 * renews the lease every quarter of its remaining time. A stale generation stops the agent and submits nothing.
 */
const execute = async (deps: RunnerDeps, ctx: LaunchContext, leaseExpiresAt: string) => {
  const { cloud, journal } = deps;
  const fence = { runId: ctx.runId, executionGeneration: ctx.executionGeneration };
  await journal.append({ kind: "intent", runId: ctx.runId });
  const agent = await deps.adapter.start(ctx);

  let stale = false;
  const renewEveryMs = Math.max(1, (Date.parse(leaseExpiresAt) - Date.now()) / 4);
  const timer = setInterval(() => {
    cloud.renewLease(fence).catch(async (error: unknown) => {
      if (!isStale(error)) return console.error("lease renewal failed", error);
      stale = true;
      clearInterval(timer);
      await agent.requestStop("stale_generation");
    });
  }, renewEveryMs);
  const exit = await agent.waitForExit().finally(() => clearInterval(timer));

  const outcome = exit.code === 0 ? "succeeded" : "failed";
  if (!stale) {
    try {
      await cloud.submitResult({
        ...fence,
        state: outcome,
        summary: exit.summary,
        ...(outcome === "failed" ? { error: exit.reason } : {}),
      });
    } catch (error) {
      if (!isStale(error)) throw error;
      stale = true;
    }
  }
  const state = stale ? "stale_generation" : outcome;
  await journal.append({ kind: "result", runId: ctx.runId, state });
  return { runId: ctx.runId, jobId: ctx.jobId, state };
};

/**
 * Startup reconcile (§20.2): every journaled claim without a result is checked against the cloud. An active
 * Run of the same generation is resumed (the fake adapter is idempotent); anything else gets a result marker.
 */
export const reconcile = async (deps: RunnerDeps) => {
  const entries = await deps.journal.readAll();
  const done = new Set(entries.flatMap((e) => (e.kind === "result" ? [e.runId] : [])));
  const resumed = [];
  for (const entry of entries) {
    if (entry.kind !== "claim" || done.has(entry.runId)) continue;
    const run = await deps.cloud.getRun(entry.runId).catch((error: unknown) => {
      if (error instanceof CloudError && error.code === "NOT_FOUND") return null;
      throw error;
    });
    const fence = { runId: entry.runId, executionGeneration: entry.executionGeneration };
    if (run?.active && run.executionGeneration === entry.executionGeneration) {
      const lease = await deps.cloud.renewLease(fence).catch((error: unknown) => {
        if (isStale(error)) return null;
        throw error;
      });
      if (lease) {
        resumed.push(await execute(deps, entry, lease.leaseExpiresAt));
        continue;
      }
    }
    const state = run && !run.active ? run.state : "stale_generation";
    await deps.journal.append({ kind: "result", runId: entry.runId, state });
  }
  return resumed;
};

/** One poll: heartbeat, then claim and run the first queued Job this device wins. Null when none. */
export const runOnce = async (deps: RunnerDeps) => {
  await deps.cloud.heartbeat();
  for (const job of await deps.cloud.listQueuedJobs(10)) {
    const claim = await deps.cloud
      .claim({ jobId: job.id, expectedRevision: job.revision })
      .catch((error: unknown) => {
        // Lost the race or not eligible: try the next Job.
        if (error instanceof CloudError && (error.status === 409 || error.status === 403)) {
          return null;
        }
        throw error;
      });
    if (!claim) continue;
    const ctx: LaunchContext = {
      runId: claim.runId,
      jobId: claim.job.id,
      executionGeneration: claim.executionGeneration,
      inboxItemId: claim.job.inboxItemId,
    };
    await deps.journal.append({ kind: "claim", ...ctx });
    return execute(deps, ctx, claim.leaseExpiresAt);
  }
  return null;
};

/** Reconcile, then poll. `once` handles at most one queued Job and returns. */
export const runLoop = async (deps: RunnerDeps, options: { once: boolean; pollMs: number }) => {
  await reconcile(deps);
  if (options.once) return runOnce(deps);
  for (;;) {
    const ran = await runOnce(deps).catch((error: unknown) => {
      console.error("poll failed", error);
      return null;
    });
    if (!ran) await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
};
