// Pure extraction-rate math (no leaflet), so it's unit-testable off the map.
import { purityFactor, type GameMachine } from "../state/types";

/** Extraction ceiling in items/min (twin of gamedata::extraction_rate). `fluid`
 *  = the extracted item is a fluid (the caller knows it from the node item): the
 *  game stores mItemsPerCycle in raw mL-scale for fluids, so ÷1000 to m³ — the
 *  same normalization the Rust `extraction_rate` and every fluid recipe get.
 *  Without it an Oil Pump / Water Extractor reads 1000× its true rate, which
 *  here would persist as a node claim's boundary-port ceiling. */
export function extractionRate(
  machine: GameMachine | undefined,
  purity: string,
  clock: number,
  fluid: boolean,
): number {
  const m = machine as (GameMachine & { itemsPerCycle?: number; cycleTimeS?: number }) | undefined;
  if (!m || m.kind !== "extractor" || !m.itemsPerCycle || !m.cycleTimeS) return 0;
  const perCycle = fluid ? m.itemsPerCycle / 1000 : m.itemsPerCycle;
  return (perCycle / m.cycleTimeS) * 60 * purityFactor(purity) * clock;
}
