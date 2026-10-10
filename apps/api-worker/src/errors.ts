import { type ApiError, type ApiErrorCode, apiErrorStatus } from "@hive/contracts";
import { IdempotencyConflict } from "@hive/db";
import type { Context } from "hono";
import type { AppEnv } from "./app.ts";

export class HttpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly retryable = false,
    readonly reason?: string,
  ) {
    super(message);
  }
}

export const toErrorResponse = (error: Error, c: Context<AppEnv>) => {
  const requestId = c.get("requestId");
  if (error instanceof IdempotencyConflict) {
    error = new HttpError("IDEMPOTENCY_CONFLICT", error.message);
  }
  if (!(error instanceof HttpError)) {
    console.error(error);
    return c.json({ message: "internal error", requestId }, 500);
  }
  const body: ApiError = {
    code: error.code,
    message: error.message,
    requestId,
    operationId: c.get("operationId") ?? null,
    retryable: error.retryable,
    ...(error.reason ? { reason: error.reason } : {}),
  };
  return c.json(body, apiErrorStatus[error.code]);
};
