// IPC argument validation and the HTTP calls behind it. No `electron` import, so it runs under vitest.
import { CliError, type Client } from "@hive/cli/client";
import { AgentSend, commandEnvelope, JobCancel, parse } from "@hive/contracts";
import * as v from "valibot";
import type { ApiResult } from "../shared/api.ts";

/**
 * A `/v1/...` path with an optional query. Path segments allow no `.` or `%`, so neither a literal nor an
 * encoded `..` can climb out of `/v1/`; `..` is rejected anywhere anyway.
 */
export const ApiPath = v.pipe(
  v.string(),
  v.maxLength(2048),
  v.regex(/^\/v1(\/[\w-]+)+(\?[\w\-=&%.~]*)?$/, "must be a /v1/... path"),
  v.check((path) => !path.includes(".."), "must not contain .."),
);

export const UiCommandSchema = commandEnvelope(v.variant("type", [AgentSend, JobCancel]));

const invalid = (issues: string[]): ApiResult => ({
  ok: false,
  error: { code: "INVALID_ARGS", message: issues.join("; ") },
});

/** Maps the CLI client's `CliError` (which carries the `ApiError` code and body) to a result. */
export const toResult = async (
  call: () => Promise<Record<string, unknown>>,
): Promise<ApiResult> => {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (error instanceof CliError) {
      return { ok: false, error: { code: error.code, message: error.message, body: error.body } };
    }
    return { ok: false, error: { code: "INTERNAL", message: String(error) } };
  }
};

export const handlers = (client: Client) => ({
  get: (path: unknown) => {
    const parsed = parse(ApiPath, path);
    return parsed.ok
      ? toResult(() => client.get(parsed.value))
      : Promise.resolve(invalid(parsed.issues));
  },
  command: (envelope: unknown) => {
    const parsed = parse(UiCommandSchema, envelope);
    if (!parsed.ok) return Promise.resolve(invalid(parsed.issues));
    const { command, ...rest } = parsed.value;
    return toResult(() => client.command(rest, command));
  },
});
