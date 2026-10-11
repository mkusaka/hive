// HTTPS client for the executor routes (docs/architecture.md §9.2). Web-standard APIs only, so the runner
// also runs inside workerd tests with an injected `fetch`.
import type {
  ApiError,
  ApprovalStatus,
  ExecutorCommand,
  ExecutorRun,
  JobClaimed,
  LeaseRenewed,
  QueuedJob,
  RunCommand,
  RunContext,
  RunObservation,
} from "@hive/contracts";

// No parameter properties: Node's type stripping rejects them.
export class CloudError extends Error {
  override name = "CloudError";
  readonly status: number;
  /** `ApiError.code`, or `HTTP` when the body is not an ApiError. */
  readonly code: string;
  readonly reason: string | undefined;
  constructor(status: number, code: string, message: string, reason?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

/** `/v1/run/*` with a Run capability (§18.2): what the in-run hive tools call. */
export type RunApi = {
  command(body: RunCommand): Promise<Record<string, unknown>>;
  getTask(taskId: string): Promise<Record<string, unknown>>;
  /** The Run's own approval (§19), polled while a tool call waits for a human. */
  getApproval(approvalId: string): Promise<ApprovalStatus>;
};

export type CloudClient = {
  heartbeat(): Promise<void>;
  listQueuedJobs(limit: number): Promise<QueuedJob[]>;
  claim(input: { jobId: string; expectedRevision: number }): Promise<JobClaimed>;
  renewLease(input: { runId: string; executionGeneration: number }): Promise<LeaseRenewed>;
  submitResult(input: {
    runId: string;
    executionGeneration: number;
    state: "succeeded" | "failed" | "waiting";
    waitingFor?: { requestMessageId: string };
    summary: string;
    error?: string;
    reply?: { conversationId: string; text: string };
  }): Promise<void>;
  getRun(runId: string): Promise<ExecutorRun>;
  getRunContext(input: {
    jobId: string;
    runId: string;
    executionGeneration: number;
  }): Promise<RunContext>;
  observe(input: RunObservation): Promise<void>;
  /** A client acting as the Run behind `capabilityToken`. */
  forRun(capabilityToken: string): RunApi;
};

export const createCloudClient = ({
  apiUrl,
  token,
  fetch: fetchImpl = fetch,
}: {
  apiUrl: string;
  token: string;
  fetch?: (input: URL, init: RequestInit) => Promise<Response>;
}): CloudClient => {
  const request = async <T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    bearer: string = token,
  ) => {
    const res = await fetchImpl(new URL(path, apiUrl), {
      method,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error = (json ?? {}) as Partial<ApiError>;
      throw new CloudError(
        res.status,
        error.code ?? "HTTP",
        error.message ?? `HTTP ${res.status}`,
        error.reason,
      );
    }
    return json as T;
  };

  // A device belongs to exactly one Workspace; learned once from the principal.
  let workspaceId: Promise<string> | undefined;
  const workspace = () =>
    (workspaceId ??= request<{ workspaceIds: string[] }>("GET", "/v1/executor/me").then(
      (me) => me.workspaceIds[0]!,
      (error: unknown) => {
        workspaceId = undefined;
        throw error;
      },
    ));

  // Claim and result keys are derived from what they act on, so a retry after a lost response replays the
  // stored receipt instead of acting twice.
  const command = async <T>(body: ExecutorCommand, idempotencyKey: string) =>
    request<T>("POST", "/v1/executor/commands", {
      operationId: crypto.randomUUID(),
      idempotencyKey,
      workspaceId: await workspace(),
      command: body,
    });

  return {
    heartbeat: async () => {
      await request("POST", "/v1/executor/heartbeat", {});
    },
    listQueuedJobs: async (limit) =>
      (await request<{ jobs: QueuedJob[] }>("GET", `/v1/executor/jobs?state=queued&limit=${limit}`))
        .jobs,
    claim: (input) =>
      command(
        { type: "job.claim", ...input },
        `job.claim:${input.jobId}:${input.expectedRevision}`,
      ),
    renewLease: (input) => command({ type: "run.lease.renew", ...input }, crypto.randomUUID()),
    submitResult: async (input) => {
      await command(
        { type: "run.result.submit", ...input },
        `run.result.submit:${input.runId}:${input.executionGeneration}`,
      );
    },
    getRun: (runId) => request("GET", `/v1/executor/runs/${encodeURIComponent(runId)}`),
    getRunContext: ({ jobId, runId, executionGeneration }) =>
      request(
        "GET",
        `/v1/executor/jobs/${encodeURIComponent(jobId)}/context?${new URLSearchParams({
          runId,
          executionGeneration: String(executionGeneration),
        })}`,
      ),
    observe: async (input) => {
      await request("POST", "/v1/executor/observations", input);
    },
    forRun: (capabilityToken) => ({
      // A random key per call: each tool call is a new operation (the model retries by calling again).
      command: async (body) =>
        request(
          "POST",
          "/v1/run/commands",
          {
            operationId: crypto.randomUUID(),
            idempotencyKey: crypto.randomUUID(),
            workspaceId: await workspace(),
            command: body,
          },
          capabilityToken,
        ),
      getTask: (taskId) =>
        request("GET", `/v1/run/tasks/${encodeURIComponent(taskId)}`, undefined, capabilityToken),
      getApproval: (approvalId) =>
        request(
          "GET",
          `/v1/run/approvals/${encodeURIComponent(approvalId)}`,
          undefined,
          capabilityToken,
        ),
    }),
  };
};
