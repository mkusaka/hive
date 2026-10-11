import { describe, expect, it } from "vitest";
import {
  type FilterExpression,
  type FilterTarget,
  FilterExpression as FilterSchema,
  matchesEventType,
  matchesFilter,
  parse,
  SubscriptionCreate,
} from "./index.ts";

const pr: FilterTarget = {
  type: "github.pull_request.opened",
  source: { kind: "github" },
  subject: { kind: "pull_request", id: "42#7" },
  data: { repositoryId: 42, number: 7, action: "opened", labels: ["bug", "ui"], branch: "feat/x" },
};
const slack: FilterTarget = {
  type: "slack.app_mention",
  source: { kind: "slack" },
  subject: null,
  data: { slackChannelId: "C1", text: "Please Deploy now" },
};
const match = (filter: FilterExpression, target = pr) => matchesFilter(filter, target);

describe("matchesFilter", () => {
  it("compares fields", () => {
    expect(match({ op: "eq", field: "data.repositoryId", value: 42 })).toBe(true);
    expect(match({ op: "eq", field: "data.repositoryId", value: "42" })).toBe(false);
    expect(match({ op: "neq", field: "data.action", value: "closed" })).toBe(true);
    expect(match({ op: "in", field: "data.number", value: [1, 7] })).toBe(true);
    expect(match({ op: "contains", field: "data.labels", value: "bug" })).toBe(true);
    expect(match({ op: "contains", field: "data.labels", value: "bu" })).toBe(false);
    expect(match({ op: "prefix", field: "data.branch", value: "feat/" })).toBe(true);
    expect(match({ op: "eq", field: "subject.kind", value: "pull_request" })).toBe(true);
    expect(match({ op: "contains", field: "data.text", value: "deploy" }, slack)).toBe(true);
  });

  it("treats a missing field as matching only neq", () => {
    expect(match({ op: "eq", field: "data.slackChannelId", value: "C1" })).toBe(false);
    expect(match({ op: "neq", field: "data.slackChannelId", value: "C1" })).toBe(true);
    expect(match({ op: "contains", field: "data.text", value: "x" })).toBe(false);
    expect(match({ op: "eq", field: "subject.id", value: "x" }, slack)).toBe(false);
  });

  it("combines with and / or / not", () => {
    const repo = { op: "eq", field: "data.repositoryId", value: 42 } as const;
    const closed = { op: "eq", field: "data.action", value: "closed" } as const;
    expect(match({ op: "and", nodes: [] })).toBe(true);
    expect(match({ op: "or", nodes: [] })).toBe(false);
    expect(match({ op: "and", nodes: [repo, closed] })).toBe(false);
    expect(match({ op: "or", nodes: [repo, closed] })).toBe(true);
    expect(match({ op: "and", nodes: [repo, { op: "not", node: closed }] })).toBe(true);
  });
});

const leaf = { op: "eq", field: "type", value: "x" };
const nest = (depth: number) => {
  let node: unknown = leaf;
  for (let d = 1; d < depth; d++) node = { op: "not", node };
  return node;
};

describe("FilterExpression parse limits", () => {
  it("accepts depth 4 and rejects depth 5", () => {
    expect(parse(FilterSchema, nest(4)).ok).toBe(true);
    const deep = parse(FilterSchema, nest(5));
    expect(deep.ok).toBe(false);
    expect(deep.ok || deep.issues[0]).toMatch(/depth 4/);
  });

  it("accepts 32 nodes and rejects 33", () => {
    expect(
      parse(FilterSchema, { op: "or", nodes: Array.from({ length: 31 }, () => leaf) }).ok,
    ).toBe(true);
    expect(
      parse(FilterSchema, { op: "or", nodes: Array.from({ length: 32 }, () => leaf) }).ok,
    ).toBe(false);
  });

  it("stays cheap on a hostile depth", () => {
    expect(parse(FilterSchema, nest(10_000)).ok).toBe(false);
  });

  it("rejects unknown fields and ops", () => {
    expect(parse(FilterSchema, { op: "eq", field: "data.secret", value: 1 }).ok).toBe(false);
    expect(parse(FilterSchema, { op: "regex", field: "type", value: ".*" }).ok).toBe(false);
    expect(parse(FilterSchema, { op: "and", nodes: [{ op: "eq", field: "type" }] }).ok).toBe(false);
  });
});

describe("event type patterns", () => {
  it("matches exact types and prefix globs", () => {
    expect(matchesEventType(["github.pull_request.*"], "github.pull_request.opened")).toBe(true);
    expect(
      matchesEventType(["github.pull_request.*"], "github.pull_request_review.submitted"),
    ).toBe(false);
    expect(matchesEventType(["slack.message"], "slack.message")).toBe(true);
    expect(matchesEventType(["slack.message"], "slack.message.x")).toBe(false);
  });

  it("validates patterns in subscription.create with defaults", () => {
    const base = {
      type: "subscription.create",
      botId: "b",
      destination: { conversationId: "c" },
    };
    const ok = parse(SubscriptionCreate, { ...base, eventTypes: ["github.*"] });
    expect(ok.ok && ok.value).toMatchObject({
      filter: { op: "and", nodes: [] },
      delivery: { mode: "wake", debounceMs: 10_000, maxBatchItems: 30 },
    });
    for (const bad of [["*"], ["github"], ["github.*.x"], []]) {
      expect(parse(SubscriptionCreate, { ...base, eventTypes: bad }).ok).toBe(false);
    }
  });
});
