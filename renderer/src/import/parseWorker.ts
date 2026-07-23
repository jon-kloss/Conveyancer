// Save-parse worker (SDD §8.1–8.2): streams the .sav through the community
// parser off the UI thread, then reduces the raw object soup to a compact
// ImportSnapshot via the pure `buildSnapshot` reducer (see parseSnapshot.ts,
// which carries the full recognition/quarantine contract and is unit-tested).

import { Parser } from "@etothepii/satisfactory-file-parser";
import { extractLogistics } from "./logisticsGeometry";
import { buildSnapshot, type RawObject } from "./parseSnapshot";

self.onmessage = (e: MessageEvent<{ name: string; bytes: ArrayBuffer }>) => {
  const { name, bytes } = e.data;
  try {
    const save = Parser.ParseSave(name, bytes);
    const buildVersion = String((save.header as { buildVersion?: number })?.buildVersion ?? "");
    const levels = save.levels as Record<string, { objects?: RawObject[] }>;
    const saveName = name.replace(/\.sav$/i, "");
    const snapshot = buildSnapshot(saveName, buildVersion, levels);
    // Same object soup, second reduction: as-built belt/pipe/rail/power
    // polylines for the map's LOGISTICS underlay (renderer-side only).
    const logistics = extractLogistics(saveName, levels);
    self.postMessage({ snapshot, logistics });
  } catch (err) {
    // parse failure degrades to "skip — manual entry" upstream (no dead ends)
    self.postMessage({ error: String(err) });
  }
};
