// Job runner (docs/architecture.md §9.2, §20.2): heartbeat → list → claim → journal intent → adapter →
// result, renewing the lease while the agent runs. Web-standard APIs only; the journal is injected.
// Claims, runs and reconciles are sequential on purpose within one worker loop; `--concurrency N` runs N loops, and
// the cloud caps the device's active root Runs at the capacity the heartbeat reports.
/* oxlint-disable no-await-in-loop */
import type { ExecutorHeartbeat, RunContext } from "@hive/contracts";
import { CloudError, type CloudClient, type RunApi } from "./cloudClient.ts";
import type { Uploader } from "./uploader.ts";

export type JournalEntry =
  | {
      kind: "claim";
      runId: string;
      jobId: string;
      executionGeneration: number;
      inboxItemId: string | null;
    }
  | { kind: "intent"; runId: string }
  | { kind: "result"; runId: string; state: string }
  /** The cloud ACKed the transcript's `complete` (AT-21: written only after the ACK). */
  | { kind: "uploaded"; runId: string; lastPartSeq: number };

/** Local Journal (§20.2): append-only; an entry is durable once `append` resolves. */
export type Journal = {
  append(entry: JournalEntry): Promise<void>;
  readAll(): Promise<JournalEntry[]>;
};

// The subset of the §20.4 adapter contract the runner uses.
export type ClaimedRun = {
  runId: string;
  jobId: string;
  executionGeneration: number;
  inboxItemId: string | null;
};
export type LaunchContext = ClaimedRun & {
  /** From `GET /v1/executor/jobs/:id/context`, fetched after the claim. */
  context: RunContext;
  /**
   * `/v1/run/*` bound to the Run's capability (§18.2), for the in-run hive tools; the token itself stays here, never
   * in a prompt. Null for a Run resumed after a restart: the token is returned once and not journaled.
   */
  run: RunApi | null;
  /** Sends a fenced runtime observation for this Run (§9.2 step 7). */
  observe(kind: string, payload: Record<string, unknown>): Promise<void>;
};
export type RunningAgent = {
  requestStop(reason: string): Promise<void>;
  /**
   * `replyText` is posted to the trigger Conversation as the Bot's message. `waitingFor`: the agent stopped to wait
   * for the reply to that request (§8.2); the Run is submitted as `waiting`.
   */
  waitForExit(): Promise<{
    code: number | null;
    reason: string;
    summary: string;
    replyText?: string;
    waitingFor?: { requestMessageId: string };
  }>;
};
export type AgentAdapter = { start(input: LaunchContext): Promise<RunningAgent> };

/**
 * `uploader`: sends each Run's transcript after its result (uploader.ts); none means transcripts stay local.
 * `heartbeat`: capabilities / capacity reported with each poll (capabilities.ts).
 */
export type RunnerDeps = {
  cloud: CloudClient;
  journal: Journal;
  adapter: AgentAdapter;
  uploader?: Uploader;
  heartbeat?: ExecutorHeartbeat;
};

const isStale = (error: unknown) =>
  error instanceof CloudError && error.code === "STALE_GENERATION";

/**
 * Confirms to the cloud that a Run's agent is not running (§10.4): an `unknown` Run becomes `interrupted` and frees
 * its reservations, so a human may retry the Job. The adapter runs in-process, so once `waitForExit` resolved (or
 * after a restart) nothing is left running. Best effort: false when the cloud could not be told.
 */
const confirmStopped = (
  cloud: CloudClient,
  fence: { runId: string; executionGeneration: number },
) =>
  cloud.observe({ ...fence, kind: "runtime.run.stopped", payload: { confirmed: true } }).then(
    () => true,
    (error: unknown) => {
      console.error("stop confirmation failed", error);
      return false;
    },
  );

/**
 * Runs one claimed (or resumed) Run to its result. Records the launch intent before starting the agent and
 * renews the lease every quarter of its remaining time. A stale generation stops the agent, submits nothing and
 * confirms the stop. `cancelRequested` on renewal stops the agent and submits `failed` with error `cancelled`.
 */
const execute = async (
  deps: RunnerDeps,
  claimed: ClaimedRun,
  leaseExpiresAt: string,
  capabilityToken?: string,
) => {
  const { cloud, journal } = deps;
  const fence = { runId: claimed.runId, executionGeneration: claimed.executionGeneration };
  const ctx: LaunchContext = {
    ...claimed,
    context: await cloud.getRunContext({ jobId: claimed.jobId, ...fence }),
    run: capabilityToken ? cloud.forRun(capabilityToken) : null,
    observe: (kind, payload) => cloud.observe({ ...fence, kind, payload }),
  };
  await journal.append({ kind: "intent", runId: ctx.runId });
  const agent = await deps.adapter.start(ctx);

  let stale = false;
  let cancelled = false;
  const renewEveryMs = Math.max(1, (Date.parse(leaseExpiresAt) - Date.now()) / 4);
  const timer = setInterval(() => {
    cloud.renewLease(fence).then(
      async (lease) => {
        if (!lease.cancelRequested || cancelled) return;
        cancelled = true;
        await agent.requestStop("cancelled");
      },
      async (error: unknown) => {
        if (!isStale(error)) return console.error("lease renewal failed", error);
        stale = true;
        clearInterval(timer);
        await agent.requestStop("stale_generation");
      },
    );
  }, renewEveryMs);
  const exit = await agent.waitForExit().finally(() => clearInterval(timer));

  const outcome =
    exit.code !== 0 || cancelled ? "failed" : exit.waitingFor ? "waiting" : "succeeded";
  const conversation = ctx.context.conversation;
  // A Bot answers a bot request with its reply tool, so the final text is posted only in a Channel.
  const reply =
    outcome === "succeeded" && exit.replyText && conversation?.kind === "channel"
      ? { reply: { conversationId: conversation.id, text: exit.replyText } }
      : {};
  if (!stale) {
    try {
      await cloud.submitResult({
        ...fence,
        state: outcome,
        summary: exit.summary,
        ...(outcome === "failed" ? { error: cancelled ? "cancelled" : exit.reason } : {}),
        ...(outcome === "waiting" ? { waitingFor: exit.waitingFor } : {}),
        ...reply,
      });
    } catch (error) {
      if (!isStale(error)) throw error;
      stale = true;
    }
  }
  // The agent has exited: an `unknown` Run can be confirmed stopped right away.
  const state = !stale
    ? outcome
    : (await confirmStopped(cloud, fence))
      ? "stopped"
      : "stale_generation";
  await journal.append({ kind: "result", runId: ctx.runId, state });
  // Also after a stale generation: late parts are kept as the attempt's history (§10.3).
  await deps.uploader?.upload(ctx.runId);
  return { runId: ctx.runId, jobId: ctx.jobId, state };
};

/**
 * Startup reconcile (§20.2): every journaled claim without a result, or whose last result is an unconfirmed
 * `stale_generation`, is checked against the cloud. An active Run of the same generation without a result is resumed
 * (the fake adapter is idempotent). An `unknown` Run is confirmed stopped: nothing survives a restart, because the
 * adapter runs in-process. Anything else gets a result marker. Then pending transcript uploads are retried.
 */
export const reconcile = async (deps: RunnerDeps) => {
  const entries = await deps.journal.readAll();
  const last = new Map(entries.flatMap((e) => (e.kind === "result" ? [[e.runId, e.state]] : [])));
  const resumed = [];
  for (const entry of entries) {
    if (entry.kind !== "claim") continue;
    const result = last.get(entry.runId);
    if (result !== undefined && result !== "stale_generation") continue;
    const run = await deps.cloud.getRun(entry.runId).catch((error: unknown) => {
      if (error instanceof CloudError && error.code === "NOT_FOUND") return null;
      throw error;
    });
    const fence = { runId: entry.runId, executionGeneration: entry.executionGeneration };
    if (run?.state === "unknown") {
      if (await confirmStopped(deps.cloud, fence)) {
        await deps.journal.append({ kind: "result", runId: entry.runId, state: "stopped" });
      }
      continue;
    }
    if (
      result === undefined &&
      run?.active &&
      run.executionGeneration === entry.executionGeneration
    ) {
      const lease = await deps.cloud.renewLease(fence).catch((error: unknown) => {
        if (isStale(error)) return null;
        throw error;
      });
      if (lease) {
        resumed.push(await execute(deps, entry, lease.leaseExpiresAt));
        continue;
      }
    }
    // A Run the cloud no longer knows is `missing`, so a stale marker is not rechecked forever.
    const state = run && !run.active ? run.state : run ? "stale_generation" : "missing";
    if (state !== result) await deps.journal.append({ kind: "result", runId: entry.runId, state });
  }
  // Transcripts of finished Runs whose upload never got its ACK (crash, network, cloud error).
  await deps.uploader?.pending();
  return resumed;
};

/** One poll: heartbeat, then claim and run the first queued Job this device wins. Null when none. */
export const runOnce = async (deps: RunnerDeps) => {
  await deps.cloud.heartbeat(deps.heartbeat);
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
    const ctx: ClaimedRun = {
      runId: claim.runId,
      jobId: claim.job.id,
      executionGeneration: claim.executionGeneration,
      inboxItemId: claim.job.inboxItemId,
    };
    await deps.journal.append({ kind: "claim", ...ctx });
    return execute(deps, ctx, claim.leaseExpiresAt, claim.capability?.token);
  }
  return null;
};

/**
 * Reconcile, then poll. `once` handles at most one queued Job and returns. Otherwise `concurrency` (default 1) worker
 * loops poll side by side, so up to that many Runs execute at once; claim races between them end in a 409.
 */
export const runLoop = async (
  deps: RunnerDeps,
  options: { once: boolean; pollMs: number; concurrency?: number },
) => {
  await reconcile(deps);
  if (options.once) return runOnce(deps);
  const worker = async () => {
    for (;;) {
      const ran = await runOnce(deps).catch((error: unknown) => {
        console.error("poll failed", error);
        return null;
      });
      if (!ran) await new Promise((resolve) => setTimeout(resolve, options.pollMs));
    }
  };
  await Promise.all(Array.from({ length: options.concurrency ?? 1 }, worker));
};
