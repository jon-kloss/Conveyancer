// #118 (playtest: 2 SAM nodes → Reanimated SAM): a MAKE whose raw demand
// exceeds ONE claimed node's ceiling but fits the POOL of same-item claims
// must (a) pass the capacity guard and (b) wire belts from BOTH input ports —
// the in-graph merge is the "merger". Regression: everything was wired to the
// first port, starving the chain at one node's rate while the second sat idle.

import { test, expect, type APIRequestContext } from "@playwright/test";
import { resetView } from "./helpers";

test.describe.configure({ mode: "serial" });

const API = "http://localhost:8791/api";
async function edit(request: APIRequestContext, cmds: unknown[]): Promise<{ created: string[] }> {
  const res = await request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
  if (!res.ok()) throw new Error(`edit ${res.status()}: ${await res.text()}`);
  return res.json();
}

test("MAKE pools two same-item claims and draws from both ports", async ({ page, request }) => {
  await resetView(request);
  // Two capped iron-ingot inputs (like two claimed nodes): 30/min each.
  // 45/min iron rod needs 45/min ingot — over one port, under the pool.
  const f = (await edit(request, [{ type: "create_factory", name: "MERGE TEST", position: { x: -2400, y: 2200 }, region: "GRASS FIELDS" }])).created[0];
  const portA = (await edit(request, [{ type: "add_port", factory: f, direction: "in", item: "Desc_IronIngot_C", rate: 0, rateCeiling: 30, graphPos: { x: 0, y: 100 } }])).created[0];
  const portB = (await edit(request, [{ type: "add_port", factory: f, direction: "in", item: "Desc_IronIngot_C", rate: 0, rateCeiling: 30, graphPos: { x: 0, y: 220 } }])).created[0];

  try {
    await page.goto("/");
    const skip = page.getByTestId("onboard-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();

    await page.locator(".searchbox input").fill("MERGE TEST");
    await page.keyboard.press("Enter");
    await page.getByTestId("btn-open-factory").click();
    await page.getByTestId("btn-make-from-resources").click();
    const modal = page.getByTestId("make-from-resources");
    await expect(modal).toBeVisible();

    // 45/min rod: the pooled guard must NOT block (45 ≤ 30+30).
    await modal.getByTestId("mfr-item-Desc_IronRod_C").click();
    await modal.getByTestId("mfr-rate").fill("45");
    await expect(modal.getByTestId("mfr-warn")).toHaveCount(0);
    await modal.getByTestId("mfr-build").click();
    await expect(modal).toBeHidden();

    // the chain actually runs at the target — the output port carries 45/min
    // (single-port wiring would cap the whole chain at 30/min)
    const outPort = page.getByTestId("port-out-Desc_IronRod_C");
    await expect(outPort).toContainText("45");

    // and BOTH input ports contribute: each has at least one outgoing belt
    const hydrated = await (await page.request.get(`${API}/hydrate`)).json();
    const edges = Object.values(hydrated.plan.edges) as { from: { kind: string; id: string } }[];
    const fromA = edges.filter((e) => e.from.kind === "port" && e.from.id === portA).length;
    const fromB = edges.filter((e) => e.from.kind === "port" && e.from.id === portB).length;
    expect(fromA).toBeGreaterThan(0);
    expect(fromB).toBeGreaterThan(0);
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});
