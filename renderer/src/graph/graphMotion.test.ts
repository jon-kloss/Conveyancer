// Motion-helper contracts (handoff §5): diffs are exact, construction order
// is left→right and deterministic, ghosts die on schedule, stale verbs are
// ignored.

import { describe, expect, it } from "vitest";
import {
  buildOrder,
  diffIds,
  ghostTtlMs,
  motionKind,
  MOTION_FRESH_MS,
  pruneGhosts,
} from "./graphMotion";

describe("graphMotion", () => {
  it("diffIds reports exactly what appeared and vanished", () => {
    const { added, removed } = diffIds(new Set(["a", "b", "c"]), new Set(["b", "c", "d", "e"]));
    expect(added.sort()).toEqual(["d", "e"]);
    expect(removed).toEqual(["a"]);
  });

  it("buildOrder is left→right with y/id tiebreaks (7m production order)", () => {
    const order = buildOrder([
      { id: "ctor", x: 600, y: 100 },
      { id: "smelter", x: 300, y: 100 },
      { id: "asm-low", x: 900, y: 300 },
      { id: "asm-high", x: 900, y: 100 },
    ]);
    expect(order.get("smelter")).toBe(0);
    expect(order.get("ctor")).toBe(1);
    expect(order.get("asm-high")).toBe(2);
    expect(order.get("asm-low")).toBe(3);
  });

  it("ghost TTLs match the spec grammar (undo 120ms; delete 150+120ms)", () => {
    expect(ghostTtlMs("undo")).toBe(120);
    expect(ghostTtlMs("delete")).toBe(270);
  });

  it("pruneGhosts drops only fully-played ghosts", () => {
    const ghosts = [
      { id: "old", at: 1000 },
      { id: "young", at: 1200 },
    ];
    const live = pruneGhosts(ghosts, 1250, () => 120);
    expect(live.map((g) => g.id)).toEqual(["young"]);
  });

  it("motionKind trusts only fresh verbs", () => {
    expect(motionKind({ kind: "undo", at: 1000 }, 1000 + MOTION_FRESH_MS - 1)).toBe("undo");
    expect(motionKind({ kind: "undo", at: 1000 }, 1000 + MOTION_FRESH_MS)).toBeNull();
    expect(motionKind(null, 0)).toBeNull();
  });
});
