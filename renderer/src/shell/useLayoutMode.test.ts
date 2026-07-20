// #110 — the phone breakpoint joins the A1 degradation ladder. Pins the exact
// boundaries: <640 phone (read-only companion dashboard), 640-1599 overlay,
// 1600-1919 compact, >=1920 reference.

import { describe, expect, it } from "vitest";
import { layoutModeFor } from "./useLayoutMode";

describe("layoutModeFor", () => {
  it("phone under 640, overlay from 640", () => {
    expect(layoutModeFor(320, 700)).toBe("phone");
    expect(layoutModeFor(639, 900)).toBe("phone");
    expect(layoutModeFor(640, 900)).toBe("overlay");
    expect(layoutModeFor(1280, 720)).toBe("overlay");
  });

  it("keeps the existing compact/reference ladder", () => {
    expect(layoutModeFor(1599, 900)).toBe("overlay");
    expect(layoutModeFor(1600, 900)).toBe("compact");
    expect(layoutModeFor(1919, 1080)).toBe("compact");
    expect(layoutModeFor(1920, 1080)).toBe("reference");
  });
});
