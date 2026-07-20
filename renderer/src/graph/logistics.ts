// Belt logistics for a machine GROUP of N machines: the splitters that fan each
// input belt out to the N machines, and the mergers that recombine the N
// outputs — the physical parts the "×N" hides. Two layouts:
//   • balanced — a 1→3 splitter tree (even feed, no ramp-up): ⌈(N−1)/2⌉ per line
//   • manifold — one tap per machine (simple, ramps up unevenly):     N−1 per line
// One tree per distinct input item (splitters) / output item (mergers).

import { BELT_CAPACITY, PIPE_CAPACITY } from "../state/types";

export const SPLITTER_CLASS = "Build_ConveyorAttachmentSplitter_C";
export const MERGER_CLASS = "Build_ConveyorAttachmentMerger_C";

/** 1→N balanced fan-out with 1→3 splitters: ⌈(N−1)/2⌉ junctions. */
export const balancedJunctions = (n: number): number => (n <= 1 ? 0 : Math.ceil((n - 1) / 2));
/** Manifold: one tap per machine except the last. */
export const manifoldJunctions = (n: number): number => Math.max(0, n - 1);

const minTierIn = (table: readonly number[], rate: number): number => {
  const i = table.findIndex((c) => rate <= c + 1e-6);
  return i === -1 ? table.length : i + 1;
};

/** Lowest belt tier (1..6) that carries `rate`/min; 6 if it exceeds Mk.6. */
export const minBeltTier = (rate: number): number => minTierIn(BELT_CAPACITY, rate);
/** Lowest pipe tier (1..2) that carries `rate` m³/min; 2 if beyond Mk.2. */
export const minPipeTier = (rate: number): number => minTierIn(PIPE_CAPACITY, rate);
/** Min transport tier for a line, picking the pipe or belt table by medium. */
export const minTransportTier = (rate: number, isFluid: boolean): number =>
  isFluid ? minPipeTier(rate) : minBeltTier(rate);

export interface LogiLine {
  item: string;
  rate: number;
  /** true when this line rides a pipe (fluid), false for a belt */
  fluid: boolean;
  /** min transport tier for a single line */
  tier: number;
  /** parallel belt/pipe lines needed (rate beyond the top single tier) */
  lines: number;
}

export interface GroupLogistics {
  count: number;
  inputs: LogiLine[];
  outputs: LogiLine[];
  splitters: { balanced: number; manifold: number };
  mergers: { balanced: number; manifold: number };
}

const line = (item: string, rate: number, isFluid: boolean): LogiLine => {
  const table = isFluid ? PIPE_CAPACITY : BELT_CAPACITY;
  const top = table[table.length - 1];
  return {
    item,
    rate,
    fluid: isFluid,
    tier: Math.min(table.length, minTransportTier(rate, isFluid)),
    lines: rate > top ? Math.ceil(rate / top) : 1,
  };
};

/** Compute the splitter/merger build for a group. Rates are per-minute totals
 *  for the whole group (from the solver's inRates/outRates). `isFluid` maps an
 *  item to its transport medium (fluids ride pipes); default treats everything
 *  as a belt for callers/tests that don't care about the pipe distinction. */
export function groupLogistics(
  count: number,
  inRates: Record<string, number>,
  outRates: Record<string, number>,
  isFluid: (item: string) => boolean = () => false,
): GroupLogistics {
  const inputs = Object.entries(inRates)
    .filter(([, r]) => r > 1e-6)
    .map(([item, r]) => line(item, r, isFluid(item)));
  const outputs = Object.entries(outRates)
    .filter(([, r]) => r > 1e-6)
    .map(([item, r]) => line(item, r, isFluid(item)));
  const b = balancedJunctions(count);
  const m = manifoldJunctions(count);
  return {
    count,
    inputs,
    outputs,
    // one tree per distinct item line
    splitters: { balanced: inputs.length * b, manifold: inputs.length * m },
    mergers: { balanced: outputs.length * b, manifold: outputs.length * m },
  };
}
