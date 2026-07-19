// Map-motion contracts: scatter is deterministic with real counts and
// bounded radius; partialPath clips a polyline exactly; keys are stable.

import { describe, expect, it } from "vitest";
import { easeOut, hashSeed, partialPath, scatter, tetherKey } from "./mapMotion";

describe("mapMotion", () => {
  it("scatter is deterministic per id and honors count + radius bounds", () => {
    const a = scatter("fac-01HXYZ", 12, 100);
    const b = scatter("fac-01HXYZ", 12, 100);
    expect(a).toEqual(b);
    expect(a).toHaveLength(12);
    for (const { dx, dy } of a) {
      const r = Math.hypot(dx, dy);
      expect(r).toBeGreaterThanOrEqual(100 * 0.45 - 1e-9);
      expect(r).toBeLessThanOrEqual(100 + 1e-9);
    }
    // a different id scatters differently
    expect(scatter("fac-OTHER", 12, 100)).not.toEqual(a);
  });

  it("partialPath clips a polyline by fractional length", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(partialPath(pts, 1)).toEqual(pts);
    expect(partialPath(pts, 0)).toEqual([]);
    // half of the 20-unit path ends exactly at the corner
    expect(partialPath(pts, 0.5)).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    // three quarters walks 5 units into the second segment
    const p75 = partialPath(pts, 0.75);
    expect(p75[2]).toEqual({ x: 10, y: 5 });
  });

  it("tetherKey + hashSeed are stable", () => {
    expect(tetherKey({ x: 3, y: -7 })).toBe("3,-7");
    expect(hashSeed("abc")).toBe(hashSeed("abc"));
    expect(hashSeed("abc")).not.toBe(hashSeed("abd"));
  });

  it("easeOut is clamped and monotone at the ends", () => {
    expect(easeOut(-1)).toBe(0);
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(2)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
  });
});
