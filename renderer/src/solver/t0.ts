// WASM T0 wrapper + snapshot builder (mirror of Session::snapshot on the Rust
// side). Runs on drag frames only; the release commit goes through plan.edit
// and T1 settles authoritatively.

import init, { t0_solve } from "../wasm/pkg/solver_wasm.js";
import wasmUrl from "../wasm/pkg/solver_wasm_bg.wasm?url";
import type { DerivedFactory, Id, TargetCeiling } from "../state/types";
import type { FactorySnapshot } from "./snapshot";

// Snapshot construction lives in ./snapshot (wasm-free, vitest-testable);
// re-exported here so callers keep a single import site.
export { buildSnapshot, type FactorySnapshot } from "./snapshot";

let readyPromise: Promise<void> | null = null;
export function ensureT0(): Promise<void> {
  readyPromise ??= init({ module_or_path: wasmUrl }).then(() => undefined);
  return readyPromise;
}

interface WasmSolveResult {
  groups: Record<Id, { count: number; clock: number; powerMw: number; inRates: Record<string, number>; outRates: Record<string, number> }>;
  edges: Record<Id, { flow: number; saturation: number }>;
  ports: Record<Id, number>;
  totalPowerMw: number;
  targetCeiling: TargetCeiling | null;
  clamped: boolean;
  solveUs: number;
}

/** Projected drag-frame solve. Returns null if the wasm module isn't ready or errors. */
export function t0SetTarget(
  snapshot: FactorySnapshot,
  port: Id,
  rate: number,
): (DerivedFactory & { clamped: boolean }) | null {
  const started = performance.now();
  try {
    const r = t0_solve(snapshot, { type: "set_target", port, rate }) as WasmSolveResult;
    const solveUs = Math.round((performance.now() - started) * 1000);
    return {
      groups: Object.fromEntries(
        Object.entries(r.groups).map(([id, g]) => [id, { inRates: g.inRates, outRates: g.outRates, powerMw: g.powerMw }]),
      ),
      edges: r.edges,
      ports: r.ports,
      // T0 drag preview never reports shortfalls; T1 settle owns that contract.
      shortfalls: {},
      totalPowerMw: r.totalPowerMw,
      targetCeiling: r.targetCeiling,
      solveUs,
      solveOnRelease: false,
      solveError: null,
      clamped: r.clamped,
    };
  } catch {
    return null;
  }
}
