// #118 (playtest: 2 SAM nodes → Reanimated SAM): a MAKE whose raw demand
// exceeds ONE claimed node's ceiling but fits the POOL of same-item claims
// must (a) pass the capacity guard and (b) wire BOTH input ports through a
// real merger junction into the consumer — like a hand build. Regression:
// everything was wired to the first port, starving the chain at one node's
// rate while the second sat idle.

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

    // and BOTH input ports feed a real MERGER junction, whose single output
    // carries the combined stream to the consumer — not two parallel belts
    // into the machine, and never a single-port pull.
    const hydrated = await (await page.request.get(`${API}/hydrate`)).json();
    const edges = Object.values(hydrated.plan.edges) as {
      from: { kind: string; id: string };
      to: { kind: string; id: string };
    }[];
    const junctions = Object.values(hydrated.plan.junctions) as { id: string; kind: string; factory: string }[];
    const merger = junctions.find((j) => j.factory === f && j.kind === "merger");
    expect(merger).toBeTruthy();
    const intoMerger = edges.filter((e) => e.to.kind === "junction" && e.to.id === merger!.id);
    expect(intoMerger.map((e) => e.from.id).sort()).toEqual([portA, portB].sort());
    const outOfMerger = edges.filter((e) => e.from.kind === "junction" && e.from.id === merger!.id);
    expect(outOfMerger).toHaveLength(1);
    expect(outOfMerger[0].to.kind).toBe("group");

    // ---- second build against a PARTIALLY DRAWN pool ----
    // The rod chain draws 30 from A + 15 from B, so headroom is now A:0 B:15.
    // 10/min iron plate needs exactly 15/min ingot: the guard must pass on
    // the REMAINDER (derived draw subtracted), and the wiring must skip the
    // exhausted port A entirely — a single plain belt from B, no new merger.
    await page.getByTestId("btn-make-from-resources").click();
    const modal2 = page.getByTestId("make-from-resources");
    await modal2.getByTestId("mfr-item-Desc_IronPlate_C").click();
    await modal2.getByTestId("mfr-rate").fill("10");
    await expect(modal2.getByTestId("mfr-warn")).toHaveCount(0);
    await modal2.getByTestId("mfr-build").click();
    await expect(modal2).toBeHidden();

    const h2 = await (await page.request.get(`${API}/hydrate`)).json();
    const edges2 = Object.values(h2.plan.edges) as {
      item: string;
      from: { kind: string; id: string };
      to: { kind: string; id: string };
    }[];
    const fromA2 = edges2.filter((e) => e.from.kind === "port" && e.from.id === portA);
    const fromB2 = edges2.filter((e) => e.from.kind === "port" && e.from.id === portB);
    expect(fromA2).toHaveLength(1); // unchanged: only the original merger feed
    expect(fromB2).toHaveLength(2); // merger feed + the new plate line's belt
    expect(fromB2.some((e) => e.to.kind === "group" && e.to.id !== outOfMerger[0].to.id)).toBe(true);
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});
