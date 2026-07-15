// Web Phase 3 ACCEPTANCE PROOF — the built web app (dist-web) runs entirely in
// the browser: the wasm Session in a Web Worker over IndexedDB, no backend
// server. This spec drives that artifact end to end and proves the core loop
// the whole phase exists for: BOOT (hydrate over the bundled fixture) → EDIT
// (create a factory through the app's real store → WasmBackend → worker → wasm)
// → RENDER (the projection the map canvas draws from reflects it, and the
// selection drawer shows it) → RELOAD → PERSIST (the factory survives the
// IndexedDB round-trip: worker reconstructs the MemoryPlanStore from the saved
// snapshot blob).
//
// Isolation: Playwright gives each test a fresh browser context, so IndexedDB
// starts empty — the first boot is a clean fixture plan, and the reload stays
// in the same context so the snapshot persists across it. This suite has its
// own config (playwright.web.config.ts) and never touches the 31 dev-bridge
// specs.

import { test, expect, type Page } from "@playwright/test";

/** The in-page store handle store.ts exposes in the web build (__WASM_BACKEND__
 *  guard). Only the two members the smoke needs are typed. */
interface StoreWin {
  __ficsitStore: {
    getState(): {
      ready: boolean;
      error: string | null;
      plan: { factories: Record<string, { name: string }> };
      dispatch(cmds: unknown[], opts?: { select?: boolean }): Promise<string[] | null>;
    };
  };
}

/** Wait for the wasm session to boot and hydrate (or surface a fatal error). */
async function waitReady(page: Page): Promise<void> {
  await expect(page.getByTestId("map-root")).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as Partial<StoreWin>;
      const st = w.__ficsitStore?.getState();
      return !!st && (st.ready || st.error !== null);
    },
    { timeout: 30_000 },
  );
  const error = await page.evaluate(
    () => (window as unknown as StoreWin).__ficsitStore.getState().error,
  );
  expect(error, "the wasm session hydrated without a fatal error").toBeNull();
}

function factoryCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      Object.keys((window as unknown as StoreWin).__ficsitStore.getState().plan.factories).length,
  );
}

test("boots the wasm session, edits, and persists across reload", async ({ page }) => {
  // BOOT — fresh context ⇒ empty IndexedDB ⇒ the bundled fixture plan (no
  // factories). This proves the wasm module instantiates and hydrate() runs.
  await page.goto("/");
  await waitReady(page);
  expect(await factoryCount(page), "fixture plan boots empty").toBe(0);

  // EDIT — create a factory through the real store path (dispatch → WasmBackend
  // → worker → wasm Session.edit → snapshot to IndexedDB). `select` opens the
  // summary drawer, the visible signal the map projection reflects the edit.
  const created = await page.evaluate(async () => {
    return (window as unknown as StoreWin).__ficsitStore.getState().dispatch(
      [
        {
          type: "create_factory",
          name: "SMOKE FACTORY",
          position: { x: 100, y: 200, z: 0 },
          region: "GRASS FIELDS",
        },
      ],
      { select: true },
    );
  });
  expect(created, "the edit minted one factory id").toHaveLength(1);

  // RENDER — the store projection (the source the map canvas draws) now holds
  // the factory, and the selection drawer shows its name.
  expect(await factoryCount(page)).toBe(1);
  const drawer = page.getByTestId("summary-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".drawer-name")).toHaveText("SMOKE FACTORY");

  // RELOAD + PERSIST — a new page load reconstructs the session from the
  // IndexedDB snapshot blob. The factory must survive (this is the round-trip
  // that would fail if persistence were a no-op or lost on reload).
  await page.reload();
  await waitReady(page);
  expect(await factoryCount(page), "the factory persisted across reload").toBe(1);
  const names = await page.evaluate(() =>
    Object.values(
      (window as unknown as StoreWin).__ficsitStore.getState().plan.factories,
    ).map((f) => f.name),
  );
  expect(names).toContain("SMOKE FACTORY");
});
