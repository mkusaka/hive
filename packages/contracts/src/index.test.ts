import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  BotCreate,
  EventEmit,
  eventEnvelope,
  parse,
  PlacementPolicy,
  renderMentions,
  tokenizeMentions,
} from "./index.ts";

const placement = (p: object) => parse(PlacementPolicy, p).ok;
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

const emit = (event: object) => parse(EventEmit, { type: "event.emit", event });

describe("command schemas", () => {
  it("fills placement policy, instructions and deny-all tool policy defaults", () => {
    expect(parse(BotCreate, { type: "bot.create", name: "coder" })).toEqual({
      ok: true,
      value: {
        type: "bot.create",
        name: "coder",
        instructions: "",
        placementPolicy: {
          mode: "any",
          allowedDeviceIds: [],
          preferredDeviceIds: [],
          fallbackOnUnavailable: true,
          overflowToFallback: false,
          requiredCapabilities: [],
          recovery: "manual",
        },
        toolPolicy: { tools: {}, cwdMode: "run_scratch" },
      },
    });
  });

  it("rejects preferred devices outside the allowed list and a pinned placement without one device", () => {
    expect(placement({ allowedDeviceIds: ["pc1"], preferredDeviceIds: ["pc2"] })).toBe(false);
    expect(placement({ preferredDeviceIds: ["pc1", "pc2"] })).toBe(true);
    expect(placement({ mode: "pinned", allowedDeviceIds: ["pc1"] })).toBe(false);
    expect(placement({ mode: "pinned", preferredDeviceIds: ["pc1", "pc2"] })).toBe(false);
    expect(placement({ mode: "pinned", preferredDeviceIds: ["pc1"] })).toBe(true);
  });

  it("requires event data and caps it at 64 KiB of JSON bytes", () => {
    expect(emit({ type: "custom.build.failed", data: null }).ok).toBe(true);
    expect(emit({ type: "custom.build.failed" }).ok).toBe(false);
    expect(emit({ type: "Custom", data: 1 }).ok).toBe(false);
    // 3 bytes per char: under 64 Ki characters but over 64 KiB.
    expect(emit({ type: "custom.x", data: "あ".repeat(22_000) }).ok).toBe(false);
    expect(emit({ type: "custom.x", data: "a".repeat(60_000) }).ok).toBe(true);
  });
});

describe("mentions", () => {
  it("tokenizes @names (longest first, whole names only) and @everyone / @all; renders them back", () => {
    const bots = [
      { id: "b-1", name: "coder" },
      { id: "b-2", name: "coder-2" },
    ];
    const text = tokenizeMentions("@coder-2 @coder, @coderx @all hi@coder @everyone", bots);
    expect(text).toBe("<@bot:b-2> <@bot:b-1>, @coderx <@everyone> hi@coder <@everyone>");
    expect(renderMentions(text, new Map(bots.map((b) => [b.id, b.name])))).toBe(
      "@coder-2 @coder, @coderx @everyone hi@coder @everyone",
    );
  });
});
