// AUDIT area: graph — factory-graph view (send-out port sizing, cross-floor
// lift rendering, floor filtering, STACK FLOORS idempotence, trace-on-select
// dimming). Every probe declares its EXPECTED (correct) result in the header
// BEFORE any assertion; a failing probe is data for the mismatch protocol, not
// a reason to weaken the assert. Seeded through the same command surface the UI
// uses, against the dev bridge's default fixture catalog (Recipe_IronRod_C =
// 1 ingot -> 1 rod @ 4s = 15/min nameplate at clock 1).

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
  const res = await request.get(`${API}/hydrate`);
  if (!res.ok()) throw new Error(`hydrate ${res.status()}: ${await res.text()}`);
  return res.json();
}
// Open the factory graph from the map. API seeds do not stream to an open
// client, so this always runs AFTER page.goto once the plan is fully seeded.
async function openGraph(page: any, name: string): Promise<void> {
  await page.locator(".searchbox input").fill(name);
  await page.keyboard.press("Enter");
  await page.getByTestId("btn-open-factory").click();
  await expect(page.locator(".react-flow__pane")).toBeVisible();
  await page.waitForTimeout(300);
}
const P = (id: string) => ({ kind: "port", id });
const G = (id: string) => ({ kind: "group", id });

// ---------------------------------------------------------------------------
// PROBE 1 — Send-out of an underclocked machine sizes the OUT port to real
// capacity, not nameplate.
//
// EXPECTED: exactly one OUT port for Desc_IronRod_C, and its rate == 7.5
// (nameplate 15/min x 0.5 clock). CURRENT BUILD produces rate == 15 (the
// Math.max(effClock,1) floor in GraphContextMenu.surplus), which is the bug.
// ---------------------------------------------------------------------------
test("send-out sizes the OUT port to the underclocked capacity, not nameplate", async ({ page, request }) => {
  await resetView(request);
  const f = (await edit(request, [{ type: "create_factory", name: "SURPLUS CLOCK", position: { x: -1000, y: 1000 }, region: "GRASS FIELDS" }])).created[0];
  const ingot = (await edit(request, [{ type: "add_port", factory: f, direction: "in", item: "Desc_IronIngot_C", rate: 0, rateCeiling: 200, graphPos: { x: 0, y: 100 } }])).created[0];
  const rod = (await edit(request, [{ type: "add_group", factory: f, machine: "Build_ConstructorMk1_C", recipe: "Recipe_IronRod_C", count: 1, clock: 0.5, graphPos: { x: 320, y: 100 }, floor: 0 }])).created[0];
  await edit(request, [{ type: "add_edge", factory: f, from: P(ingot), to: G(rod), item: "Desc_IronIngot_C", tier: 3 }]);

  try {
    await page.goto("/");
    const skip = page.getByTestId("onboard-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await openGraph(page, "SURPLUS CLOCK");

    await page.locator(`.react-flow__node[data-id="${rod}"]`).click({ button: "right" });
    await expect(page.getByTestId("graph-ctx-menu")).toBeVisible();
    await page.getByTestId("ctx-send-Desc_IronRod_C").click();
    await expect(page.getByTestId("port-out-Desc_IronRod_C")).toBeVisible();

    const h = await hydrate(request);
    const outs = Object.values<any>(h.plan.ports).filter(
      (p) => p.factory === f && p.direction === "out" && p.item === "Desc_IronRod_C",
    );
    // exactly one OUT port, sized to the REAL clocked capacity (7.5), not the
    // nameplate 15 the effClock>=1 floor produces.
    expect(outs).toHaveLength(1);
    expect(outs[0].rate).toBeCloseTo(7.5, 3);
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 2 — A group->boundary-port belt from a raised floor is NOT drawn as a
// lift (all-floors view is default).
//
// EXPECTED: the belt-label for the g->outp edge shows a plain 'n/cap · % MK.3'
// chip with NO '⇅' glyph and NO 'F2→F0' lift tag, and there are 0 lift-pad
// diamonds on it (a port is a floor-agnostic boundary, so this is not a
// cross-floor lift). CURRENT BUILD renders '⇅ F2→F0 · …' with two lift pads
// (floorOfEnd() hard-codes a port's floor to 0, so a floor-2 group -> port
// edge reads srcFloor 2 != dstFloor 0 => lift).
// ---------------------------------------------------------------------------
test("group->port belt from a raised floor is not drawn as a lift", async ({ page, request }) => {
  await resetView(request);
  const f = (await edit(request, [{ type: "create_factory", name: "PORT LIFT", position: { x: -1000, y: 1200 }, region: "GRASS FIELDS" }])).created[0];
  const ingot = (await edit(request, [{ type: "add_port", factory: f, direction: "in", item: "Desc_IronIngot_C", rate: 0, rateCeiling: 200, graphPos: { x: 0, y: 100 } }])).created[0];
  const g = (await edit(request, [{ type: "add_group", factory: f, machine: "Build_ConstructorMk1_C", recipe: "Recipe_IronRod_C", count: 1, clock: 1, graphPos: { x: 320, y: 100 }, floor: 0 }])).created[0];
  const outp = (await edit(request, [{ type: "add_port", factory: f, direction: "out", item: "Desc_IronRod_C", rate: 0, rateCeiling: null, graphPos: { x: 680, y: 100 } }])).created[0];
  await edit(request, [{ type: "add_edge", factory: f, from: P(ingot), to: G(g), item: "Desc_IronIngot_C", tier: 3 }]);
  const E = (await edit(request, [{ type: "add_edge", factory: f, from: G(g), to: P(outp), item: "Desc_IronRod_C", tier: 3 }])).created[0];
  await edit(request, [{ type: "set_group_floor", id: g, floor: 2 }]);

  try {
    await page.goto("/");
    const skip = page.getByTestId("onboard-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await openGraph(page, "PORT LIFT");

    // The belt-label chip exists (whole belt drawn, not a portal stub).
    const label = page.getByTestId(`belt-label-${E}`);
    await expect(label).toBeVisible();
    // A port is a floor-agnostic boundary: no lift glyph, no cross-floor tag.
    await expect(label).not.toContainText("⇅");
    await expect(label).not.toContainText("F2→F0");
    // ...and no lift-pad diamonds are drawn on this edge.
    await expect(page.locator(`.react-flow__edge[data-id="${E}"] .lift-pad`)).toHaveCount(0);
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 3 — Filtering to the source floor keeps a group->port belt whole (no
// phantom lift portal). Same fixture as probe 2 (group g on floor 2, out-port
// outp, edge E), but with the F2 floor chip active.
//
// EXPECTED: 0 lift-portal elements for edge E; node g (floor 2) is visible and
// its OUT port outp is visible with the belt drawn between them (the belt-label
// chip present). CURRENT BUILD shows exactly one lift-portal-<E> stub near g
// pointing to 'F0' while the port outp still renders detached — clicking that
// portal jumps to floor 0 where g is hidden.
// ---------------------------------------------------------------------------
test("filtering to the source floor keeps a group->port belt whole", async ({ page, request }) => {
  await resetView(request);
  const f = (await edit(request, [{ type: "create_factory", name: "PORT LIFT F2", position: { x: -1000, y: 1400 }, region: "GRASS FIELDS" }])).created[0];
  const ingot = (await edit(request, [{ type: "add_port", factory: f, direction: "in", item: "Desc_IronIngot_C", rate: 0, rateCeiling: 200, graphPos: { x: 0, y: 100 } }])).created[0];
  const g = (await edit(request, [{ type: "add_group", factory: f, machine: "Build_ConstructorMk1_C", recipe: "Recipe_IronRod_C", count: 1, clock: 1, graphPos: { x: 320, y: 100 }, floor: 0 }])).created[0];
  const outp = (await edit(request, [{ type: "add_port", factory: f, direction: "out", item: "Desc_IronRod_C", rate: 0, rateCeiling: null, graphPos: { x: 680, y: 100 } }])).created[0];
  await edit(request, [{ type: "add_edge", factory: f, from: P(ingot), to: G(g), item: "Desc_IronIngot_C", tier: 3 }]);
  const E = (await edit(request, [{ type: "add_edge", factory: f, from: G(g), to: P(outp), item: "Desc_IronRod_C", tier: 3 }])).created[0];
  await edit(request, [{ type: "set_group_floor", id: g, floor: 2 }]);

  try {
    await page.goto("/");
    const skip = page.getByTestId("onboard-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await openGraph(page, "PORT LIFT F2");

    // Filter to the source floor (F2). floors = [0, 2] → chips ALL, F0, F2.
    await page.getByTestId("floor-chips").getByRole("button", { name: "F2", exact: true }).click();
    await page.waitForTimeout(200);

    // No phantom lift portal for a group->port belt: the port is on-floor
    // regardless of the filter, so the belt stays whole.
    await expect(page.getByTestId(`lift-portal-${E}`)).toHaveCount(0);
    // The floor-2 group and its OUT port both render, with the belt between them.
    await expect(page.locator(`.react-flow__node[data-id="${g}"]`)).toBeVisible();
    await expect(page.locator(`.react-flow__node[data-id="${outp}"]`)).toBeVisible();
    await expect(page.getByTestId(`belt-label-${E}`)).toBeVisible();
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 4 — STACK FLOORS is idempotent: running it twice leaves positions
// unchanged.
//
// EXPECTED: after a first STACK converges the layout, the second STACK emits an
// empty command batch and moves nothing — plan.groups[g0].graphPos and
// plan.groups[g1].graphPos are IDENTICAL between the two runs (A2 == A1 and
// B2 == B1 exactly). Any position delta on the second click indicates
// non-deterministic band-stacking.
// ---------------------------------------------------------------------------
test("STACK FLOORS is idempotent — a second run moves nothing", async ({ page, request }) => {
  await resetView(request);
  const f = (await edit(request, [{ type: "create_factory", name: "STACK IDEM", position: { x: -1000, y: 1600 }, region: "GRASS FIELDS" }])).created[0];
  const g0 = (await edit(request, [{ type: "add_group", factory: f, machine: "Build_ConstructorMk1_C", recipe: "Recipe_IronRod_C", count: 1, clock: 1, graphPos: { x: 200, y: 120 }, floor: 0 }])).created[0];
  const g1 = (await edit(request, [{ type: "add_group", factory: f, machine: "Build_ConstructorMk1_C", recipe: "Recipe_Screw_C", count: 1, clock: 1, graphPos: { x: 560, y: 300 }, floor: 1 }])).created[0];

  try {
    await page.goto("/");
    const skip = page.getByTestId("onboard-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await openGraph(page, "STACK IDEM");

    // First STACK: converge the two floors into bands.
    await page.getByTestId("btn-stack-floors").click();
    await page.waitForTimeout(700);
    let h = await hydrate(request);
    const A1 = h.plan.groups[g0].graphPos;
    const B1 = h.plan.groups[g1].graphPos;

    // Second STACK: an already-converged layout must produce NO moves.
    await page.getByTestId("btn-stack-floors").click();
    await page.waitForTimeout(700);
    h = await hydrate(request);
    const A2 = h.plan.groups[g0].graphPos;
    const B2 = h.plan.groups[g1].graphPos;

    expect(A2).toEqual(A1);
    expect(B2).toEqual(B1);
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 5 — Trace-on-select dims off-chain nodes to 0.3 and leaves an
// unconnected card at 0.3 too; selecting an isolated card dims nothing.
//
// EXPECTED: selecting A (on the p->A->B chain) leaves A, B and p at opacity 1
// (all in the belt-connected trace set → no dim) and dims the isolated card C
// to 0.3 (off-chain traceDim). Selecting the isolated card C instead leaves
// every node at opacity 1 because a single-node trace set does not dim
// (seen.size <= 1 → traceSet null).
// ---------------------------------------------------------------------------
test("trace-on-select dims only off-chain nodes; an isolated selection dims nothing", async ({ page, request }) => {
  await resetView(request);
  const f = (await edit(request, [{ type: "create_factory", name: "TRACE DIM", position: { x: -1000, y: 1800 }, region: "GRASS FIELDS" }])).created[0];
  const p = (await edit(request, [{ type: "add_port", factory: f, direction: "in", item: "Desc_IronIngot_C", rate: 0, rateCeiling: 200, graphPos: { x: 0, y: 100 } }])).created[0];
  const A = (await edit(request, [{ type: "add_group", factory: f, machine: "Build_ConstructorMk1_C", recipe: "Recipe_IronRod_C", count: 1, clock: 1, graphPos: { x: 300, y: 100 }, floor: 0 }])).created[0];
  const B = (await edit(request, [{ type: "add_group", factory: f, machine: "Build_ConstructorMk1_C", recipe: "Recipe_Screw_C", count: 1, clock: 1, graphPos: { x: 640, y: 100 }, floor: 0 }])).created[0];
  await edit(request, [{ type: "add_edge", factory: f, from: P(p), to: G(A), item: "Desc_IronIngot_C", tier: 3 }]);
  await edit(request, [{ type: "add_edge", factory: f, from: G(A), to: G(B), item: "Desc_IronRod_C", tier: 3 }]);
  const C = (await edit(request, [{ type: "add_group", factory: f, machine: "Build_ConstructorMk1_C", recipe: "Recipe_IronPlate_C", count: 1, clock: 1, graphPos: { x: 300, y: 360 }, floor: 0 }])).created[0];

  const opacityOf = (id: string) =>
    page.locator(`.react-flow__node[data-id="${id}"]`).evaluate((el: HTMLElement) => getComputedStyle(el).opacity);

  try {
    await page.goto("/");
    const skip = page.getByTestId("onboard-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await openGraph(page, "TRACE DIM");

    // ---- select A: its whole p->A->B chain stays lit, isolated C dims ----
    await page.locator(`.react-flow__node[data-id="${A}"]`).click();
    await expect(page.locator(`.react-flow__node[data-id="${A}"].selected`)).toHaveCount(1);
    expect(await opacityOf(A)).toBe("1");
    expect(await opacityOf(B)).toBe("1");
    expect(await opacityOf(p)).toBe("1");
    // C is off the traced chain → dimmed to 0.3.
    expect(await opacityOf(C)).toBe("0.3");

    // ---- select the isolated card C: a single-node trace set dims nothing ----
    await page.locator(`.react-flow__node[data-id="${C}"]`).click();
    await expect(page.locator(`.react-flow__node[data-id="${C}"].selected`)).toHaveCount(1);
    expect(await opacityOf(A)).toBe("1");
    expect(await opacityOf(B)).toBe("1");
    expect(await opacityOf(C)).toBe("1");
    expect(await opacityOf(p)).toBe("1");
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});
