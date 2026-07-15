// Save-parse reduction (SDD §8.1–8.2): the pure object-graph → ImportSnapshot
// reduction, split out of the Web Worker so it can be unit-tested over a
// synthetic object graph without a real .sav or the worker/self context.
//
// Recognition & honest degradation, precisely:
//   - modded content (Build_/BP_ classes OUTSIDE /Game/FactoryGame/) is
//     quarantined — counted per class and surfaced in the preview, never
//     silently dropped.
//   - vanilla decor / world markers / transport stations (foundations, walls,
//     BP_FrackingSatellite_C, Build_DroneStation_C, …) carry no recipe and are
//     not machines: recognized-and-ignored (dropped, expected). Surfacing every
//     foundation would bury the signal.
//   - an UNRECOGNIZED vanilla PRODUCER — a /Game/FactoryGame/ Build_* that
//     carries an `mCurrentRecipe` (it runs a recipe ⇒ it's a manufacturer) but
//     whose class is in none of the hardcoded producer sets — is surfaced into
//     `quarantined` as a breadcrumb (DC-H1). This is the runtime backstop: if a
//     future game patch renames or adds a real manufacturer, it shows in the
//     import preview instead of silently under-counting production.
//
// BOUNDARY (be honest): the recipe signal catches manufacturers only. Vanilla
// GENERATORS burn fuel and EXTRACTORS bind a resource node — neither carries
// `mCurrentRecipe`, and the shapes they DO carry (mCurrentPotential/clock is on
// every machine; mExtractableResource also sits on world markers) are not
// low-false-positive enough to surface without spamming decor. A renamed/added
// vanilla generator or extractor therefore remains the documented MANUAL-AUDIT
// boundary — the recognized-set cross-check against Docs.json — not this
// runtime breadcrumb.

import type { ImportMachine, ImportSnapshot } from "../state/types";

export const EXTRACTORS = new Set([
  "Build_MinerMk1_C",
  "Build_MinerMk2_C",
  "Build_MinerMk3_C",
  "Build_WaterPump_C",
  "Build_OilPump_C",
  "Build_FrackingExtractor_C",
  "Build_FrackingSmasher_C",
]);
export const GENERATORS = new Set([
  "Build_GeneratorCoal_C",
  "Build_GeneratorFuel_C",
  "Build_GeneratorNuclear_C",
  "Build_GeneratorBiomass_Automated_C",
  "Build_GeneratorBiomass_C",
  "Build_GeneratorGeoThermal_C",
]);
export const MANUFACTURERS = new Set([
  "Build_ConstructorMk1_C",
  "Build_SmelterMk1_C",
  "Build_AssemblerMk1_C",
  "Build_FoundryMk1_C",
  "Build_ManufacturerMk1_C",
  "Build_OilRefinery_C",
  "Build_Packager_C",
  "Build_Blender_C",
  "Build_HadronCollider_C",
  "Build_Converter_C",
  "Build_QuantumEncoder_C",
]);

export interface RawObject {
  typePath?: string;
  transform?: { translation?: { x: number; y: number; z: number } };
  properties?: Record<string, unknown>;
}

export function classOf(typePath: string): string {
  const last = typePath.split("/").pop() ?? typePath;
  return last.includes(".") ? (last.split(".").pop() ?? last) : last;
}

export function recipeOf(obj: RawObject): string | null {
  const prop = obj.properties?.mCurrentRecipe as
    | { value?: { pathName?: string } }
    | undefined;
  const path = prop?.value?.pathName;
  if (!path) return null;
  return classOf(path);
}

function clockOf(obj: RawObject): number {
  const prop = obj.properties?.mCurrentPotential as
    | { value?: number | { value?: number } }
    | undefined;
  const v = prop?.value;
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && typeof v.value === "number") return v.value;
  return 1.0;
}

// Stable reference to the resource node (or water volume) this extractor sits
// on: an `mExtractableResource` object-property whose pathName is the level
// instance name (e.g. "…:PersistentLevel.BP_ResourceNode109"). Survives
// re-saves, so it re-matches the same node on re-import. The save carries NO
// purity, resource-item, or items/min rate on the node — those come from the
// bundled world catalog (snapshot-primary purity, W2b-C). Guarded: undefined
// when absent.
function nodeActorIdOf(obj: RawObject): string | undefined {
  const prop = obj.properties?.mExtractableResource as
    | { value?: { pathName?: string } }
    | undefined;
  const path = prop?.value?.pathName;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

// The purchased/unlocked schematics live on the single BP_SchematicManager
// actor as `mPurchasedSchematics`: an ObjectProperty array whose pathNames end
// in the schematic class (e.g. "…/Schematic_1-2.Schematic_1-2_C"). Returns the
// class names; [] when the actor/property is absent (honest degradation).
function unlockedSchematicsOf(obj: RawObject): string[] {
  const prop = obj.properties?.mPurchasedSchematics as
    | { values?: Array<{ pathName?: string }>; value?: Array<{ pathName?: string }> }
    | undefined;
  const list = prop?.values ?? prop?.value;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    const path = entry?.pathName;
    if (typeof path === "string" && path.length > 0) out.push(classOf(path));
  }
  return out;
}

function toMachine(obj: RawObject, cls: string): ImportMachine | null {
  const t = obj.transform?.translation;
  if (!t) return null;
  // Satisfactory saves are in cm; the map plane is meters.
  return {
    class: cls,
    recipe: recipeOf(obj),
    clock: clockOf(obj),
    x: t.x / 100,
    y: t.y / 100,
    z: t.z / 100,
  };
}

/**
 * Reduce the parsed save's level object-graph to a compact ImportSnapshot.
 * Pure: no worker/`self`/parser dependency, so it is unit-testable directly.
 */
export function buildSnapshot(
  saveName: string,
  buildVersion: string,
  levels: Record<string, { objects?: RawObject[] }>,
): ImportSnapshot {
  const snapshot: ImportSnapshot = {
    saveName,
    buildVersion,
    machines: [],
    extractors: [],
    unlockedSchematics: [],
    belts: {},
    rails: 0,
    powerLines: 0,
    locomotives: 0,
    wagons: 0,
    trainStations: 0,
    quarantined: {},
  };
  for (const lvl of Object.values(levels ?? {})) {
    for (const obj of lvl.objects ?? []) {
      const typePath = obj.typePath ?? "";
      const cls = classOf(typePath);
      if (MANUFACTURERS.has(cls) || GENERATORS.has(cls)) {
        const m = toMachine(obj, cls);
        if (m) snapshot.machines.push(m);
      } else if (EXTRACTORS.has(cls)) {
        const m = toMachine(obj, cls);
        if (m) {
          // Node context for W2b node reconciliation. Only the stable node
          // ref is in the save; purity/resource/rate are not — emit null and
          // let the world catalog supply purity downstream (honest absence).
          m.nodeActorId = nodeActorIdOf(obj);
          m.resource = null;
          m.purity = null;
          snapshot.extractors!.push(m);
        }
      } else if (cls === "BP_SchematicManager_C") {
        snapshot.unlockedSchematics = unlockedSchematicsOf(obj);
      } else if (cls.startsWith("Build_ConveyorBelt")) {
        snapshot.belts![cls] = (snapshot.belts![cls] ?? 0) + 1;
      } else if (cls.startsWith("Build_RailroadTrack")) {
        snapshot.rails!++;
      } else if (cls === "Build_PowerLine_C") {
        snapshot.powerLines!++;
      } else if (cls === "BP_Locomotive_C") {
        snapshot.locomotives!++;
      } else if (cls === "BP_FreightWagon_C") {
        snapshot.wagons!++;
      } else if (cls === "Build_TrainStation_C" || cls === "Build_TrainDockingStation_C") {
        snapshot.trainStations!++;
      } else if (
        typePath.startsWith("/Game/FactoryGame/") &&
        cls.startsWith("Build_") &&
        recipeOf(obj) !== null
      ) {
        // Unrecognized VANILLA PRODUCER (DC-H1 backstop): a /Game/FactoryGame/
        // Build_* carrying an mCurrentRecipe runs a recipe ⇒ it's a
        // manufacturer, yet it matched none of the hardcoded producer sets.
        // Surface it as a breadcrumb (never silently drop) so a future game
        // patch that renames/adds a real machine is VISIBLE in the preview
        // instead of quietly under-counting production. Decor/world-markers/
        // transport-stations carry no recipe and never reach here.
        snapshot.quarantined![cls] = (snapshot.quarantined![cls] ?? 0) + 1;
      } else if (
        (cls.startsWith("Build_") || cls.startsWith("BP_")) &&
        !typePath.startsWith("/Game/FactoryGame/")
      ) {
        // modded content — quarantine, listed and ignored (SDD §8.1)
        snapshot.quarantined![cls] = (snapshot.quarantined![cls] ?? 0) + 1;
      }
    }
  }
  return snapshot;
}
