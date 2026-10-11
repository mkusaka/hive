// Task DAG rules (docs/architecture.md §4.2): pure functions, so they are testable without D1.

export type Dependency = { prerequisite: string; dependent: string };
export type ParentLink = { child: string; parent: string };

/**
 * True when adding `edge` closes a cycle. One "finishes before" graph holds both relations: a start dependency
 * `prerequisite → dependent`, and the hidden `child → parent` (a parent completes after its children), so a
 * child that waits for its parent is rejected too (AT-18).
 */
export const wouldCreateCycle = (
  edges: readonly Dependency[],
  parentLinks: readonly ParentLink[],
  edge: Dependency,
) => {
  const next = new Map<string, string[]>();
  const link = (from: string, to: string) => next.set(from, [...(next.get(from) ?? []), to]);
  for (const e of edges) link(e.prerequisite, e.dependent);
  for (const l of parentLinks) link(l.child, l.parent);
  // A cycle exists iff `prerequisite` is reachable from `dependent`.
  const seen = new Set<string>();
  const stack = [edge.dependent];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === edge.prerequisite) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    stack.push(...(next.get(node) ?? []));
  }
  return false;
};

/** Computed, never stored (§4.1): ready only when every prerequisite completed; `cancelled` blocks (AT-17). */
export const readiness = (prerequisites: readonly { status: string }[]) =>
  prerequisites.every((p) => p.status === "completed") ? "ready" : "blocked";

/** The display state of a Task: its status, or `ready` / `blocked` while `pending`. */
export const displayState = (
  task: { status: string },
  prerequisites: readonly { status: string }[],
) => (task.status === "pending" ? readiness(prerequisites) : task.status);
