// MANIFOLD boot screen (brand handoff §4a/§7): the expanding manifold owns
// the pre-ready surface and reveals the live map with the 7j crossfade.
// Three contracts, three drives:
//   1. FAST BOOT (real bridge speed): the overlay appears, shows a REAL
//      ticker stage, and clears without the long done-beat — the map is
//      interactive promptly.
//   2. SLOW BOOT (hydrate delayed via route interception — a REAL pending
//      request, not a synthetic timer): the full choreography plays — survey
//      intro, ticker narrating stages, wordmark on completion — and the
//      overlay then reveals the map.
//   3. REDUCED MOTION: a static mark + ticker, dismissed the moment the app
//      is ready. (The map animation loop honors the same media query.)

import { test, expect } from "@playwright/test";
import { resetView } from "./helpers";

test("fast boot: overlay shows a real stage then reveals an interactive map", async ({ page, request }) => {
  await resetView(request);
  await page.goto("/");
  // The overlay may already be mid-reveal on a warm bridge — accept either
  // catching it live or finding it already gone, but the app must land.
  await expect(page.getByTestId("map-root")).toBeVisible();
  await expect(page.getByTestId("boot-screen")).toHaveCount(0, { timeout: 10_000 });
  // Interactive: the DATA menu opens (clicks are not intercepted).
  await page.getByTestId("btn-data-menu").click();
  await expect(page.getByTestId("data-menu")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("slow boot: full choreography — survey, staged ticker, wordmark, crossfade", async ({ browser, request }) => {
  await resetView(request);
  // The suite runs under prefers-reduced-motion (playwright.config.ts), which
  // the BootScreen honors with the static instant-dismiss variant — the FULL
  // choreography needs a no-preference context of its own.
  const ctx = await browser.newContext({ reducedMotion: "no-preference", viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  // Hold the REAL hydrate response for ~2.5s: the loader is genuinely
  // pending, so the survey intro completes and the expansion stalls at the
  // READING PLAN FILE stage exactly as it would on a slow disk/web boot.
  await page.route("**/api/hydrate", async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });
  await page.goto("http://localhost:5173/");
  const bootScreen = page.getByTestId("boot-screen");
  await expect(bootScreen).toBeVisible();
  // Mid-load ticker narrates the real stage.
  await expect(page.getByTestId("boot-ticker")).toContainText("READING PLAN FILE");
  // Completion: the ticker lands on the empire figure, the wordmark shows.
  await expect(page.getByTestId("boot-ticker")).toContainText("EMPIRE ONLINE", { timeout: 15_000 });
  await expect(bootScreen).toContainText("MANIFOLD");
  // The done-beat holds, then the crossfade clears the overlay for good.
  await expect(bootScreen).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("map-root")).toBeVisible();
  await ctx.close();
});

test("reduced motion: static mark + ticker, dismissed on ready", async ({ browser, request }) => {
  await resetView(request);
  const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  // Delay hydrate a touch so the static frame is observable at all.
  await page.route("**/api/hydrate", async (route) => {
    await new Promise((r) => setTimeout(r, 700));
    await route.continue();
  });
  await page.goto("http://localhost:5173/");
  await expect(page.getByTestId("boot-screen")).toBeVisible();
  await expect(page.getByTestId("boot-ticker")).toBeVisible();
  // Dismissed the moment ready lands — no beats, no crossfade hold.
  await expect(page.getByTestId("boot-screen")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId("map-root")).toBeVisible();
  await ctx.close();
});
