// Save-parse worker (SDD §8.1–8.2): streams the .sav through the community
// parser off the UI thread, then reduces the raw object soup to a compact
// ImportSnapshot via the pure `buildSnapshot` reducer (see parseSnapshot.ts,
// which carries the full recognition/quarantine contract and is unit-tested).

import { Parser } from "@etothepii/satisfactory-file-parser";
import { buildSnapshot, type RawObject } from "./parseSnapshot";

self.onmessage = (e: MessageEvent<{ name: string; bytes: ArrayBuffer }>) => {
  const { name, bytes } = e.data;
  try {
    const save = Parser.ParseSave(name, bytes);
    const buildVersion = String((save.header as { buildVersion?: number })?.buildVersion ?? "");
    const levels = save.levels as Record<string, { objects?: RawObject[] }>;
    const snapshot = buildSnapshot(name.replace(/\.sav$/i, ""), buildVersion, levels);
    self.postMessage({ snapshot });
  } catch (err) {
    // parse failure degrades to "skip — manual entry" upstream (no dead ends)
    self.postMessage({ error: String(err) });
  }
};
