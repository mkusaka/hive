import type { ApiResult } from "@hive/sync";
import * as Crypto from "expo-crypto";
import * as v from "valibot";
import { accessToken, type Session } from "./session";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Client = {
  request(path: string, method?: string, body?: unknown): Promise<Record<string, unknown>>;
  get(path: string): Promise<ApiResult>;
  command(command: Record<string, unknown>, workspaceId?: string): Promise<Record<string, unknown>>;
};

export const client = (session: Session): Client => {
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Record<string, unknown>> => {
    const token = await accessToken(session);
    const response = await fetch(`${session.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(session.devToken ? { "Cf-Access-Jwt-Assertion": token } : {}),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = v.parse(v.record(v.string(), v.unknown()), await response.json());
    if (!response.ok) {
      const error = v.parse(v.object({ code: v.optional(v.string()), message: v.string() }), value);
      throw new ApiError(error.code ?? `HTTP_${response.status}`, error.message);
    }
    return value;
  };
  return {
    request,
    get: async (path: string): Promise<ApiResult> => {
      try {
        return { ok: true, value: await request(path) };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error instanceof ApiError ? error.code : "NETWORK",
            message: error instanceof Error ? error.message : "Request failed",
          },
        };
      }
    },
    command: (command: Record<string, unknown>, workspaceId = session.workspaceId) =>
      request("/v1/commands", "POST", {
        operationId: Crypto.randomUUID(),
        idempotencyKey: Crypto.randomUUID(),
        workspaceId,
        command,
      }),
  };
};
export const inWorkspace = (
  workspaceId: string,
  resource: string,
  query: Record<string, string> = {},
) => `/v1/${resource}?${new URLSearchParams({ workspaceId, ...query })}`;
