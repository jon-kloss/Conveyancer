// Efficiency-grammar band boundaries (DECISIONS: belts don't jam — a
// ratio-perfect build runs belts at 100% and that is OPTIMAL). Pure unit
// pins on the single banding authority the graph edges, map routes, audit
// SATURATION tab, and status bar all share.

import { test, expect } from "@playwright/test";
import { flowBand, routeBottleneck } from "../src/lib/format";
import type { DeficitRow } from "../src/state/types";

test("flowBand: under/good boundary sits AT 50% — 30 on a 60-belt is under-used", () => {
  // The user's literal case: a 60/min belt carrying 30/min = exactly 50%.
  expect(flowBand(30 / 60, 30)).toBe("under");
  // Just above the boundary is good.
  expect(flowBand(0.501, 30.06)).toBe("good");
  // A FULL belt that meets demand is optimal, not critical.
  expect(flowBand(1.0, 60)).toBe("good");
  // Zero flow is idle, never "under" — under means flowing below half rated.
  expect(flowBand(0, 0)).toBe("good");
  // Bottleneck evidence outranks utilization in both directions.
  expect(flowBand(1.0, 60, true)).toBe("bottleneck");
  expect(flowBand(0.2, 12, true)).toBe("bottleneck");
});

test("routeBottleneck: red needs a deficit THROUGH the route AND a full route", () => {
  const deficits: DeficitRow[] = [
    { factory: "f-rod", port: "p-in", route: "r1", item: "Desc_IronIngot_C", needed: 100, supplied: 60 },
  ];
  // Full route + downstream starved through it = the link caps demand.
  expect(routeBottleneck("r1", 1.0, deficits)).toBe(true);
  // Starved but slack: upstream under-produces — NOT this route's fault.
  expect(routeBottleneck("r1", 10 / 60, deficits)).toBe(false);
  // Full but nobody starves: ratio-perfect, optimal.
  expect(routeBottleneck("r2", 1.0, deficits)).toBe(false);
  expect(routeBottleneck("r1", 1.0, [])).toBe(false);
});
