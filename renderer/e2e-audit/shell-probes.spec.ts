// AUDIT area 11 (shell/chrome): functional probes for the titlebar DATA menu
// state machine and the status-bar PWR chip. Each test's EXPECTED result is
// stated verbatim in the header comment BEFORE any assertion — a failing probe
// is data for the mismatch protocol, not a reason to weaken the assertion.
//
// Serial, one shared dev-bridge + one plan file (like renderer/e2e). API edits
// do NOT stream to an open client, so every probe SEEDS via the API before
// page.goto and RELOADS + resetView to re-sync the store. Created factories are
// cleaned up in finally{}.

import { test, expect, type APIRequestContext } from "@playwright/test";
import { resetView } from "../e2e/helpers";

// NOTE: no serial mode — the runner uses --workers=1, and per-test isolation
// (each test seeds + deletes its own factories) means a failure must NOT
// cascade-skip sibling probes: every probe needs a verdict.

const API = "http://localhost:8791/api";
async function edit(request: APIRequestContext, cmds: unknown[]): Promise<{ created: string[] }> {
  const res = await request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
  if (!res.ok()) throw new Error(`edit ${res.status()}: ${await res.text()}`);
  return res.json();
}
async function hydrate(request: APIRequestContext): Promise<any> {
  return (await request.get(`${API}/hydrate`)).json();
}
async function dismissOnboarding(page: import("@playwright/test").Page) {
  const skip = page.getByTestId("onboard-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

// ---------------------------------------------------------------------------
// PROBE 1 — Two-click wipe DISARMS when the DATA menu closes and reopens.
//
// EXPECTED: After the menu is closed (Escape) and reopened, btn-new-empire
// reads 'Start new empire' (NOT 'Click again') — the arm was reset by the
// close (DataMenu's `useEffect(() => { if (!dataMenu) setConfirmReset(false) })`).
// The single post-reopen click therefore only RE-ARMS (button now shows 'Click
// again to delete everything'); GET /api/hydrate still reports N factories — the
// plan is NOT wiped. new-empire.spec pins arm→confirm→wipe but never the
// disarm-on-close, so a regression letting the arm survive a close would make a
// single click destructive and go uncaught.
// ---------------------------------------------------------------------------
test("two-click wipe disarms when the DATA menu closes and reopens", async ({ page, request }) => {
  await resetView(request);
  const f = (
    await edit(request, [
      { type: "create_factory", name: "DISARM TEST", position: { x: -2400, y: 2400 }, region: "GRASS FIELDS" },
    ])
  ).created[0];

  try {
    await page.goto("/");
    await dismissOnboarding(page);
    await expect(page.getByTestId("map-root")).toBeVisible();

    // N = factory count BEFORE the (non-)wipe (our one, plus any serial leftovers).
    const N = Object.keys((await hydrate(request)).plan.factories).length;
    expect(N).toBeGreaterThanOrEqual(1);

    // Open the menu and ARM the confirm (first click).
    await page.getByTestId("btn-data-menu").click();
    const reset = page.getByTestId("btn-new-empire");
    await expect(reset).toBeVisible();
    await reset.click();
    await expect(reset).toContainText(/Click again/i); // armed

    // Close the menu via Escape, then reopen it.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("data-menu")).toBeHidden();
    await page.getByTestId("btn-data-menu").click();
    await expect(page.getByTestId("data-menu")).toBeVisible();

    // EXPECTED: reopened button is DISARMED — 'Start new empire', not 'Click again'.
    const reset2 = page.getByTestId("btn-new-empire");
    await expect(reset2).toContainText(/Start new empire/i);
    await expect(reset2).not.toContainText(/Click again/i);

    // A single post-reopen click only RE-ARMS — it must NOT wipe.
    await reset2.click();
    await expect(reset2).toContainText(/Click again/i);

    // The plan is intact: still N factories.
    expect(Object.keys((await hydrate(request)).plan.factories).length).toBe(N);
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 2 — Escape while the DATA menu is open closes the menu WITHOUT clearing
// the map selection.
//
// EXPECTED: data-menu becomes hidden AND summary-drawer stays visible — the
// DataMenu capture-phase keydown handler consumed Escape (e.stopPropagation)
// so MapView's window bubble handler never ran setSelection(null). A regression
// removing that stopPropagation would close the menu AND clear the selection on
// the same keystroke (drawer would vanish).
// ---------------------------------------------------------------------------
test("Escape closes the DATA menu without clearing the map selection", async ({ page, request }) => {
  await resetView(request);
  // Seed a named factory so the header search can select it deterministically.
  const f = (
    await edit(request, [
      { type: "create_factory", name: "IRON INGOT WORKS 1", position: { x: -2500, y: 2300 }, region: "GRASS FIELDS" },
    ])
  ).created[0];

  try {
    await page.goto("/");
    await dismissOnboarding(page);
    await expect(page.getByTestId("map-root")).toBeVisible();

    // Select the factory on the map → summary drawer opens.
    await page.locator(".searchbox input").fill("iron ingot works 1");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("summary-drawer")).toBeVisible();

    // Open the DATA menu.
    await page.getByTestId("btn-data-menu").click();
    await expect(page.getByTestId("data-menu")).toBeVisible();

    // Escape: closes the menu, must NOT clear the selection.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("data-menu")).toBeHidden();
    await expect(page.getByTestId("summary-drawer")).toBeVisible();
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 3 — ⌘K/Ctrl+K while the DATA menu is open closes the menu AND focuses
// the header search.
//
// EXPECTED: data-menu becomes hidden AND the .searchbox input is focused. The
// menu's fixed backdrop did not swallow the shortcut: DataMenu's capture
// handler closed the menu WITHOUT consuming the key (no stopPropagation on the
// ⌘K branch), and SearchBox's bubble handler then focused the search. A
// regression that consumed ⌘K in the menu (or left the backdrop up) would leave
// the search unfocused or the menu open.
// ---------------------------------------------------------------------------
test("Ctrl+K closes the DATA menu and focuses the header search", async ({ page, request }) => {
  await resetView(request);

  await page.goto("/");
  await dismissOnboarding(page);
  await expect(page.getByTestId("map-root")).toBeVisible();

  await page.getByTestId("btn-data-menu").click();
  await expect(page.getByTestId("data-menu")).toBeVisible();

  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("data-menu")).toBeHidden();
  await expect(page.locator(".searchbox input")).toBeFocused();
});

// ---------------------------------------------------------------------------
// PROBE 4 — PWR chip shows the generation segment only when generation > 0
// (draw-vs-generation truth).
//
// EXPECTED: With zero generation, sb-power shows draw only — no '.sb-gen' span
// and no '/' in its text (StatusBar renders the '/ <gen> MW' span only when
// derived.totalGenerationMw > 0). After a generator group exists
// (totalGenerationMw > 0, via the nameplate fallback for an un-wired generator),
// the '.sb-gen' span appears and sb-power text contains ' / ' followed by the
// generation figure in MW. No existing spec asserts sb-power content; this pins
// that the generation half tracks totalGenerationMw > 0 rather than always
// rendering.
// ---------------------------------------------------------------------------
test("PWR chip shows the generation segment only when generation > 0", async ({ page, request }) => {
  await resetView(request);
  // Ensure the two-click wipe button is present, then run new_empire from the UI
  // so the baseline plan is empty (zero draw, zero generation).
  await edit(request, [
    { type: "create_factory", name: "WIPE SEED A", position: { x: -2400, y: 2400 }, region: "GRASS FIELDS" },
    { type: "create_factory", name: "WIPE SEED B", position: { x: -2000, y: 2000 }, region: "GRASS FIELDS" },
  ]);

  let genFactory: string | undefined;
  try {
    await page.goto("/");
    await dismissOnboarding(page);
    await expect(page.getByTestId("map-root")).toBeVisible();

    await page.getByTestId("btn-data-menu").click();
    const reset = page.getByTestId("btn-new-empire");
    await expect(reset).toBeVisible();
    await reset.click(); // arm
    await expect(reset).toContainText(/Click again/i);
    await reset.click(); // confirm → wipe
    await expect
      .poll(async () => Object.keys((await hydrate(request)).plan.factories).length, { timeout: 10_000 })
      .toBe(0);

    // Reload into the empty plan (onboarding gates on the empty plan — dismiss it).
    await page.goto("/");
    await dismissOnboarding(page);
    await expect(page.getByTestId("map-root")).toBeVisible();

    // EXPECTED (zero generation): no .sb-gen span, no '/' in the chip text.
    const sbPower = page.getByTestId("sb-power");
    await expect(sbPower).toContainText(/PWR/);
    await expect(page.locator('[data-testid="sb-power"] .sb-gen')).toHaveCount(0);
    const zeroText = (await sbPower.textContent()) ?? "";
    expect(zeroText).toMatch(/PWR .*MW/);
    expect(zeroText).not.toContain("/");

    // Pick a Generator-kind machine and a recipe that runs in it from the catalog.
    const h = await hydrate(request);
    const machines = h.gamedata.machines as Record<string, { className: string; kind: string }>;
    const recipes = h.gamedata.recipes as Record<string, { className: string; producedIn: string[] }>;
    const genMachine = Object.values(machines).find((m) => m.kind === "generator");
    expect(genMachine, "fixture catalog must expose a generator machine").toBeTruthy();
    const genRecipe = Object.values(recipes).find((r) => r.producedIn.includes(genMachine!.className));
    expect(genRecipe, "fixture catalog must expose a burn recipe for the generator").toBeTruthy();

    // Create a factory holding a single un-wired generator group (nameplate → gen>0).
    genFactory = (
      await edit(request, [
        { type: "create_factory", name: "GEN PROBE", position: { x: -2600, y: 2600 }, region: "GRASS FIELDS" },
      ])
    ).created[0];
    await edit(request, [
      {
        type: "add_group",
        factory: genFactory,
        machine: genMachine!.className,
        recipe: genRecipe!.className,
        count: 1,
        clock: 1,
        graphPos: { x: 300, y: 80 },
        floor: 0,
      },
    ]);

    // Reload so the store re-derives with the generator present.
    await page.goto("/");
    await dismissOnboarding(page);
    await expect(page.getByTestId("map-root")).toBeVisible();

    // EXPECTED (generation > 0): the .sb-gen span appears and the chip text
    // carries ' / <gen> MW'.
    await expect(page.locator('[data-testid="sb-power"] .sb-gen')).toHaveCount(1);
    const genText = (await page.getByTestId("sb-power").textContent()) ?? "";
    expect(genText).toContain(" / ");
    expect(genText).toMatch(/ \/ .*MW/);
  } finally {
    if (genFactory) await edit(request, [{ type: "delete_factory", id: genFactory }]).catch(() => {});
  }
});
