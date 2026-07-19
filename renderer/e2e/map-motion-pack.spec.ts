// MANIFOLD map/panel motion pack (handoff §5) — DOM-observable grammar:
//   7b  placed factory pin drops in (.pin-motion-drop)
//   7h  undo leaves a dashed pin ghost; redo returns the pin with a pop
//   7f  a real recompute sweeps the audit rows (RE-AUDITING)
// Canvas draw-ins (7a tethers, 7e routes, 7c converge dots) render on the
// anim canvas and are exercised by the same detector these tests drive; the
// pixels themselves aren't asserted here. Motion classes are transient, so
// checks rAF-poll in-page right after the dispatch (same pattern as the
// graph motion spec). The last test proves the reduced-motion suite default
// suppresses the grammar entirely.

import { test, expect, type Page } from "@playwright/test";
import { resetView } from "./helpers";

interface StoreWin {
  __ficsitStore: {
    getState(): {
      dispatch(cmds: unknown[], opts?: { select?: boolean }): Promise<string[] | null>;
      undo(): Promise<void>;
      redo(): Promise<void>;
    };
  };
}

const CREATE = (name: string) => ({
  type: "create_factory",
  name,
  position: { x: -2600, y: 2100 },
  region: "GRASS FIELDS",
});

/** Run an in-page store action, then rAF-poll (~500ms) for a selector. */
async function actAndSee(page: Page, act: string, cmds: unknown[], selector: string): Promise<boolean> {
  return page.evaluate(
    async ({ act, cmds, selector }) => {
      const st = (window as unknown as StoreWin).__ficsitStore.getState();
      if (act === "dispatch") await st.dispatch(cmds);
      else if (act === "undo") await st.undo();
      else await st.redo();
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        if (document.querySelector(selector)) return true;
      }
      return false;
    },
    { act, cmds, selector },
  );
}

test("map motion: placement drops, undo ghosts, redo pops the pin", async ({ browser, request }) => {
  await resetView(request);
  const ctx = await browser.newContext({ reducedMotion: "no-preference", viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("http://localhost:5173/");
  await expect(page.getByTestId("map-root")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");

  // 7b — the placed pin's marker mounts with the drop grammar.
  const sawDrop = await actAndSee(page, "dispatch", [CREATE("MOTION PIN")], ".pin-icon.pin-motion-drop");
  expect(sawDrop, "placed pin plays the 7b drop").toBe(true);

  // 7h — undoing the placement flashes a dashed ghost where the pin stood…
  const sawGhost = await actAndSee(page, "undo", [], ".map-pin-ghost");
  expect(sawGhost, "undo leaves the 7h pin ghost").toBe(true);

  // …and redo returns it with the micro-pop.
  const sawPop = await actAndSee(page, "redo", [], ".pin-icon.pin-motion-pop");
  expect(sawPop, "redo returns the pin with the 7h pop").toBe(true);
  await ctx.close();
});

test("map motion 7f: a real recompute sweeps the open audit drawer", async ({ browser, request }) => {
  await resetView(request);
  const ctx = await browser.newContext({ reducedMotion: "no-preference", viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("http://localhost:5173/");
  await expect(page.getByTestId("map-root")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await page.getByTestId("audit-handle").click();
  await expect(page.getByTestId("audit-drawer")).toBeVisible();

  const sawSweep = await actAndSee(page, "dispatch", [CREATE("SWEEP TRIGGER")], ".audit-body.reauditing");
  expect(sawSweep, "planHash change while open plays the 7f sweep").toBe(true);
  await expect(page.locator(".audit-live")).toContainText("RE-AUDITING");
  // the sweep releases and the tag returns to LIVE
  await expect(page.locator(".audit-live")).toContainText("LIVE", { timeout: 3000 });
  await ctx.close();
});

test("reduced motion: no pin grammar, no sweep", async ({ page, request }) => {
  // Default suite context = prefers-reduced-motion: reduce.
  await resetView(request);
  await page.goto("/");
  await expect(page.getByTestId("map-root")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  const saw = await page.evaluate(async () => {
    const st = (window as unknown as StoreWin).__ficsitStore.getState();
    await st.dispatch([
      { type: "create_factory", name: "STILL PIN", position: { x: -2400, y: 2300 }, region: "GRASS FIELDS" },
    ]);
    let cls = false;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (document.querySelector(".pin-icon.pin-motion-drop, .map-pin-ghost")) cls = true;
    }
    await st.undo();
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (document.querySelector(".map-pin-ghost")) cls = true;
    }
    return cls;
  });
  expect(saw, "no map motion grammar under reduced motion").toBe(false);
});
