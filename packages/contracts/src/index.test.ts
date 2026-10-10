import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { eventEnvelope, parse } from "./index.ts";

const BuildFailed = eventEnvelope(v.strictObject({ command: v.string(), exitCode: v.number() }));

const valid = {
  id: "evt-1",
  workspaceId: "ws-1",
  type: "custom.build.failed",
  schemaVersion: 1,
  source: { kind: "cli", deviceId: "pc1" },
  actor: { kind: "user", id: "user-1" },
  subject: null,
  data: { command: "bun test", exitCode: 1 },
  correlationId: "corr-1",
  causationId: null,
  occurredAt: "2026-10-11T00:00:00Z",
  receivedAt: "2026-10-11T00:00:01Z",
  expiresAt: null,
};

describe("EventEnvelope", () => {
  it("round-trips a valid envelope", () => {
    const result = parse(BuildFailed, JSON.parse(JSON.stringify(valid)));
    expect(result).toEqual({ ok: true, value: valid });
  });

  it("rejects malformed envelopes", () => {
    const { receivedAt: _, ...missing } = valid;
    expect(parse(BuildFailed, missing).ok).toBe(false);
    expect(parse(BuildFailed, { ...valid, extra: true }).ok).toBe(false);
    expect(parse(BuildFailed, { ...valid, source: { kind: "email" } }).ok).toBe(false);
    expect(parse(BuildFailed, { ...valid, data: { command: "x" } }).ok).toBe(false);
  });
});
