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

/**
 * Access credentials, in precedence order: `accessJwt` (local dev: `HIVE_ACCESS_JWT` or the credentials file, sent
 * straight to `wrangler dev`), then `accessToken` (the Managed OAuth token; Access converts it into the assertion).
 */
export const createClient = (opts: {
  apiUrl: string;
  accessJwt?: string;
  accessToken?: () => Promise<string>;
  fetch: Fetch;
}) => {
  const auth = async (): Promise<Record<string, string>> => {
    if (opts.accessJwt) return { "Cf-Access-Jwt-Assertion": opts.accessJwt };
    if (!opts.accessToken)
      throw new CliError("LOGIN_REQUIRED", 3, "not logged in: run `hive login`");
    const token = await opts.accessToken().catch((error: unknown) => {
      if (error instanceof CliError) throw error;
      throw new CliError("UNAUTHENTICATED", 3, `Access login failed: ${String(error)}`);
    });
    return { Authorization: `Bearer ${token}` };
  };
  const send = async (
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: RequestInit["body"],
    contentType = "application/json",
  ) => {
    const headers = await auth();
    const res = await opts
      .fetch(new URL(path, opts.apiUrl), {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": contentType }) },
        body,
      })
      .catch((error: unknown) => {
        throw new CliError("NETWORK", 7, `request failed: ${String(error)}`);
      });
    if (!res.ok) {
      const json: unknown = await res.json().catch(() => null);
      const error = (json ?? {}) as Partial<ApiError>;
      throw new CliError(
        error.code ?? "HTTP",
        exitCodeFor(res.status),
        error.message ?? `HTTP ${res.status}`,
        json,
      );
    }
    return res;
  };
  const request = async (method: "GET" | "POST", path: string, body?: unknown) =>
    (await (
      await send(method, path, body === undefined ? undefined : JSON.stringify(body))
    )
      .json()
      .catch(() => null)) as Record<string, unknown>;
  return {
    /** The Access header alone, for the Realtime WebSocket upgrade. */
    accessHeaders: auth,
    get: (path: string) => request("GET", path),
    post: (path: string, body: Record<string, unknown>) => request("POST", path, body),
    putBytes: async (path: string, body: Uint8Array, contentType: string) =>
      (await (await send("PUT", path, body, contentType)).json().catch(() => null)) as Record<
        string,
        unknown
      >,
    getBytes: async (path: string) => new Uint8Array(await (await send("GET", path)).arrayBuffer()),
    /** A non-JSON body as text (the raw transcript). */
    getText: async (path: string) =>
      new TextDecoder().decode(await (await send("GET", path)).arrayBuffer()),
    command: (
      envelope: { operationId: string; idempotencyKey: string; workspaceId: string },
      command: { type: string } & Record<string, unknown>,
    ) => request("POST", "/v1/commands", { ...envelope, command }),
  };
};
