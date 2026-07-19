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
    const g0 = group("gen", "Recipe_Power_Coal_C", 2, 1);
    (g0 as { plannedDelta: unknown }).plannedDelta = { count: 4, clock: 0.5 };
    const plan = makePlan({ groups: { gen: g0 } });
    const g = (buildSnapshot(plan, gamedata, F)!.groups as SnapGroup[])[0];
    expect(g.drivenCycles).toBeCloseTo(2);
  });

  it("keeps drivenCycles null for ordinary production groups", () => {
    const plan = makePlan({ groups: { g1: group("g1", "Recipe_Ingot_C") } });
    const g = (buildSnapshot(plan, gamedata, F)!.groups as SnapGroup[])[0];
    expect(g.drivenCycles).toBeNull();
  });
});
