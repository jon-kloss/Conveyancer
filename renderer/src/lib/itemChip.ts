// Deterministic item chips: a colour + 2-letter monogram derived from the item
// class, so Iron Ore / Iron Ingot / Copper read apart at a glance instead of the
// old identical hatch square. Raw resources reuse the map resource palette (a
// chip matches its node on the map); crafted items get a muted hashed hue that
// dodges the reserved signal-orange / blueprint-blue bands. No bundled art.

import { prettyClass } from "./format";

// Raw extractable resources → the shared map palette token (see tokens.rs).
const RESOURCE_VAR: Record<string, string> = {
  Desc_OreIron_C: "iron",
  Desc_OreCopper_C: "copper",
  Desc_Stone_C: "limestone",
  Desc_Coal_C: "coal",
  Desc_OreGold_C: "caterium",
  Desc_RawQuartz_C: "quartz",
  Desc_Sulfur_C: "sulfur",
  Desc_LiquidOil_C: "oil",
  Desc_OreBauxite_C: "bauxite",
  Desc_OreUranium_C: "uranium",
  Desc_SAM_C: "sam",
};

/** Up to two letters: initials of the first two words, else first two chars. */
export function itemMonogram(cls: string, name?: string): string {
  const pretty = (name && name.trim()) || prettyClass(cls);
  const words = pretty.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return pretty.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Accent colour for the chip. Raw resources return the map palette token so a
 *  chip matches its node; everything else gets a muted hashed hue, nudged out
 *  of the reserved signal (~30°) and blueprint (~210°) bands. */
export function itemAccent(cls: string): string {
  const res = RESOURCE_VAR[cls];
  if (res) return `var(--resource-${res})`;
  let hue = hash(cls) % 360;
  if (hue >= 20 && hue <= 45) hue = (hue + 40) % 360;
  if (hue >= 200 && hue <= 225) hue = (hue + 40) % 360;
  return `hsl(${hue} 34% 58%)`;
}
