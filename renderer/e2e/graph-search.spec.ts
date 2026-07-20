// #117 context-aware header search, factory side: typing in the centered
// titlebar search dims non-matching machines and keeps matches lit; clearing
// (or leaving the graph) restores everything. The map side of the same slot is
// covered by the existing search/node-filter specs.

import { test, expect, type APIRequestContext } from "@playwright/test";
import { resetView } from "./helpers";

test.describe.configure({ mode: "serial" });

const API = "http://localhost:8791/api";
async function edit(request: APIRequestContext, cmds: unknown[]): Promise<{ created: string[] }> {
  const res = await request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
  if (!res.ok()) throw new Error(`edit ${res.status()}: ${await res.text()}`);
  return res.json();
}

test("graph search dims non-matching machines, clears on empty", async ({ page, request }) => {
  await resetView(request);
  const f = (await edit(request, [{ type: "create_factory", name: "SEARCH WORKS", position: { x: -1800, y: 1800 }, region: "GRASS FIELDS" }])).created[0];
  const rod = (await edit(request, [{ type: "add_group", factory: f, machine: "Build_ConstructorMk1_C", recipe: "Recipe_IronRod_C", count: 1, clock: 1, graphPos: { x: 200, y: 120 }, floor: 0 }])).created[0];
  const screw = (await edit(request, [{ type: "add_group", factory: f, machine: "Build_ConstructorMk1_C", recipe: "Recipe_Screw_C", count: 1, clock: 1, graphPos: { x: 560, y: 120 }, floor: 0 }])).created[0];
  // A belt between the two groups — #132 pins that filter dimming follows it —
  // plus a port-fed belt to pin the carve-out: port/junction endpoints never
  // filter-dim an edge, so a boundary belt stays lit whatever the filter says.
  const beltGG = (await edit(request, [{ type: "add_edge", factory: f, from: { kind: "group", id: rod }, to: { kind: "group", id: screw }, item: "Desc_IronRod_C", tier: 3 }])).created[0];
  const ingot = (await edit(request, [{ type: "add_port", factory: f, direction: "in", item: "Desc_IronIngot_C", rate: 0, rateCeiling: 200, graphPos: { x: 0, y: 120 } }])).created[0];
  const beltPG = (await edit(request, [{ type: "add_edge", factory: f, from: { kind: "port", id: ingot }, to: { kind: "group", id: rod }, item: "Desc_IronIngot_C", tier: 3 }])).created[0];

  try {
    await page.goto("/");
    const skip = page.getByTestId("onboard-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();

    // Map mode: the RESUME chip advertises its H hotkey (planned groups above
    // guarantee a non-empty build queue)...
    await expect(page.getByTestId("sb-resume")).toHaveAttribute(
      "title",
      "Resume — build queue (H)",
    );

    // Map mode: the centered slot carries the map search (item/factory/node).
    await expect(page.locator(".titlebar .searchbox input")).toBeVisible();
    await page.locator(".searchbox input").fill("SEARCH WORKS");
    await page.keyboard.press("Enter");
    await page.getByTestId("btn-open-factory").click();
    await expect(page.locator(".react-flow__pane")).toBeVisible();

    // Factory mode: inside the graph H is the Pan-tool hotkey, so the RESUME
    // chip stops advertising it (#132 — a dead shortcut hint).
    await expect(page.getByTestId("sb-resume")).toHaveAttribute("title", "Resume — build queue");

    // Factory mode: the same slot now carries the graph machine/item filter,
    // and the titlebar DATA menu is still there (it used to vanish here).
    await expect(page.getByTestId("btn-data-menu")).toBeVisible();
    const gsearch = page.getByTestId("graph-search").locator("input");
    await expect(gsearch).toBeVisible();
    await gsearch.fill("screw");
    const rodNode = page.locator(`.react-flow__node[data-id="${rod}"]`);
    const screwNode = page.locator(`.react-flow__node[data-id="${screw}"]`);
    const pathGG = page.locator(`.react-flow__edge[data-id="${beltGG}"] .react-flow__edge-path`);
    const pathPG = page.locator(`.react-flow__edge[data-id="${beltPG}"] .react-flow__edge-path`);
    // non-matching rod dims; matching screw stays lit
    await expect(rodNode).toHaveCSS("opacity", "0.15");
    await expect(screwNode).toHaveCSS("opacity", "1");
    // the group→group belt keeps ONE lit endpoint (screw) → stays lit (#132)
    await expect(pathGG).toHaveCSS("opacity", "1");
    await expect(page.locator(".belt-label.dimmed")).toHaveCount(0);

    // items match too — including INGREDIENTS ("iron ingot" is consumed only
    // by the rod line; the screw line consumes rods, not ingots)
    await gsearch.fill("iron ingot");
    await expect(rodNode).toHaveCSS("opacity", "1");
    await expect(screwNode).toHaveCSS("opacity", "0.15");

    // a filter matching NEITHER group dims the group→group belt with them
    // (#132 — belts used to stay full-brightness over a dimmed graph), while
    // the port-fed belt is exempt: port endpoints never filter-dim an edge.
    await gsearch.fill("coal");
    await expect(rodNode).toHaveCSS("opacity", "0.15");
    await expect(screwNode).toHaveCSS("opacity", "0.15");
    await expect(pathGG).toHaveCSS("opacity", "0.15");
    await expect(pathPG).toHaveCSS("opacity", "1");
    await expect(page.locator(".belt-label.dimmed")).toHaveCount(1);

    // Escape clears the filter and restores everything
    await gsearch.press("Escape");
    await expect(rodNode).toHaveCSS("opacity", "1");
    await expect(screwNode).toHaveCSS("opacity", "1");
    // ...and the graph did NOT eject to the map (Escape was consumed)
    await expect(page.locator(".react-flow__pane")).toBeVisible();
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});
