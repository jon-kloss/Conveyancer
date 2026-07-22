// Snapshot builder for the T0 drag-preview solver (mirror of Session::snapshot
// on the Rust side). Lives apart from t0.ts so it stays wasm-free and
// unit-testable under vitest/node.

import type { GameData, Id, Plan } from "../state/types";
import { effClock, effCount, isFluidItem, POWER_ITEM, transportCapacity } from "../state/types";

export interface FactorySnapshot {
  groups: unknown[];
  edges: unknown[];
  inputs: unknown[];
  outputs: unknown[];
  junctions: string[];
}

export function buildSnapshot(plan: Plan, gamedata: GameData, factoryId: Id): FactorySnapshot | null {
  const factory = plan.factories[factoryId];
  if (!factory) return null;
  const groups = [];
  // Skip-and-solve, mirroring session.rs::snapshot: an unresolvable recipe
  // (imported generator with an empty recipe string) must not kill the WHOLE
  // factory's drag preview — skip the group (and its edges below) and solve
  // the rest, exactly like the settle path does.
  const skipped = new Set<Id>();
  for (const gid of factory.groups) {
    const g = plan.groups[gid];
    if (!g) return null;
    const recipe = gamedata.recipes[g.recipe];
    if (!recipe) {
      skipped.add(gid);
      continue;
    }
    // Driven generators, mirroring session.rs: a generator NOT wired to a
    // power out-port produces the POWER pseudo-item nothing targets, so the
    // demand pass idles it at 0 — and every drag frame read "GENERATES 0 MW".
    // drivenCycles keeps it at its fuel-limited nameplate mid-drag too.
    const isGenerator = recipe.products.some(([item]) => item === POWER_ITEM);
    const wiredToPower =
      isGenerator &&
      Object.values(plan.edges).some(
        (e) =>
          e.factory === factoryId &&
          e.from.kind === "group" &&
          e.from.id === gid &&
          e.to.kind === "port" &&
          plan.ports[e.to.id]?.item === POWER_ITEM,
      );
    groups.push({
      id: g.id,
      recipe: {
        id: recipe.className,
        machine: g.machine,
        durationS: recipe.durationS,
        inputs: recipe.ingredients,
        outputs: recipe.products,
        powerMw: recipe.variablePowerMw ?? gamedata.machines[g.machine]?.powerMw ?? 0,
      },
      count: effCount(g),
      clock: effClock(g),
      // Mirrors session.rs: a ◆ delta clock is authored the same way a planned
      // group's clockCeiling is — the drag preview must honor it too.
      clockCeiling: g.plannedDelta?.clock ?? g.clockCeiling ?? null,
      drivenCycles: isGenerator && !wiredToPower ? effCount(g) * effClock(g) : null,
    });
  }
  const inputs = [];
  const outputs = [];
  for (const pid of factory.ports) {
    const p = plan.ports[pid];
    if (!p) return null;
    if (p.direction === "in") {
      // A planned, unrouted, uncapped FLUID IN port supplies 0 — fluids arrive
      // only by pipe (mirrors the desktop snapshot gate, so the single-factory
      // view is honest). Solids and ◆ built fluid ports keep the lenient
      // assumption; a bound port's route supply is layered on by the empire pass.
      const gated =
        p.rateCeiling == null && !p.boundRoute && p.status !== "built" && isFluidItem(gamedata, p.item);
      inputs.push({ id: p.id, item: p.item, ceiling: gated ? 0 : p.rateCeiling });
    } else outputs.push({ id: p.id, item: p.item, rate: p.rate });
  }
  const toRef = (end: { kind: string; id: string }) => {
    if (end.kind === "group") return { kind: "group", id: end.id };
    if (end.kind === "junction") return { kind: "junction", id: end.id };
    return plan.ports[end.id]?.direction === "in" ? { kind: "input", id: end.id } : { kind: "output", id: end.id };
  };
  const edges = Object.values(plan.edges)
    .filter((e) => e.factory === factoryId)
    // edges touching a skipped (unresolvable-recipe) group would dangle
    .filter(
      (e) =>
        !(e.from.kind === "group" && skipped.has(e.from.id)) &&
        !(e.to.kind === "group" && skipped.has(e.to.id)),
    )
    .map((e) => ({
      id: e.id,
      from: toRef(e.from),
      to: toRef(e.to),
      item: e.item,
      // Fluid edges are pipes (300/600 m³/min); solids are belts — mirrors the
      // desktop `session.rs` capacity split so web and desktop solve alike.
      capacity: transportCapacity(gamedata, e.item, e.tier),
    }));
  const junctions = Object.values(plan.junctions)
    .filter((j) => j.factory === factoryId)
    .map((j) => j.id);
  return { groups, edges, inputs, outputs, junctions };
}
