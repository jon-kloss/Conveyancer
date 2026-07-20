import { describe, it, expect } from "vitest";
import { balancedJunctions, manifoldJunctions, minBeltTier, minPipeTier, groupLogistics } from "./logistics";

describe("junction counts", () => {
  it("balanced 1→N tree uses ⌈(N-1)/2⌉ splitters", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(balancedJunctions)).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });
  it("manifold uses N-1", () => {
    expect([1, 2, 3, 4].map(manifoldJunctions)).toEqual([0, 1, 2, 3]);
  });
});

describe("minBeltTier", () => {
  it("picks the lowest tier that carries the rate", () => {
    expect(minBeltTier(30)).toBe(1); // ≤60
    expect(minBeltTier(60)).toBe(1);
    expect(minBeltTier(61)).toBe(2); // ≤120
    expect(minBeltTier(270)).toBe(3);
    expect(minBeltTier(781)).toBe(6); // ≤1200
    expect(minBeltTier(5000)).toBe(6); // beyond Mk.6 → capped at 6 (lines handles the rest)
  });
});

describe("minPipeTier", () => {
  it("picks the lowest pipe tier that carries the fluid rate", () => {
    expect(minPipeTier(120)).toBe(1); // ≤300
    expect(minPipeTier(300)).toBe(1);
    expect(minPipeTier(301)).toBe(2); // ≤600
    expect(minPipeTier(600)).toBe(2);
    expect(minPipeTier(5000)).toBe(2); // beyond Mk.2 → capped at 2
  });
});

describe("groupLogistics", () => {
  it("sizes fluid lines against pipe tiers, solids against belts", () => {
    // Water at 300/min fits a Mk.1 pipe; the same rate on a belt would be Mk.4.
    const l = groupLogistics(
      2,
      { Desc_Water_C: 300 },
      { Desc_IronIngot_C: 300 },
      (item) => item === "Desc_Water_C",
    );
    const water = l.inputs[0];
    expect(water.fluid).toBe(true);
    expect(water.tier).toBe(1); // pipe Mk.1 (≤300), not belt Mk.4
    const ingot = l.outputs[0];
    expect(ingot.fluid).toBe(false);
    expect(ingot.tier).toBe(4); // belt Mk.4 (≤480)
  });
  it("flags parallel pipes when a fluid rate exceeds a single Mk.2 pipe", () => {
    const l = groupLogistics(2, { Desc_Water_C: 1500 }, {}, () => true);
    expect(l.inputs[0].lines).toBe(3); // 1500 / 600 → 3 pipes
  });
  it("a ×2 smelter (1 in, 1 out) needs 1 splitter + 1 merger (balanced)", () => {
    const l = groupLogistics(2, { Desc_OreIron_C: 60 }, { Desc_IronIngot_C: 60 });
    expect(l.splitters).toEqual({ balanced: 1, manifold: 1 });
    expect(l.mergers).toEqual({ balanced: 1, manifold: 1 });
    expect(l.inputs[0].tier).toBe(1);
  });
  it("scales trees per distinct input/output line", () => {
    // an assembler ×4 with 2 inputs, 1 output
    const l = groupLogistics(4, { A: 30, B: 15 }, { C: 20 });
    expect(l.splitters).toEqual({ balanced: 2 * 2, manifold: 2 * 3 }); // 2 lines × tree(4)
    expect(l.mergers).toEqual({ balanced: 1 * 2, manifold: 1 * 3 });
  });
  it("a single machine needs no logistics", () => {
    const l = groupLogistics(1, { A: 30 }, { B: 30 });
    expect(l.splitters).toEqual({ balanced: 0, manifold: 0 });
    expect(l.mergers).toEqual({ balanced: 0, manifold: 0 });
  });
  it("flags parallel lines when a rate exceeds a single Mk.6 belt", () => {
    const l = groupLogistics(2, { A: 2500 }, { B: 30 });
    expect(l.inputs[0].lines).toBe(3); // 2500 / 1200 → 3 belts
  });
});
