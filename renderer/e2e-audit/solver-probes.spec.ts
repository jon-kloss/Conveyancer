// AUDIT area: solver — T0/T1 pull-weight edge cases, output-target hard-stop
// exactness + ceiling naming, and driven-generator slack. Every probe declares
// its EXPECTED (correct) result in the header BEFORE any assertion; a failing
// probe is DATA for the mismatch protocol, NOT a reason to weaken the assert.
// Seeded through the same command surface the UI uses, against the dev bridge's
// default fixture catalog:
//   Recipe_IronRod_C = 1 iron ingot -> 1 iron rod  (1:1)
//   Recipe_Power_Build_GeneratorCoal_* burns coal -> __PowerMW (75 MW/gen)
//
// NOTE ON SELECTORS: the OUTPUT TARGET range input carries data-testid
// "target-slider" (the descriptor's "insp-slider" is only its CSS class);
// probe 1 drives the real testid. DerivedFactory does not serialize a raw
// `clamped` bool — the clamp is surfaced as `targetCeiling` being present, so
// probe 2 asserts targetCeiling presence as the clamped signal (see header).

import { test, expect, type APIRequestContext } from "@playwright/test";
import { resetView } from "../e2e/helpers";

test.describe.configure({ mode: "serial" });

const API = "http://localhost:8791/api";

async function edit(request: APIRequestContext, cmds: unknown[]): Promise<{ created: string[] }> {
  const res = await request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
  if (!res.ok()) throw new Error(`edit ${res.status()}: ${await res.text()}`);
  return res.json();
}
// Full edit response (patches + DERIVED + created) — probe 2 reads the derived
// off the edit response itself, since a plain /api/hydrate solves Recompute and
// carries no target_ceiling.
async function editFull(request: APIRequestContext, cmds: unknown[]): Promise<any> {
  const res = await request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
  if (!res.ok()) throw new Error(`edit ${res.status()}: ${await res.text()}`);
  return res.json();
}
async function hydrate(request: APIRequestContext): Promise<any> {
  const res = await request.get(`${API}/hydrate`);
  if (!res.ok()) throw new Error(`hydrate ${res.status()}: ${await res.text()}`);
  return res.json();
}

const P = (id: string) => ({ kind: "port", id });
const G = (id: string) => ({ kind: "group", id });

const outPortsOf = (h: any, f: string, item: string): any[] =>
  Object.values<any>(h.plan.ports).filter((p) => p.factory === f && p.direction === "out" && p.item === item);

// API seeds do not stream to an already-open client, so open the graph AFTER
// the plan is fully seeded (goto reloads and re-syncs the store).
async function openGraph(page: any, name: string): Promise<void> {
  await page.goto("/");
  const skip = page.getByTestId("onboard-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.locator(".searchbox input").fill(name);
  await page.keyboard.press("Enter");
  await page.getByTestId("btn-open-factory").click();
}

// ---------------------------------------------------------------------------
// PROBE 1 — T0 drag preview of an INDEPENDENT output port is unaffected by an
// infeasible sibling target.
//
// Setup: factory DUAL with two independent chains sharing no material.
//   chain A: in-a (Desc_IronIngot_C, ceiling OPEN/null) -> constructor A
//            (Recipe_IronRod_C) -> out-x (Desc_IronRod_C, rate 15)
//   chain B: in-b (Desc_IronIngot_C, ceiling 10) -> constructor B
//            (Recipe_IronRod_C) -> out-y (Desc_IronRod_C, rate 30)  [INFEASIBLE:
//            30 rod needs 30 ingot > 10 ceiling]
// out-x is added BEFORE out-y so it is the factory's first OUT port (the one the
// OUTPUT TARGET section targets). Open the graph, click out-x to mount OUTPUT
// TARGET, then set the range input to 20 by dispatching an 'input' event (the
// onDrag path) WITHOUT firing pointerUp — so the T0 projection stays set.
//
// EXPECTED (correct behavior): target-value shows ~20/min (out-x's own dragged
// rate) and out-x's constructor node (constructor A) shows ~20/min — NOT 0. The
// two chains are independent, so out-y's infeasibility against in-b's ceiling
// must not touch out-x's projected preview.
//
// KNOWN MISMATCH (documented, do NOT weaken): current T0 clamps out-x to 0
// because sibling out-y violates in-b's ceiling, so target-value and out-x's
// whole chain read 0/min mid-drag — this probe is EXPECTED to fail at the
// "~20, not 0" assertions, exposing the coupling bug.
// ---------------------------------------------------------------------------
test("T0 drag preview of an independent out port ignores an infeasible sibling", async ({ page, request }) => {
  await resetView(request);
  const f = (await edit(request, [{ type: "create_factory", name: "DUAL", position: { x: -2500, y: 2500 }, region: "GRASS FIELDS" }])).created[0];
  // in-a is OPEN (null ceiling) — out-x's chain has no input ceiling of its own.
  const inA = (await edit(request, [{ type: "add_port", factory: f, direction: "in", item: "Desc_IronIngot_C", rate: 0, rateCeiling: null, graphPos: { x: 0, y: 80 } }])).created[0];
  const inB = (await edit(request, [{ type: "add_port", factory: f, direction: "in", item: "Desc_IronIngot_C", rate: 0, rateCeiling: 10, graphPos: { x: 0, y: 260 } }])).created[0];
  const consA = (await edit(request, [{ type: "add_group", factory: f, machine: "Build_ConstructorMk1_C", recipe: "Recipe_IronRod_C", count: 1, clock: 1.0, graphPos: { x: 320, y: 80 }, floor: 0 }])).created[0];
  const consB = (await edit(request, [{ type: "add_group", factory: f, machine: "Build_ConstructorMk1_C", recipe: "Recipe_IronRod_C", count: 1, clock: 1.0, graphPos: { x: 320, y: 260 }, floor: 0 }])).created[0];
  // out-x FIRST → it is the factory's first OUT port (the OUTPUT TARGET target).
  // Its rate is 15 so sliderMax = max(10, 15*2) = 30, leaving headroom to reach 20.
  const outX = (await edit(request, [{ type: "add_port", factory: f, direction: "out", item: "Desc_IronRod_C", rate: 15, rateCeiling: null, graphPos: { x: 640, y: 80 } }])).created[0];
  const outY = (await edit(request, [{ type: "add_port", factory: f, direction: "out", item: "Desc_IronRod_C", rate: 0, rateCeiling: null, graphPos: { x: 640, y: 260 } }])).created[0];
  await edit(request, [{ type: "add_edge", factory: f, from: P(inA), to: G(consA), item: "Desc_IronIngot_C", tier: 3 }]);
  await edit(request, [{ type: "add_edge", factory: f, from: G(consA), to: P(outX), item: "Desc_IronRod_C", tier: 3 }]);
  await edit(request, [{ type: "add_edge", factory: f, from: P(inB), to: G(consB), item: "Desc_IronIngot_C", tier: 3 }]);
  await edit(request, [{ type: "add_edge", factory: f, from: G(consB), to: P(outY), item: "Desc_IronRod_C", tier: 3 }]);
  // out-y target 30/min is infeasible: needs 30 ingot but in-b ceils at 10.
  await edit(request, [{ type: "set_port_rate", id: outY, rate: 30 }]);

  try {
    await openGraph(page, "DUAL");
    // Select out-x → OUTPUT TARGET mounts (out-x is the factory's first OUT port).
    await page.locator(`.react-flow__node[data-id="${outX}"]`).click();
    const slider = page.getByTestId("target-slider");
    await expect(slider).toBeVisible();
    await expect(page.getByText(/OUTPUT TARGET/)).toBeVisible();

    // Drive the slider to 20 via a native 'input' event (onDrag path). No
    // pointerUp fires, so dragValue + the T0 projection stay set (projected).
    await slider.evaluate((el: HTMLInputElement, v: number) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, String(v));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, 20);

    // Drag registered: the target value renders as a projection mid-drag.
    await expect(page.getByTestId("target-value")).toHaveClass(/projected/);

    // The projected preview must track out-x's OWN dragged rate (~20), not
    // collapse to 0 on the sibling's infeasibility. (WASM T0 lands on a later
    // frame than the input event, hence the poll.)
    await expect
      .poll(async () => parseFloat(await page.getByTestId("target-value").innerText()), { timeout: 5000 })
      .toBeCloseTo(20, 0);

    // ...and out-x's constructor node (constructor A) carries the projected
    // ~20/min rod, not 0 — the whole independent chain previews live.
    const consARate = parseFloat(
      await page.locator(`.react-flow__node[data-id="${consA}"] .group-card-recipe .t-data-12`).innerText(),
    );
    expect(consARate).toBeCloseTo(20, 0);
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 2 — Output-target hard-stop clamps at the TRUE input ceiling and names
// it (app derive level, off the edit response).
//
// Setup: factory CEIL, one IN port (Desc_IronIngot_C, ceiling 30). MAKE FROM
// RESOURCES builds 15/min Desc_IronRod_C (1 ingot : 1 rod). Then POST /api/edit
// [set_port_rate outRod = 60] and read the derived FROM THE EDIT RESPONSE (a
// later /api/hydrate solves Recompute and carries no target_ceiling).
//
// EXPECTED (correct behavior):
//   editResponse.derived.factories[f].targetCeiling.maxRate == 30
//       (30 ingot -> 30 rod at 1:1)
//   targetCeiling.binding.kind == "input_ceiling" naming the ingot INPUT port
//       (binding.port == the ingot port id, binding.ceiling == 30)
//   ports[outRod] == 30 (the achieved, clamped rate)
//   the clamp is surfaced (targetCeiling present) — DerivedFactory carries no
//       raw `clamped` bool; its presence IS the clamped==true signal
//   shortfalls empty (the clamp path reports via target_ceiling, not shortfall)
// ---------------------------------------------------------------------------
test("output-target hard-stop clamps at the input ceiling and names it", async ({ page, request }) => {
  await resetView(request);
  const f = (await edit(request, [{ type: "create_factory", name: "CEIL", position: { x: -2700, y: 2700 }, region: "GRASS FIELDS" }])).created[0];
  const ingot = (await edit(request, [{ type: "add_port", factory: f, direction: "in", item: "Desc_IronIngot_C", rate: 0, rateCeiling: 30, graphPos: { x: 0, y: 100 } }])).created[0];

  try {
    await openGraph(page, "CEIL");
    await page.getByTestId("btn-make-from-resources").click();
    const modal = page.getByTestId("make-from-resources");
    await expect(modal).toBeVisible();
    await modal.getByTestId("mfr-item-Desc_IronRod_C").click();
    await modal.getByTestId("mfr-rate").fill("15");
    await modal.getByTestId("mfr-build").click();
    await expect(modal).toBeHidden();

    // Capture the created out-rod port id (there is exactly one).
    const h = await hydrate(request);
    const outRods = outPortsOf(h, f, "Desc_IronRod_C");
    expect(outRods).toHaveLength(1);
    const outRod = outRods[0].id;

    // Request 60/min rod — over the 30/min ingot ceiling (1:1). Read the derived
    // OFF THE EDIT RESPONSE (the SetTarget solve carries the ceiling).
    const resp = await editFull(request, [{ type: "set_port_rate", id: outRod, rate: 60 }]);
    const df = resp.derived.factories[f];

    // Hard-stop at the true ceiling: 30 ingot -> 30 rod.
    expect(df.targetCeiling).toBeTruthy(); // clamp surfaced (clamped == true signal)
    expect(df.targetCeiling.maxRate).toBeCloseTo(30, 3);
    // ...named as the INGOT input ceiling on the actual ingot port.
    expect(df.targetCeiling.binding.kind).toBe("input_ceiling");
    expect(df.targetCeiling.binding.port).toBe(ingot);
    expect(df.targetCeiling.binding.item).toBe("Desc_IronIngot_C");
    expect(df.targetCeiling.binding.ceiling).toBeCloseTo(30, 3);
    // achieved (clamped) rate on the out port is 30, and nothing degrades into
    // the shortfall channel — the clamp path owns the report.
    expect(df.ports[outRod]).toBeCloseTo(30, 3);
    expect(Object.keys(df.shortfalls)).toHaveLength(0);
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 3 — An un-wired DRIVEN generator's derived generation equals its
// fuel-limited nameplate and is NEVER a shortfall (holds on a plain Recompute).
//
// Setup: reuse the MAKE POWER flow — factory COALGEN with two capped
// Desc_Coal_C claims (30/min each = 60 pooled). Open MAKE FROM RESOURCES, read
// the default MW off mfr-power-mw-Desc_Coal_C, then mfr-power-build-Desc_Coal_C
// builds the coal generator bank (fed by both claims through a merger). After
// build, GET /api/hydrate (a Recompute solve) and locate the generator group
// (machine name contains "generator") in derived.factories[f].groups.
//
// EXPECTED (correct behavior):
//   derived.factories[f].groups[bankId].outRates["__PowerMW"] > 0 and equals
//       the modal's defaultMw within rounding — the pool of 60 coal exactly
//       feeds the bank, so it runs at nameplate.
//   derived.factories[f].shortfalls is empty — the generator's driven slack
//       (fuel-limited via driven_cycles) must not leak into shortfalls.
//   This holds on a plain hydrate/Recompute because driven_cycles applies
//       regardless of the solve trigger.
// ---------------------------------------------------------------------------
test("un-wired driven generator generates at fuel-limited nameplate, no shortfall", async ({ page, request }) => {
  await resetView(request);
  const f = (await edit(request, [{ type: "create_factory", name: "COALGEN", position: { x: -2900, y: 2900 }, region: "GRASS FIELDS" }])).created[0];
  await edit(request, [{ type: "add_port", factory: f, direction: "in", item: "Desc_Coal_C", rate: 0, rateCeiling: 30, graphPos: { x: 0, y: 100 } }]);
  await edit(request, [{ type: "add_port", factory: f, direction: "in", item: "Desc_Coal_C", rate: 0, rateCeiling: 30, graphPos: { x: 0, y: 220 } }]);

  try {
    await openGraph(page, "COALGEN");
    await page.getByTestId("btn-make-from-resources").click();
    const modal = page.getByTestId("make-from-resources");
    await expect(modal).toBeVisible();

    // The MAKE POWER section is offered; capture the pool-fed default MW.
    const mwInput = modal.getByTestId("mfr-power-mw-Desc_Coal_C");
    const defaultMw = Number(await mwInput.inputValue());
    expect(defaultMw).toBeGreaterThan(0);

    await modal.getByTestId("mfr-power-build-Desc_Coal_C").click();
    await expect(modal).toBeHidden();

    // Plain hydrate = Recompute solve. driven_cycles still drives the un-wired
    // generator bank toward its fuel-limited nameplate.
    const h = await hydrate(request);
    const bank = Object.entries<any>(h.plan.groups).find(
      ([, g]) => g.factory === f && String(g.machine).toLowerCase().includes("generator"),
    );
    expect(bank).toBeTruthy();
    const bankId = bank![0];

    const df = h.derived.factories[f];
    const genMw = df.groups[bankId]?.outRates?.["__PowerMW"] ?? 0;
    // Runs at nameplate: the pool of 60 coal exactly feeds the built bank.
    expect(genMw).toBeGreaterThan(0);
    expect(Math.abs(genMw - defaultMw)).toBeLessThan(Math.max(1, defaultMw * 0.02));
    // The generator's driven slack must not surface as an unmet target.
    expect(Object.keys(df.shortfalls)).toHaveLength(0);
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});
