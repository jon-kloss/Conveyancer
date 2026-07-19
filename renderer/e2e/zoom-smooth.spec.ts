// Smooth eased wheel zoom: one wheel tick must GLIDE the zoom through several
// intermediate values over the ease (not one discrete jump), passing through
// fractional levels (zoomSnap 0) — proving the custom eased handler drives the
// zoom, not Leaflet's stepped wheel zoom. The map stamps its live zoom on
// [data-testid=map-root] data-zoom on every zoom frame (a direct DOM write).
//
// NOTE: the assert is on the SAMPLED PATH, not the landing value — the final
// level can legitimately coincide with a multiple of 0.5 depending on where
// the ease target lands, which made a landing-value assert flake on CI while
// stepped zoom (the actual regression) still fails the fractional-path check:
// Leaflet's stepped wheel zoom only ever stamps 0.5-multiples.

import { test, expect } from "@playwright/test";
import { resetView } from "./helpers";

test("wheel zoom eases through intermediate fractional levels", async ({ page, request }) => {
  await resetView(request);
  await page.goto("/");
  const skip = page.getByTestId("onboard-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  const root = page.getByTestId("map-root");
  await expect(root).toBeVisible();
  // Headless chromium can park requestAnimationFrame for the first ~1.5s of
  // a fresh page (BeginFrames idle until the compositor warms) — on a fast
  // boot the 450ms sampling window then sees 1-2 frames and a real glide
  // reads as a jump. Wait for a steady frame cadence first: this spec tests
  // the zoom EASING, not early-page frame scheduling.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let last = performance.now();
        let streak = 0;
        const tick = () => {
          const now = performance.now();
          streak = now - last < 50 ? streak + 1 : 0;
          last = now;
          if (streak >= 5) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  const box = (await page.locator(".leaflet-container").boundingBox())!;

  // Dispatch one wheel tick at the map center, then sample the live zoom stamp
  // across the ease (rAF for ~450ms), collecting every distinct value seen.
  const { before, after, samples } = await page.evaluate(
    ({ x, y }) =>
      new Promise<{ before: number; after: number; samples: number[] }>((resolve) => {
        const rootEl = document.querySelector('[data-testid="map-root"]') as HTMLElement;
        const el = document.querySelector(".leaflet-container") as HTMLElement;
        const z = () => Number(rootEl.dataset.zoom);
        const before = z();
        const seen = new Set<string>();
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, clientX: x, clientY: y, bubbles: true, cancelable: true }));
        const t0 = performance.now();
        const tick = () => {
          seen.add(rootEl.dataset.zoom ?? "");
          if (performance.now() - t0 < 450) requestAnimationFrame(tick);
          else resolve({ before, after: z(), samples: [...seen].map(Number).filter((v) => !Number.isNaN(v)) });
        };
        requestAnimationFrame(tick);
      }),
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );

  // Zoom increased...
  expect(after).toBeGreaterThan(before);
  // ...through MULTIPLE distinct intermediate values (a glide, not one jump)...
  expect(samples.length).toBeGreaterThanOrEqual(3);
  // ...including fractional levels along the path — stepped zoom (the guarded
  // regression) only ever stamps multiples of 0.5, so it fails this check no
  // matter where the ease happens to land.
  expect(samples.some((v) => v % 0.5 !== 0)).toBe(true);
});
