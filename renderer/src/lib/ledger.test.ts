// #110 — the extracted empire ledger aggregation, shared by ResourceOverview
// and the phone MobileDashboard. Pins the semantics the extraction must keep:
// group in/out summing, POWER_ITEM exclusion, raw boundary supply (non-route
// in-ports count as production; route-bound ones don't double-count), per-item
// maker/user drill-down sorted by rate, and busiest-first row order.

import { describe, expect, it } from "vitest";
import { buildLedgerRows } from "./ledger";
import { POWER_ITEM } from "../state/types";

const IRON = "Desc_OreIron_C";
const INGOT = "Desc_IronIngot_C";

const factories = {
  f1: { name: "SMELTER CO" },
  f2: { name: "ROD WORKS" },
} as never;

const mkDerived = (over?: Record<string, unknown>) =>
  ({
    factories: {
      f1: {
        groups: {
          g1: {
            inRates: { [IRON]: 60, [POWER_ITEM]: 4 },
            outRates: { [INGOT]: 60, [POWER_ITEM]: 0 },
            powerMw: 4,
          },
        },
        ports: { pOre: 60, pShip: 30 },
      },
      f2: {
        groups: {
          g2: { inRates: { [INGOT]: 30 }, outRates: {}, powerMw: 4 },
        },
        ports: { pIn: 30 },
      },
      ...(over ?? {}),
    },
  }) as never;

const mkPlan = (ports: Record<string, unknown>) => ({ factories, ports }) as never;

describe("buildLedgerRows", () => {
  it("sums group rates, excludes POWER_ITEM, and counts raw boundary supply", () => {
    const rows = buildLedgerRows(
      mkDerived(),
      mkPlan({
        // non-route boundary IN port: raw supply entering the empire
        pOre: { id: "pOre", factory: "f1", direction: "in", item: IRON, boundRoute: null },
      }),
      {},
    );
    expect(rows.map((r) => r.item)).not.toContain(POWER_ITEM);

    const iron = rows.find((r) => r.item === IRON)!;
    expect(iron.raw).toBe(true);
    expect(iron.produced).toBe(60); // realized port supply
    expect(iron.consumed).toBe(60); // smelter draw
    expect(iron.net).toBe(0);
    expect(iron.makers).toEqual([{ factory: "f1", name: "SMELTER CO", rate: 60 }]);

    const ingot = rows.find((r) => r.item === INGOT)!;
    expect(ingot.raw).toBe(false);
    expect(ingot.produced).toBe(60);
    expect(ingot.consumed).toBe(30);
    expect(ingot.net).toBe(30);
    expect(ingot.makers[0]).toEqual({ factory: "f1", name: "SMELTER CO", rate: 60 });
    expect(ingot.users[0]).toEqual({ factory: "f2", name: "ROD WORKS", rate: 30 });
  });

  it("skips route-bound in-ports — routed items were counted at their producer", () => {
    const rows = buildLedgerRows(
      mkDerived(),
      mkPlan({
        pOre: { id: "pOre", factory: "f1", direction: "in", item: IRON, boundRoute: null },
        // f2's ingot feed arrives over an inter-factory route: NOT new supply
        pIn: { id: "pIn", factory: "f2", direction: "in", item: INGOT, boundRoute: "r1" },
      }),
      {},
    );
    const ingot = rows.find((r) => r.item === INGOT)!;
    expect(ingot.produced).toBe(60); // g1 output only — no double count
    expect(ingot.raw).toBe(false);
  });

  it("orders rows busiest-first by total throughput", () => {
    const rows = buildLedgerRows(
      mkDerived(),
      mkPlan({
        pOre: { id: "pOre", factory: "f1", direction: "in", item: IRON, boundRoute: null },
      }),
      {},
    );
    const totals = rows.map((r) => r.produced + r.consumed);
    expect(totals).toEqual([...totals].sort((a, b) => b - a));
  });
});
