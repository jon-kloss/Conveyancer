// Audit #123 regression guards for the T0 drag-preview snapshot builder:
//  - an unresolvable recipe skips that GROUP (and its edges), not the whole
//    factory (the old `return null` killed the entire drag preview);
//  - a generator NOT wired to a power out-port carries drivenCycles so the
//    demand pass doesn't idle it to "GENERATES 0 MW" mid-drag.

import { describe, expect, it } from "vitest";
import { buildSnapshot } from "./snapshot";
import { POWER_ITEM, type GameData, type Plan } from "../state/types";

const F = "f1";

function makePlan(over: Partial<Record<"groups" | "ports" | "edges" | "junctions", Record<string, unknown>>> & { factoryGroups?: string[]; factoryPorts?: string[] } = {}): Plan {
  return {
    factories: {
      [F]: {
        id: F,
        name: "Test",
        groups: over.factoryGroups ?? Object.keys(over.groups ?? {}),
        ports: over.factoryPorts ?? Object.keys(over.ports ?? {}),
        nodeClaims: [],
        styleGuide: null,
        status: "planned",
      },
    },
    groups: over.groups ?? {},
    ports: over.ports ?? {},
    edges: over.edges ?? {},
    junctions: over.junctions ?? {},
  } as unknown as Plan;
}

function group(id: string, recipe: string, count = 2, clock = 1.5): Record<string, unknown> {
  return {
    id,
    factory: F,
    machine: "Build_Smelter_C",
    recipe,
    count,
    clock,
    somersloops: 0,
    plannedDelta: null,
    graphPos: { x: 0, y: 0 },
    floor: 0,
    status: "planned",
  };
}

const gamedata = {
  recipes: {
    Recipe_Ingot_C: {
      className: "Recipe_Ingot_C",
      displayName: "Iron Ingot",
      durationS: 2,
      ingredients: [["Desc_OreIron_C", 1]],
      products: [["Desc_IronIngot_C", 1]],
      producedIn: ["Build_Smelter_C"],
      alternate: false,
    },
    Recipe_Power_Coal_C: {
      className: "Recipe_Power_Coal_C",
      displayName: "Coal Power",
      durationS: 60,
      ingredients: [["Desc_Coal_C", 15]],
      products: [[POWER_ITEM, 75]],
      producedIn: ["Build_GeneratorCoal_C"],
      alternate: false,
    },
  },
  machines: {
    Build_Smelter_C: { className: "Build_Smelter_C", displayName: "Smelter", powerMw: 4, kind: "manufacturer" },
    Build_GeneratorCoal_C: { className: "Build_GeneratorCoal_C", displayName: "Coal Generator", powerMw: 0, kind: "generator" },
  },
} as unknown as GameData;

type SnapGroup = { id: string; drivenCycles: number | null };
type SnapEdge = { id: string };

describe("buildSnapshot — skip-and-solve on unresolvable recipes (audit #123)", () => {
  it("skips the broken group and its edges instead of returning null", () => {
    const plan = makePlan({
      groups: {
        g1: group("g1", "Recipe_Ingot_C"),
        g2: group("g2", "Recipe_DoesNotExist_C"),
      },
      ports: {
        p1: { id: "p1", factory: F, direction: "out", item: "Desc_IronIngot_C", rate: 30, rateCeiling: null, status: "planned" },
      },
      edges: {
        e1: { id: "e1", factory: F, from: { kind: "group", id: "g1" }, to: { kind: "port", id: "p1" }, item: "Desc_IronIngot_C", tier: 1, status: "planned" },
        e2: { id: "e2", factory: F, from: { kind: "group", id: "g2" }, to: { kind: "port", id: "p1" }, item: "Desc_IronIngot_C", tier: 1, status: "planned" },
        e3: { id: "e3", factory: F, from: { kind: "group", id: "g1" }, to: { kind: "group", id: "g2" }, item: "Desc_IronIngot_C", tier: 1, status: "planned" },
      },
    });

    const snap = buildSnapshot(plan, gamedata, F);
    expect(snap).not.toBeNull();
    const groups = snap!.groups as SnapGroup[];
    expect(groups.map((g) => g.id)).toEqual(["g1"]);
    // edges touching the skipped group must not dangle into the solver
    const edgeIds = (snap!.edges as SnapEdge[]).map((e) => e.id);
    expect(edgeIds).toEqual(["e1"]);
    expect(snap!.outputs).toHaveLength(1);
  });

  it("still returns null when the factory itself is missing", () => {
    const plan = makePlan({});
    expect(buildSnapshot(plan, gamedata, "nope")).toBeNull();
  });
});

describe("buildSnapshot — driven generators (audit #123)", () => {
  it("sets drivenCycles = count x clock for a generator with no power out-port wiring", () => {
    const plan = makePlan({
      groups: { gen: group("gen", "Recipe_Power_Coal_C", 3, 1.5) },
    });
    const snap = buildSnapshot(plan, gamedata, F);
    const g = (snap!.groups as SnapGroup[])[0];
    expect(g.drivenCycles).toBeCloseTo(4.5);
  });

  it("leaves drivenCycles null when the generator feeds a power out-port (demand-driven)", () => {
    const plan = makePlan({
      groups: { gen: group("gen", "Recipe_Power_Coal_C", 3, 1) },
      ports: {
        pw: { id: "pw", factory: F, direction: "out", item: POWER_ITEM, rate: 150, rateCeiling: null, status: "planned" },
      },
      edges: {
        e1: { id: "e1", factory: F, from: { kind: "group", id: "gen" }, to: { kind: "port", id: "pw" }, item: POWER_ITEM, tier: 1, status: "planned" },
      },
    });
    const g = (buildSnapshot(plan, gamedata, F)!.groups as SnapGroup[])[0];
    expect(g.drivenCycles).toBeNull();
  });

  it("respects the planned delta overlay in the driven-cycles product", () => {
    // Overlay values chosen so effective (3 x 2 = 6) diverges from the raw
    // baseline (2 x 1 = 2) — a regression to g.count * g.clock fails here.
    const g0 = group("gen", "Recipe_Power_Coal_C", 2, 1);
    (g0 as { plannedDelta: unknown }).plannedDelta = { count: 3, clock: 2 };
    const plan = makePlan({ groups: { gen: g0 } });
    const g = (buildSnapshot(plan, gamedata, F)!.groups as SnapGroup[])[0];
    expect(g.drivenCycles).toBeCloseTo(6);
  });

  it("keeps drivenCycles null for ordinary production groups", () => {
    const plan = makePlan({ groups: { g1: group("g1", "Recipe_Ingot_C") } });
    const g = (buildSnapshot(plan, gamedata, F)!.groups as SnapGroup[])[0];
    expect(g.drivenCycles).toBeNull();
  });
});

// The supplemental-fluid gate: a fluid arrives only by pipe, so a planned,
// unrouted, uncapped fluid IN port supplies 0 in the SINGLE-FACTORY (T0) view
// too — a coal generator reads 0 MW until water is piped in, not full power.
describe("buildSnapshot — supplemental fluid gate (routed water)", () => {
  const gd = {
    recipes: {},
    machines: {},
    items: {
      Desc_Coal_C: { className: "Desc_Coal_C", displayName: "Coal", form: "RF_SOLID" },
      Desc_Water_C: { className: "Desc_Water_C", displayName: "Water", form: "RF_LIQUID" },
    },
  } as unknown as GameData;

  type SnapInput = { id: string; item: string; ceiling: number | null };
  const port = (over: Record<string, unknown>) => ({
    id: "w",
    factory: F,
    direction: "in",
    item: "Desc_Water_C",
    rate: 0,
    rateCeiling: null,
    boundRoute: null,
    status: "planned",
    ...over,
  });
  const ceilingOf = (p: Record<string, unknown>): number | null =>
    (buildSnapshot(makePlan({ ports: { w: p } }), gd, F)!.inputs as SnapInput[])[0].ceiling;

  it("zeroes a planned, unrouted, uncapped FLUID in port", () => {
    expect(ceilingOf(port({}))).toBe(0);
  });
  it("leaves a SOLID uncapped in port open (lenient boundary)", () => {
    expect(ceilingOf(port({ item: "Desc_Coal_C" }))).toBeNull();
  });
  it("keeps an explicit fluid ceiling (assumed off-plan source)", () => {
    // 137 is deliberately not a pipe/belt capacity, so it can only be the port's
    // own ceiling passing through.
    expect(ceilingOf(port({ rateCeiling: 137 }))).toBe(137);
  });
  it("keeps an explicit ceiling on a SOLID too (ceiling short-circuits the gate)", () => {
    // Companion to the above: an explicit ceiling passes through regardless of
    // form — proving the fluid framing of the fluid-ceiling case is incidental
    // (the `rateCeiling == null` guard short-circuits before isFluidItem).
    expect(ceilingOf(port({ item: "Desc_Coal_C", rateCeiling: 137 }))).toBe(137);
  });
  it("exempts a ◆ BUILT fluid port (observed running plant assumes water)", () => {
    expect(ceilingOf(port({ status: "built" }))).toBeNull();
  });
  it("leaves a routed (bound) fluid port for the empire pass", () => {
    expect(ceilingOf(port({ boundRoute: "r1" }))).toBeNull();
  });
});
