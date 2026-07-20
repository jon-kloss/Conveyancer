// Addendum A1 — responsive degradation. The canvas is the only flex element;
// panels have exactly two docked widths plus an overlay conversion. All CSS px.

import { useEffect, useState } from "react";

export type LayoutMode = "reference" | "compact" | "overlay" | "phone";

export function layoutModeFor(width: number, _height: number): LayoutMode {
  // No hard floor: below the A1 reference sizes everything degrades to the
  // overlay layout (panels slide over the canvas). The shell additionally
  // auto-zooms out on low-logical-resolution displays (useAutoZoom).
  // Under the phone breakpoint the editing surfaces (React Flow box-select,
  // precise belt wiring, map editing) degrade badly on touch — the app swaps
  // to the read-only MobileDashboard instead (#110).
  if (width < 640) return "phone";
  if (width < 1600) return "overlay";
  if (width < 1920) return "compact";
  return "reference";
}

export function useLayoutMode(): { mode: LayoutMode; width: number; height: number } {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  useEffect(() => {
    const onResize = () => setSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return { mode: layoutModeFor(size.width, size.height), ...size };
}
