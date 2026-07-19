// #119 (playtest: "3 coal nodes but no way to Make a coal generator"):
// MAKE FROM RESOURCES now has a MAKE POWER section — generator burns runnable
// from the factory's raws, sized against the pooled extraction headroom and
// wired through the same merger manifolds as item builds. A coal-only factory
// (which can make no item in the fixture catalog) still offers power.

import { test, expect, type APIRequestContext } from "@playwright/test";
import { resetView } from "./helpers";

test.describe.configure({ mode: "serial" });

const API = "http://localhost:8791/api";
async function edit(request: APIRequestContext, cmds: unknown[]): Promise<{ created: string[] }> {
  const res = await request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
  if (!res.ok()) throw new Error(`edit ${res.status()}: ${await res.text()}`);
  return res.json();
}

test("MAKE POWER builds a coal generator bank from pooled coal claims", async ({ page, request }) => {
  await resetView(request);
  // Two capped coal claims, 30/min each — one alone can't feed the default
  // (max-MW) bank, so the build must merge both.
  const f = (await edit(request, [{ type: "create_factory", name: "COAL POWER CO", position: { x: -2600, y: 2400 }, region: "GRASS FIELDS" }])).created[0];
  const portA = (await edit(request, [{ type: "add_port", factory: f, direction: "in", item: "Desc_Coal_C", rate: 0, rateCeiling: 30, graphPos: { x: 0, y: 100 } }])).created[0];
  const portB = (await edit(request, [{ type: "add_port", factory: f, direction: "in", item: "Desc_Coal_C", rate: 0, rateCeiling: 30, graphPos: { x: 0, y: 220 } }])).created[0];

  try {
    await page.goto("/");
    const skip = page.getByTestId("onboard-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();

    await page.locator(".searchbox input").fill("COAL POWER CO");
    await page.keyboard.press("Enter");
    await page.getByTestId("btn-open-factory").click();
    await page.getByTestId("btn-make-from-resources").click();
    const modal = page.getByTestId("make-from-resources");
    await expect(modal).toBeVisible();

    // the power section is offered, MW defaulted to what the pool can feed
    const powerRow = modal.getByTestId("mfr-power-Desc_Coal_C");
    await expect(powerRow).toBeVisible();
    const mwInput = modal.getByTestId("mfr-power-mw-Desc_Coal_C");
    const defaultMw = Number(await mwInput.inputValue());
    expect(defaultMw).toBeGreaterThan(0);

    await modal.getByTestId("mfr-power-build-Desc_Coal_C").click();
    await expect(modal).toBeHidden();

    // a generator bank exists, fed by BOTH claims through a merger
    const hydrated = await (await page.request.get(`${API}/hydrate`)).json();
    const groups = Object.values(hydrated.plan.groups) as { factory: string; machine: string }[];
    const bank = groups.find((g) => g.factory === f && g.machine.toLowerCase().includes("generator"));
    expect(bank).toBeTruthy();
    const junctions = Object.values(hydrated.plan.junctions) as { id: string; kind: string; factory: string }[];
    const merger = junctions.find((j) => j.factory === f && j.kind === "merger");
    expect(merger).toBeTruthy();
    const edges = Object.values(hydrated.plan.edges) as { from: { kind: string; id: string } }[];
    expect(edges.some((e) => e.from.kind === "port" && e.from.id === portA)).toBe(true);
    expect(edges.some((e) => e.from.kind === "port" && e.from.id === portB)).toBe(true);

    // The bank actually RUNS: coal genuinely flows down the merger→bank belt
    // at the pooled 60/min. (totalGenerationMw alone is vacuous here — it
    // deliberately falls back to nameplate for unsolved factories, so it goes
    // positive even for a mis-wired bank. Real belt flow can't be faked.)
    const mergerOutId = (Object.entries(hydrated.plan.edges) as [string, (typeof edges)[number]][]).find(
      ([, e]) => e.from.kind === "junction" && e.from.id === merger!.id,
    )![0];
    await expect
      .poll(async () => {
        const h = await (await page.request.get(`${API}/hydrate`)).json();
        return h.derived?.factories?.[f]?.edges?.[mergerOutId]?.flow ?? 0;
      })
      .toBeGreaterThan(59);
    // ...and the empire ledger sees the generation.
    const h = await (await page.request.get(`${API}/hydrate`)).json();
    expect(h.derived?.totalGenerationMw ?? 0).toBeGreaterThan(0);

    // ---- UNCAPPED port (rateCeiling null — a hand-added + IN PORT) ----
    // Display defaults to ONE generator's nameplate; an untouched BUILD must
    // build exactly that (regression: the build-side default was
    // MAX_SAFE_INTEGER MW ≈ 1.2e14 generators while the field showed "75").
    const f2 = (await edit(request, [{ type: "create_factory", name: "OPEN COAL", position: { x: -2900, y: 2700 }, region: "GRASS FIELDS" }])).created[0];
    await edit(request, [{ type: "add_port", factory: f2, direction: "in", item: "Desc_Coal_C", rate: 0, rateCeiling: null, graphPos: { x: 0, y: 100 } }]);
    try {
      // API edits mid-session don't stream to the client — reset the view
      // (else the persisted factory mode boots us into f1's graph) and reload
      await resetView(request);
      await page.goto("/");
      await expect(page.getByTestId("map-root")).toBeVisible();
      await page.locator(".searchbox input").fill("OPEN COAL");
      await page.keyboard.press("Enter");
      await page.getByTestId("btn-open-factory").click();
      await page.getByTestId("btn-make-from-resources").click();
      const modal2 = page.getByTestId("make-from-resources");
      const mwField = modal2.getByTestId("mfr-power-mw-Desc_Coal_C");
      const shown = Number(await mwField.inputValue());
      await modal2.getByTestId("mfr-power-build-Desc_Coal_C").click();
      await expect(modal2).toBeHidden();
      const h2 = await (await page.request.get(`${API}/hydrate`)).json();
      const bank2 = (Object.values(h2.plan.groups) as { factory: string; machine: string; count: number }[]).find(
        (g) => g.factory === f2 && g.machine.toLowerCase().includes("generator"),
      )!;
      expect(bank2).toBeTruthy();
      // built exactly what the field showed: nameplate MW → a single generator
      expect(bank2.count).toBe(Math.ceil(shown / 75));
      expect(bank2.count).toBeLessThan(10);
    } finally {
      await edit(request, [{ type: "delete_factory", id: f2 }]).catch(() => {});
    }
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});
