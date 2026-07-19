// MANIFOLD interaction motion pack (handoff §5) — graph-local grammar:
//   7l  create  → blueprint build class on the new card
//   7k  delete  → deconstruct ghost afterimage (dashed bp outline)
//   7h  undo/redo → return pop / removal ghost
//   7m  MAKE batch → left→right construction stagger (--build-i)
// Driven through REAL in-page store dispatches (__ficsitStore, exposed on the
// dev server) — external /api/edit seeding never animates the live store.
// The motion classes/ghosts are transient (cleared within ~1s), so DOM checks
// poll rAF in-page right after the dispatch instead of racing from outside.
// The suite runs under prefers-reduced-motion (playwright.config.ts); the
// full grammar needs a no-preference context, and the final test asserts the
// reduced default really suppresses ghosts.

import { test, expect, type Page } from "@playwright/test";
import { resetView } from "./helpers";

interface StoreWin {
  __ficsitStore: {
    getState(): {
      dispatch(cmds: unknown[], opts?: { select?: boolean }): Promise<string[] | null>;
      undo(): Promise<void>;
      redo(): Promise<void>;
      plan: { groups: Record<string, unknown> };
    };
    setState(partial: Record<string, unknown>): void;
  };
}

/** Dispatch cmds in-page, then rAF-poll (~500ms) for a selector to appear. */
async function dispatchAndSee(page: Page, cmds: unknown[], selector: string): Promise<boolean> {
  return page.evaluate(
    async ({ cmds, selector }) => {
      const st = (window as unknown as StoreWin).__ficsitStore.getState();
      await st.dispatch(cmds);
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        if (document.querySelector(selector)) return true;
      }
      return false;
    },
    { cmds, selector },
  );
}

async function openFreshFactory(page: Page, name: string): Promise<string> {
  const factory = await page.evaluate(async (name) => {
    const st = (window as unknown as StoreWin).__ficsitStore.getState();
    const created = await st.dispatch([
      { type: "create_factory", name, position: { x: -3200, y: 1400 }, region: "GRASS FIELDS" },
    ]);
    const id = created![0];
    (window as unknown as StoreWin).__ficsitStore.setState({ view: { mode: "factory", factoryId: id } });
    return id;
  }, name);
  await expect(page.getByTestId("graph-root")).toBeVisible();
  return factory;
}

test("motion pack: create builds, delete ghosts, undo/redo pop and ghost", async ({ browser, request }) => {
  await resetView(request);
  const ctx = await browser.newContext({ reducedMotion: "no-preference", viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("http://localhost:5173/");
  await expect(page.getByTestId("map-root")).toBeVisible({ timeout: 15_000 });
  const factory = await openFreshFactory(page, "MOTION LAB");

  // 7l — a created machine card mounts with the blueprint-build grammar.
  // The created id comes from THIS dispatch's response — the suite runs
  // serially against one shared plan, so plan.groups holds every earlier
  // spec's machines too.
  const createRes = await page.evaluate(async (factory) => {
    const st = (window as unknown as StoreWin).__ficsitStore.getState();
    const created = await st.dispatch([
      {
        type: "add_group",
        factory,
        machine: "Build_SmelterMk1_C",
        recipe: "Recipe_IngotIron_C",
        count: 1,
        clock: 1.0,
        graphPos: { x: 300, y: 100 },
        floor: 0,
      },
    ]);
    let saw = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (document.querySelector(".group-card.mount-build")) {
        saw = true;
        break;
      }
    }
    return { saw, id: created![0] };
  }, factory);
  expect(createRes.saw, "created card plays the 7l blueprint build").toBe(true);
  const groupId = createRes.id;

  // 7k — deleting it leaves a transient deconstruct ghost (dashed outline).
  const sawDeleteGhost = await dispatchAndSee(page, [{ type: "delete_group", id: groupId }], ".mfd-ghost-node.delete");
  expect(sawDeleteGhost, "deleted card leaves the 7k deconstruct ghost").toBe(true);

  // 7h — undo returns the entity with the micro-pop…
  const sawPop = await page.evaluate(async () => {
    const st = (window as unknown as StoreWin).__ficsitStore.getState();
    await st.undo();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (document.querySelector(".group-card.mount-pop")) return true;
    }
    return false;
  });
  expect(sawPop, "undo returns the card with the 7h pop").toBe(true);

  // …and redo (re-performing the delete) plays the removal ghost again.
  const sawRedoGhost = await page.evaluate(async () => {
    const st = (window as unknown as StoreWin).__ficsitStore.getState();
    await st.redo();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (document.querySelector(".mfd-ghost-node")) return true;
    }
    return false;
  });
  expect(sawRedoGhost, "redo of a delete ghosts the removal").toBe(true);
  await ctx.close();
});

test("motion 7m: a batch create staggers construction left → right", async ({ browser, request }) => {
  await resetView(request);
  const ctx = await browser.newContext({ reducedMotion: "no-preference", viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  await page.goto("http://localhost:5173/");
  await expect(page.getByTestId("map-root")).toBeVisible({ timeout: 15_000 });
  const factory = await openFreshFactory(page, "CHAIN LAB");

  // One dispatch, three groups (the MAKE shape): construction order must
  // follow x, exposed as each card's --build-i stagger index.
  const idx = await page.evaluate(async (factory) => {
    const st = (window as unknown as StoreWin).__ficsitStore.getState();
    const mk = (recipe: string, machine: string, x: number) => ({
      type: "add_group",
      factory,
      machine,
      recipe,
      count: 1,
      clock: 1.0,
      graphPos: { x, y: 120 },
      floor: 0,
    });
    await st.dispatch([
      mk("Recipe_IronRod_C", "Build_ConstructorMk1_C", 620),
      mk("Recipe_IngotIron_C", "Build_SmelterMk1_C", 300),
      mk("Recipe_Screw_C", "Build_ConstructorMk1_C", 940),
    ]);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (document.querySelectorAll(".group-card.mount-build").length === 3) break;
    }
    const at = (testid: string) => {
      const el = document.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
      return el ? Number(getComputedStyle(el).getPropertyValue("--build-i") || "-1") : -1;
    };
    return {
      smelter: at("group-Recipe_IngotIron_C"),
      rod: at("group-Recipe_IronRod_C"),
      screw: at("group-Recipe_Screw_C"),
    };
  }, factory);
  expect(idx.smelter, "leftmost group constructs first").toBe(0);
  expect(idx.rod).toBe(1);
  expect(idx.screw).toBe(2);
  await ctx.close();
});

test("reduced motion: no ghosts, no build choreography", async ({ page, request }) => {
  // Default suite context = prefers-reduced-motion: reduce.
  await resetView(request);
  await page.goto("/");
  await expect(page.getByTestId("map-root")).toBeVisible({ timeout: 15_000 });
  const factory = await openFreshFactory(page, "STILL LAB");
  const saw = await page.evaluate(async (factory) => {
    const st = (window as unknown as StoreWin).__ficsitStore.getState();
    const created = await st.dispatch([
      {
        type: "add_group",
        factory,
        machine: "Build_SmelterMk1_C",
        recipe: "Recipe_IngotIron_C",
        count: 1,
        clock: 1.0,
        graphPos: { x: 300, y: 100 },
        floor: 0,
      },
    ]);
    let sawBuild = false;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (document.querySelector(".group-card.mount-build")) sawBuild = true;
    }
    await st.dispatch([{ type: "delete_group", id: created![0] }]);
    let sawGhost = false;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      if (document.querySelector(".mfd-ghost-node")) sawGhost = true;
    }
    return { sawBuild, sawGhost };
  }, factory);
  expect(saw.sawBuild, "no 7l class under reduced motion").toBe(false);
  expect(saw.sawGhost, "no removal ghosts under reduced motion").toBe(false);
});
