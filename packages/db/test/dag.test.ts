import { describe, expect, it } from "vitest";
import { displayState, readiness, wouldCreateCycle } from "../src/dag.ts";

describe("wouldCreateCycle", () => {
  const edges = [
    { prerequisite: "a", dependent: "b" },
    { prerequisite: "b", dependent: "c" },
  ];

  it("rejects a direct, transitive or self cycle and accepts a DAG edge", () => {
    expect(wouldCreateCycle(edges, [], { prerequisite: "b", dependent: "a" })).toBe(true);
    expect(wouldCreateCycle(edges, [], { prerequisite: "c", dependent: "a" })).toBe(true);
    expect(wouldCreateCycle(edges, [], { prerequisite: "a", dependent: "a" })).toBe(true);
    expect(wouldCreateCycle(edges, [], { prerequisite: "a", dependent: "c" })).toBe(false);
  });

  it("rejects a hidden cycle through the parent/child completion relation (AT-18)", () => {
    const parents = [{ child: "child", parent: "parent" }];
    // The child cannot start before its parent completes, which waits for the child.
    expect(wouldCreateCycle([], parents, { prerequisite: "parent", dependent: "child" })).toBe(
      true,
    );
    // Through another Task: parent → x → child.
    const viaX = [{ prerequisite: "parent", dependent: "x" }];
    expect(wouldCreateCycle(viaX, parents, { prerequisite: "x", dependent: "child" })).toBe(true);
    // The parent may wait for its child, and the child for an unrelated Task.
    expect(wouldCreateCycle([], parents, { prerequisite: "child", dependent: "parent" })).toBe(
      false,
    );
    expect(wouldCreateCycle([], parents, { prerequisite: "x", dependent: "child" })).toBe(false);
  });
});

describe("readiness / displayState", () => {
  it("is ready only when every prerequisite completed; cancelled blocks (AT-17)", () => {
    expect(readiness([])).toBe("ready");
    expect(readiness([{ status: "completed" }])).toBe("ready");
    expect(readiness([{ status: "completed" }, { status: "cancelled" }])).toBe("blocked");
    expect(readiness([{ status: "in_progress" }])).toBe("blocked");
  });

  it("computes ready / blocked only for pending Tasks", () => {
    expect(displayState({ status: "pending" }, [{ status: "pending" }])).toBe("blocked");
    expect(displayState({ status: "in_progress" }, [{ status: "pending" }])).toBe("in_progress");
    expect(displayState({ status: "cancelled" }, [])).toBe("cancelled");
  });
});
