import { describe, it, expect } from "vitest";
import type { GameData } from "../state/types";
import { makeableItems, planChain, splitAcrossPorts } from "./makeChain";

// Minimal synthetic catalog: Iron Ore (raw) → Iron Ingot → {Iron Plate, Iron Rod},
// plus Water (fluid) → Fake item to prove fluids are excluded.
const G = {
  items: {
    Desc_OreIron_C: { className: "Desc_OreIron_C", displayName: "Iron Ore", form: "RF_SOLID", stackSize: "" },
    Desc_IronIngot_C: { className: "Desc_IronIngot_C", displayName: "Iron Ingot", form: "RF_SOLID", stackSize: "" },
    Desc_IronPlate_C: { className: "Desc_IronPlate_C", displayName: "Iron Plate", form: "RF_SOLID", stackSize: "" },
    Desc_IronRod_C: { className: "Desc_IronRod_C", displayName: "Iron Rod", form: "RF_SOLID", stackSize: "" },
    Desc_Water_C: { className: "Desc_Water_C", displayName: "Water", form: "RF_LIQUID", stackSize: "" },
    Desc_Wet_C: { className: "Desc_Wet_C", displayName: "Wet Thing", form: "RF_SOLID", stackSize: "" },
  },
  machines: {
    Build_Smelter_C: { className: "Build_Smelter_C", kind: "manufacturer", powerMw: 4 },
    Build_Constructor_C: { className: "Build_Constructor_C", kind: "manufacturer", powerMw: 4 },
  },
  recipes: {
    Recipe_Ingot: { className: "Recipe_Ingot", displayName: "Iron Ingot", durationS: 2, ingredients: [["Desc_OreIron_C", 1]], products: [["Desc_IronIngot_C", 1]], producedIn: ["Build_Smelter_C"], alternate: false },
    Recipe_Plate: { className: "Recipe_Plate", displayName: "Iron Plate", durationS: 6, ingredients: [["Desc_IronIngot_C", 3]], products: [["Desc_IronPlate_C", 2]], producedIn: ["Build_Constructor_C"], alternate: false },
    Recipe_Rod: { className: "Recipe_Rod", displayName: "Iron Rod", durationS: 4, ingredients: [["Desc_IronIngot_C", 1]], products: [["Desc_IronRod_C", 1]], producedIn: ["Build_Constructor_C"], alternate: false },
    // needs a fluid → must never be offered/planned
    Recipe_Wet: { className: "Recipe_Wet", displayName: "Wet Thing", durationS: 2, ingredients: [["Desc_IronIngot_C", 1], ["Desc_Water_C", 1]], products: [["Desc_Wet_C", 1]], producedIn: ["Build_Constructor_C"], alternate: false },
  },
} as unknown as GameData;

const AVAIL = new Set(["Desc_OreIron_C"]);
const NONE = new Set<string>();

describe("makeableItems", () => {
  it("returns exactly the items fully makeable from the raws (fluids excluded)", () => {
    expect(makeableItems(G, NONE, AVAIL)).toEqual(["Desc_IronIngot_C", "Desc_IronPlate_C", "Desc_IronRod_C"]);
  });
  it("nothing is makeable from no inputs", () => {
    expect(makeableItems(G, NONE, NONE)).toEqual([]);
  });
});

describe("planChain", () => {
  it("expands Iron Plate @ 20/min into right-sized ingot + plate groups", () => {
    const plan = planChain(G, NONE, AVAIL, "Desc_IronPlate_C", 20)!;
    expect(plan).not.toBeNull();
    const byItem = Object.fromEntries(plan.groups.map((gr) => [gr.item, gr]));
    // plate: 20/min, one constructor makes 20/min → 1× @ 100%
    expect(byItem.Desc_IronPlate_C.count).toBe(1);
    expect(byItem.Desc_IronPlate_C.clock).toBeCloseTo(1.0);
    // plate needs 3 ingot / 2 plate → 30/min ingot; one smelter makes 30/min → 1×
    expect(byItem.Desc_IronIngot_C.count).toBe(1);
    expect(plan.rawsUsed).toEqual(["Desc_OreIron_C"]);
    // ore belt carries 30/min, final output belt carries 20/min
    const oreBelt = plan.belts.find((b) => b.item === "Desc_OreIron_C")!;
    expect(oreBelt.fromRaw).toBe(true);
    expect(oreBelt.rate).toBeCloseTo(30);
    const out = plan.belts.find((b) => b.toItem === "OUT")!;
    expect(out.item).toBe("Desc_IronPlate_C");
    expect(out.rate).toBeCloseTo(20);
  });

  it("sums a shared intermediate instead of duplicating it (Plate + Rod both need ingot)", () => {
    // build Rod @ 15/min: needs 15/min ingot; and separately Plate would need 30.
    const plan = planChain(G, NONE, AVAIL, "Desc_IronRod_C", 15)!;
    const ingot = plan.groups.find((gr) => gr.item === "Desc_IronIngot_C")!;
    expect(ingot.count).toBe(1); // 15/min ingot → 1 smelter @ 50%
    expect(ingot.clock).toBeCloseTo(0.5);
  });

  it("rejects an un-makeable target", () => {
    expect(planChain(G, NONE, AVAIL, "Desc_Wet_C", 10)).toBeNull();
  });
});

describe("splitAcrossPorts", () => {
  it("fills one port when its headroom covers the demand", () => {
    const pool = [
      { id: "a", left: 60 },
      { id: "b", left: 60 },
    ];
    expect(splitAcrossPorts(pool, 45)).toEqual([{ id: "a", rate: 45 }]);
    expect(pool[0].left).toBeCloseTo(15);
    expect(pool[1].left).toBeCloseTo(60);
  });

  it("overflows onto the sibling port when one node can't feed it (2-node merge)", () => {
    const pool = [
      { id: "a", left: 60 },
      { id: "b", left: 60 },
    ];
    const shares = splitAcrossPorts(pool, 100);
    expect(shares).toEqual([
      { id: "a", rate: 60 },
      { id: "b", rate: 40 },
    ]);
    expect(pool[1].left).toBeCloseTo(20);
  });

  it("draws from remaining headroom across successive belts (shared raw, two consumers)", () => {
    const pool = [
      { id: "a", left: 60 },
      { id: "b", left: 60 },
    ];
    expect(splitAcrossPorts(pool, 50)).toEqual([{ id: "a", rate: 50 }]);
    // second consumer of the same raw: 10 left on a, rest from b
    expect(splitAcrossPorts(pool, 40)).toEqual([
      { id: "a", rate: 10 },
      { id: "b", rate: 30 },
    ]);
  });

  it("treats a ceiling-less port as unlimited", () => {
    const pool = [{ id: "free", left: Infinity }];
    expect(splitAcrossPorts(pool, 500)).toEqual([{ id: "free", rate: 500 }]);
    expect(pool[0].left).toBe(Infinity);
  });

  it("piles float dust / overshoot onto the last contributing port instead of dropping it", () => {
    const pool = [
      { id: "a", left: 30 },
      { id: "b", left: 30 },
    ];
    const shares = splitAcrossPorts(pool, 70); // guard would block this; wiring must not drop 10
    expect(shares.reduce((s, x) => s + x.rate, 0)).toBeCloseTo(70);
    expect(shares[shares.length - 1].id).toBe("b");
  });

  it("returns empty for an empty pool (no port to wire)", () => {
    expect(splitAcrossPorts([], 10)).toEqual([]);
  });
});
