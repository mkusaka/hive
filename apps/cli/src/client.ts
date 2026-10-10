// HTTP client for the user API (docs/architecture.md §22). Web-standard APIs only: the api-worker e2e test
// runs it inside workerd with `fetch` backed by `app.request`.
import type { ApiError } from "@hive/contracts";

export type Fetch = (input: URL, init: RequestInit) => Promise<Response>;

// No parameter properties: Node's type stripping rejects them.
export class CliError extends Error {
  override name = "CliError";
  /** `ApiError.code`, or a CLI-side code (`INVALID_ARGS`, `NETWORK`, `HTTP`, `JOB_FAILED`, `TIMEOUT`). */
  readonly code: string;
  readonly exitCode: number;
  /** The API error body, printed as-is with `--format json`. */
  readonly body: unknown;
  constructor(code: string, exitCode: number, message: string, body?: unknown) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.body = body;
  }
}

/** docs/architecture.md §23: 2 invalid input, 3 auth/permission, 4 conflict, 7 network / not accepted. */
export const exitCodeFor = (status: number) =>
  status === 422 || status === 400
    ? 2
    : status === 401 || status === 403
      ? 3
      : status === 409
        ? 4
        : 7;

export const invalid = (message: string) => new CliError("INVALID_ARGS", 2, message);

export type Client = ReturnType<typeof createClient>;

export const createClient = (opts: { apiUrl: string; accessJwt?: string; fetch: Fetch }) => {
  const request = async (method: "GET" | "POST", path: string, body?: unknown) => {
    if (!opts.accessJwt) {
      throw new CliError(
        "UNAUTHENTICATED",
        3,
        "no Access assertion: set HIVE_ACCESS_JWT or accessJwt in the credentials file",
      );
    }
    const res = await opts
      .fetch(new URL(path, opts.apiUrl), {
        method,
        headers: { "Cf-Access-Jwt-Assertion": opts.accessJwt, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      .catch((error: unknown) => {
        throw new CliError("NETWORK", 7, `request failed: ${String(error)}`);
      });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error = (json ?? {}) as Partial<ApiError>;
      throw new CliError(
        error.code ?? "HTTP",
        exitCodeFor(res.status),
        error.message ?? `HTTP ${res.status}`,
        json,
      );
    }
    return json as Record<string, unknown>;
  };
  return {
    get: (path: string) => request("GET", path),
    command: (
      envelope: { operationId: string; idempotencyKey: string; workspaceId: string },
      command: { type: string } & Record<string, unknown>,
    ) => request("POST", "/v1/commands", { ...envelope, command }),
  };
};
