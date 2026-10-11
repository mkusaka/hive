// HTTPS client for the executor routes (docs/architecture.md §9.2). Web-standard APIs only, so the runner
// also runs inside workerd tests with an injected `fetch`.
import type {
  ApiError,
  ApprovalStatus,
  Effect,
  ExecutorCommand,
  ExecutorHeartbeat,
  ExecutorRun,
  JobClaimed,
  LeaseRenewed,
  QueuedJob,
  RunCommand,
  RunContext,
  RunObservation,
  SearchResult,
  SessionStreamKey,
  UploadComplete,
  UploadInit,
  UploadInitialized,
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
  /** The Run's own external effect (§19), polled while an effect tool waits for it to settle. */
  getEffect(effectId: string): Promise<Effect>;
  /** Search limited to what the Run may read (its Workspace, Channel, Bot and Task scopes). */
  search(q: string): Promise<SearchResult>;
};

export type CloudClient = {
  /** Also reports capabilities / capacity (§10.1); an omitted field keeps the stored value. */
  heartbeat(body?: ExecutorHeartbeat): Promise<void>;
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
  /** Transcript upload (§3.3) with the device token: also after the Run's capability was revoked. */
  uploadInit(input: UploadInit): Promise<UploadInitialized>;
  uploadPart(uploadId: string, bytes: Uint8Array): Promise<void>;
  uploadComplete(input: UploadComplete): Promise<void>;
  /** The newest complete snapshot of a native session stream (§13.3), raw JSONL; null when there is none. */
  getSessionSnapshot(provider: string, session: SessionStreamKey): Promise<Uint8Array | null>;
  /** A client acting as the Run behind `capabilityToken`. */
  forRun(capabilityToken: string): RunApi;
};

/** This device's Access Service Token (§18.1); Access checks it before the Worker sees the device token. */
export type AccessServiceToken = { clientId: string; clientSecret: string };

export const serviceTokenHeaders = (service?: AccessServiceToken): Record<string, string> =>
  service
    ? { "CF-Access-Client-Id": service.clientId, "CF-Access-Client-Secret": service.clientSecret }
    : {};

export const createCloudClient = ({
  apiUrl,
  token,
  accessService,
  fetch: fetchImpl = fetch,
}: {
  apiUrl: string;
  token: string;
  /** Omitted against `wrangler dev`, which has no Access in front. */
  accessService?: AccessServiceToken;
  fetch?: (input: URL, init: RequestInit) => Promise<Response>;
}): CloudClient => {
  const send = async (
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    bearer: string = token,
  ) => {
    // Bytes go as a raw body (a transcript part); anything else as JSON.
    const raw = body instanceof Uint8Array;
    const res = await fetchImpl(new URL(path, apiUrl), {
      method,
      headers: {
        ...serviceTokenHeaders(accessService),
        // Not `Authorization`: behind Access with Managed OAuth that header belongs to Access.
        "X-Hive-Token": bearer,
        "Content-Type": raw ? "application/octet-stream" : "application/json",
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    if (!res.ok) {
      const error = ((await res.json().catch(() => null)) ?? {}) as Partial<ApiError>;
      throw new CloudError(
        res.status,
        error.code ?? "HTTP",
        error.message ?? `HTTP ${res.status}`,
        error.reason,
      );
    }
    return res;
  };
  const request = async <T>(...args: Parameters<typeof send>) =>
    (await (await send(...args)).json().catch(() => null)) as T;

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
    heartbeat: async (body = {}) => {
      await request("POST", "/v1/executor/heartbeat", body);
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
    uploadInit: (input) => request("POST", "/v1/executor/uploads/init", input),
    uploadPart: async (uploadId, bytes) => {
      await request("PUT", `/v1/executor/uploads/${encodeURIComponent(uploadId)}`, bytes);
    },
    uploadComplete: async (input) => {
      await request("POST", "/v1/executor/uploads/complete", input);
    },
    getSessionSnapshot: async (provider, { sessionId, subpath }) => {
      const query = subpath ? `?${new URLSearchParams({ subpath })}` : "";
      const path = `/v1/executor/sessions/${encodeURIComponent(provider)}/${encodeURIComponent(sessionId)}${query}`;
      try {
        return new Uint8Array(await (await send("GET", path)).arrayBuffer());
      } catch (error) {
        if (error instanceof CloudError && error.code === "NOT_FOUND") return null;
        throw error;
      }
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
      getEffect: (effectId) =>
        request(
          "GET",
          `/v1/run/effects/${encodeURIComponent(effectId)}`,
          undefined,
          capabilityToken,
        ),
      search: (q) =>
        request("GET", `/v1/run/search?${new URLSearchParams({ q })}`, undefined, capabilityToken),
    }),
  };
};
