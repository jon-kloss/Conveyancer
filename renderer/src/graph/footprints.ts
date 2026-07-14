// Top-down machine footprints in meters (width × length). The primary source
// is the catalog's Docs-derived clearance footprint (gamedata parses
// mClearanceData → Machine.footprintM); this community-documented table is
// the fallback for catalogs without clearance data. Rendered at one shared
// scale so relative size reads truthfully across machines.

import type { GameData } from "../state/types";

export interface Footprint {
  w: number;
  l: number;
  /** true when the dims come from the game's own clearance data. */
  derived: boolean;
}

const FOOTPRINTS: Record<string, { w: number; l: number }> = {
  Build_SmelterMk1_C: { w: 6, l: 9 },
  Build_ConstructorMk1_C: { w: 8, l: 10 },
  Build_AssemblerMk1_C: { w: 10, l: 15 },
  Build_FoundryMk1_C: { w: 10, l: 9 },
  Build_ManufacturerMk1_C: { w: 18, l: 20 },
  Build_OilRefinery_C: { w: 10, l: 20 },
  Build_Packager_C: { w: 8, l: 8 },
  Build_Blender_C: { w: 18, l: 16 },
  Build_HadronCollider_C: { w: 24, l: 38 },
  Build_ConveyorAttachmentSplitter_C: { w: 4, l: 4 },
  Build_ConveyorAttachmentSplitterSmart_C: { w: 4, l: 4 },
  Build_ConveyorAttachmentSplitterProgrammable_C: { w: 4, l: 4 },
  Build_ConveyorAttachmentMerger_C: { w: 4, l: 4 },
  Build_StorageContainerMk1_C: { w: 5, l: 10 },
  Build_StorageContainerMk2_C: { w: 5, l: 10 },
  Build_MinerMk1_C: { w: 6, l: 14 },
  Build_MinerMk2_C: { w: 6, l: 14 },
  Build_MinerMk3_C: { w: 6, l: 14 },
};

const FALLBACK = { w: 8, l: 8 };

/** Docs-derived clearance footprint when the catalog carries one (the honest,
 *  machine-exact number), else the community table estimate. */
export function footprintFor(gamedata: GameData, machineClass: string): Footprint {
  const fp = gamedata.machines[machineClass]?.footprintM;
  if (fp) return { w: fp[0], l: fp[1], derived: true };
  return { ...(FOOTPRINTS[machineClass] ?? FALLBACK), derived: false };
}

/** Shared render scale: px per meter in the card footprint strip. */
export const FOOTPRINT_SCALE = 1.1;

/** Outline long side stays ≤ this many px — real clearance data includes
 *  giants (Nuclear Plant 36×42 m) that would otherwise swallow the card. */
export const FOOTPRINT_MAX_PX = 26;

export function footprintArea(f: Footprint, count: number): number {
  return f.w * f.l * count;
}
