// Auto-fit webview zoom (Tauri shell only). A 4K TV at Windows 300% scaling
// has ~1280×720 LOGICAL pixels — under the 1366×768 layout floor even though
// physical pixels abound. Browser-level zoom (WebView2 ZoomFactor) shrinks CSS
// pixels so the layout fits while text stays physically large; unlike CSS
// `zoom` it keeps innerWidth/getBoundingClientRect/Leaflet coordinates
// consistent. We only ever zoom OUT (≤1), never below MIN_ZOOM.

import { useEffect } from "react";

const isTauri = "__TAURI_INTERNALS__" in window;
const FLOOR_W = 1366;
const FLOOR_H = 768;
const MIN_ZOOM = 0.6;

export function useAutoZoom() {
  useEffect(() => {
    if (!isTauri) return;
    let zoom = 1;
    let timer: number | undefined;
    let disposed = false;

    const fit = async () => {
      // innerWidth is CSS px = logical px / zoom, so this is zoom-invariant.
      const logicalW = window.innerWidth * zoom;
      const logicalH = window.innerHeight * zoom;
      const target = Math.max(
        MIN_ZOOM,
        Math.min(1, logicalW / FLOOR_W, logicalH / FLOOR_H),
      );
      if (disposed || Math.abs(target - zoom) < 0.02) return;
      zoom = target;
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        await getCurrentWebview().setZoom(zoom);
      } catch {
        // Zoom is an enhancement — without it the overlay layout still works,
        // just more cramped.
      }
    };

    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void fit(), 150);
    };
    window.addEventListener("resize", onResize);
    void fit();
    return () => {
      disposed = true;
      window.removeEventListener("resize", onResize);
      window.clearTimeout(timer);
    };
  }, []);
}
