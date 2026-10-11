// Subscription filter AST (docs/architecture.md §6.4): a bounded structured expression, never eval'd code.
import * as v from "valibot";

export const filterFields = [
  "source.kind",
  "type",
  "subject.kind",
  "subject.id",
  "data.repositoryId",
  "data.number",
  "data.action",
  "data.sender",
  "data.labels",
  "data.branch",
  "data.slackChannelId",
  "data.slackThreadTs",
  "data.text",
  "data.keyword",
] as const;
export const filterLimits = { depth: 4, nodes: 32 } as const;

type Scalar = string | number | boolean;
export type FilterExpression =
  | { op: "and" | "or"; nodes: FilterExpression[] }
  | { op: "not"; node: FilterExpression }
  | {
      op: "eq" | "neq" | "contains" | "prefix";
      field: (typeof filterFields)[number];
      value: Scalar;
    }
  | { op: "in"; field: (typeof filterFields)[number]; value: Scalar[] };

const ScalarValue = v.union([v.pipe(v.string(), v.maxLength(1024)), v.number(), v.boolean()]);
const Field = v.picklist(filterFields);

const Node: v.GenericSchema<FilterExpression> = v.variant("op", [
  v.strictObject({ op: v.picklist(["and", "or"]), nodes: v.array(v.lazy(() => Node)) }),
  v.strictObject({ op: v.literal("not"), node: v.lazy(() => Node) }),
  v.strictObject({
    op: v.picklist(["eq", "neq", "contains", "prefix"]),
    field: Field,
    value: ScalarValue,
  }),
  v.strictObject({ op: v.literal("in"), field: Field, value: v.array(ScalarValue) }),
]);

/** Walks `nodes` / `node` only and stops past the limits, so a hostile input costs O(limits). */
const withinLimits = (input: unknown) => {
  let count = 0;
  const walk = (node: unknown, depth: number): boolean => {
    if (++count > filterLimits.nodes || depth > filterLimits.depth) return false;
    if (typeof node !== "object" || node === null) return true;
    const { nodes, node: child } = node as { nodes?: unknown; node?: unknown };
    if (Array.isArray(nodes)) return nodes.every((n) => walk(n, depth + 1));
    return child === undefined || walk(child, depth + 1);
  };
  return walk(input, 1);
};

/** The limits are checked before the shape, so validation never recurses deeper than `depth`. */
export const FilterExpression = v.pipe(
  v.unknown(),
  v.check(
    withinLimits,
    `filter exceeds depth ${filterLimits.depth} or ${filterLimits.nodes} nodes`,
  ),
  Node,
);

/** The fields of an Event envelope a filter can see. */
export type FilterTarget = {
  type: string;
  source: { kind: string };
  subject: { kind: string; id: string } | null;
  data: unknown;
};

const resolve = (target: FilterTarget, field: string): unknown => {
  let value: unknown = target;
  for (const key of field.split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
};

/**
 * `and []` is true, `or []` false. A missing field matches only `neq`. `contains` is membership on an array and a
 * case-insensitive substring on a string; `prefix` needs a string. `eq` / `in` compare scalars strictly.
 */
export const matchesFilter = (filter: FilterExpression, target: FilterTarget): boolean => {
  switch (filter.op) {
    case "and":
      return filter.nodes.every((n) => matchesFilter(n, target));
    case "or":
      return filter.nodes.some((n) => matchesFilter(n, target));
    case "not":
      return !matchesFilter(filter.node, target);
  }
  const actual = resolve(target, filter.field);
  switch (filter.op) {
    case "eq":
      return actual === filter.value;
    case "neq":
      return actual !== filter.value;
    case "in":
      return filter.value.some((value) => value === actual);
    case "contains":
      if (Array.isArray(actual)) return actual.includes(filter.value);
      return (
        typeof actual === "string" &&
        actual.toLowerCase().includes(String(filter.value).toLowerCase())
      );
    case "prefix":
      return typeof actual === "string" && actual.startsWith(String(filter.value));
  }
};

/** An event type subscription pattern: exact (`github.pull_request.opened`) or a `prefix.*` glob. */
export const EventTypePattern = v.pipe(
  v.string(),
  v.regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\.\*)?$/),
  v.check((p) => p.includes("."), "an event type has a namespace"),
);

export const matchesEventType = (patterns: readonly string[], type: string) =>
  patterns.some((p) => (p.endsWith(".*") ? type.startsWith(p.slice(0, -1)) : p === type));
