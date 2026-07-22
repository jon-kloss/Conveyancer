import { describe, it, expect } from "vitest";
import { extractionRate } from "./extraction";

// A machine shaped like the serialized Rust Machine (raw mL-scale itemsPerCycle).
const ext = (itemsPerCycle: number) =>
  ({ kind: "extractor", itemsPerCycle, cycleTimeS: 1 }) as any;

describe("extractionRate (map twin of gamedata::extraction_rate)", () => {
  it("solids: raw items/min, no ÷1000 (Mk1 miner 1/cycle → 60/min normal)", () => {
    expect(extractionRate(ext(1), "normal", 1, false)).toBe(60);
    expect(extractionRate(ext(1), "pure", 1, false)).toBe(120);
    expect(extractionRate(ext(1), "impure", 1, false)).toBe(30);
  });
  it("fluids: ÷1000 mL→m³ (Water/Oil pump raw 2000/cycle → 120 m³/min normal)", () => {
    // the bug: without ÷1000 this read 120000, which persisted as a claim's port ceiling
    expect(extractionRate(ext(2000), "normal", 1, true)).toBe(120);
    expect(extractionRate(ext(2000), "pure", 1, true)).toBe(240);
    expect(extractionRate(ext(2000), "impure", 1, true)).toBe(60);
  });
  it("clock scales the rate", () => {
    expect(extractionRate(ext(2000), "normal", 0.5, true)).toBe(60);
  });
});
