// Factory-graph right-click context menu: (1) right-click a machine → send a
// product out of the factory (creates the OUT port); (2) box-select machines →
// right-click → bulk delete.

import { test, expect, type APIRequestContext } from "@playwright/test";
import { resetView } from "./helpers";

test.describe.configure({ mode: "serial" });

const API = "http://localhost:8791/api";
async function edit(request: APIRequestContext, cmds: unknown[]): Promise<{ created: string[] }> {
  const res = await request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
  if (!res.ok()) throw new Error(`edit ${res.status()}: ${await res.text()}`);
  return res.json();
}
async function hydrate(request: APIRequestContext): Promise<any> {
  const res = await request.get(`${API}/hydrate`);
  return res.json();
}
async function openGraph(page: any, name: string) {
  await page.locator(".searchbox input").fill(name);
  await page.keyboard.press("Enter");
  await page.getByTestId("btn-open-factory").click();
  await expect(page.locator(".react-flow__pane")).toBeVisible();
  await page.waitForTimeout(300);
}

test("right-click a machine sends its product out of the factory", async ({ page, request }) => {
  await resetView(request);
  const f = (await edit(request, [{ type: "create_factory", name: "CTX SEND", position: { x: -2000, y: 2000 }, region: "GRASS FIELDS" }])).created[0];
  const ingot = (await edit(request, [{ type: "add_port", factory: f, direction: "in", item: "Desc_IronIngot_C", rate: 0, rateCeiling: 200, graphPos: { x: 0, y: 100 } }])).created[0];
  const rod = (await edit(request, [{ type: "add_group", factory: f, machine: "Build_ConstructorMk1_C", recipe: "Recipe_IronRod_C", count: 1, clock: 1, graphPos: { x: 320, y: 100 }, floor: 0 }])).created[0];
  await edit(request, [{ type: "add_edge", factory: f, from: { kind: "port", id: ingot }, to: { kind: "group", id: rod }, item: "Desc_IronIngot_C", tier: 3 }]);

  try {
    await page.goto("/");
    const skip = page.getByTestId("onboard-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await openGraph(page, "CTX SEND");

    await page.locator(`.react-flow__node[data-id="${rod}"]`).click({ button: "right" });
    const menu = page.getByTestId("graph-ctx-menu");
    await expect(menu).toBeVisible();
    await menu.getByTestId("ctx-send-Desc_IronRod_C").click();

    await expect(page.getByTestId("port-out-Desc_IronRod_C")).toBeVisible();
    const h = await hydrate(request);
    const outs = Object.values<any>(h.plan.ports).filter((p) => p.factory === f && p.direction === "out" && p.item === "Desc_IronRod_C");
    expect(outs).toHaveLength(1);
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});

test("box-select machines then bulk-delete from the context menu", async ({ page, request }) => {
  await resetView(request);
  const f = (await edit(request, [{ type: "create_factory", name: "CTX BULK", position: { x: -1500, y: 1500 }, region: "GRASS FIELDS" }])).created[0];
  const a = (await edit(request, [{ type: "add_group", factory: f, machine: "Build_ConstructorMk1_C", recipe: "Recipe_IronRod_C", count: 1, clock: 1, graphPos: { x: 200, y: 120 }, floor: 0 }])).created[0];
  const b = (await edit(request, [{ type: "add_group", factory: f, machine: "Build_ConstructorMk1_C", recipe: "Recipe_Screw_C", count: 1, clock: 1, graphPos: { x: 560, y: 120 }, floor: 0 }])).created[0];

  try {
    await page.goto("/");
    const skip = page.getByTestId("onboard-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await openGraph(page, "CTX BULK");

    // Box-select: drag a rectangle that encloses both cards, starting on empty
    // pane just above-left of them (so the mousedown doesn't grab a node).
    const canvas = (await page.locator(".graph-canvas").boundingBox())!;
    const ba = (await page.locator(`.react-flow__node[data-id="${a}"]`).boundingBox())!;
    const bb = (await page.locator(`.react-flow__node[data-id="${b}"]`).boundingBox())!;
    const left = Math.min(ba.x, bb.x), top = Math.min(ba.y, bb.y);
    const right = Math.max(ba.x + ba.width, bb.x + bb.width), bottom = Math.max(ba.y + ba.height, bb.y + bb.height);
    const sx = Math.max(canvas.x + 4, left - 40), sy = Math.max(canvas.y + 4, top - 40);
    const ex = Math.min(canvas.x + canvas.width - 4, right + 40), ey = Math.min(canvas.y + canvas.height - 4, bottom + 40);
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 6 });
    await page.mouse.move(ex, ey, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);

    // Right-click the box-selection → bulk menu → delete both. React Flow lays a
    // selection overlay over the picked nodes; right-clicking it fires the
    // selection context menu with the whole set.
    await page.locator(".react-flow__nodesselection-rect").click({ button: "right" });
    const menu = page.getByTestId("graph-ctx-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("ctx-delete")).toContainText(/2 items/i);
    await menu.getByTestId("ctx-delete").click();

    const h = await hydrate(request);
    const groups = Object.values<any>(h.plan.groups).filter((g) => g.factory === f);
    expect(groups).toHaveLength(0);
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});
