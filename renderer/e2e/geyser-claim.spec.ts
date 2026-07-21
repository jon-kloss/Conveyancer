// Geothermal PLACEMENT: a geyser now renders on the map and its drawer is the
// GEOTHERMAL drawer — PLACE GEOTHERMAL stamps a factory with one Geothermal
// Generator whose output scales with the geyser's purity. (The purity math is
// covered by the Rust integration test; this pins the map render + place UI.)

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
  if (!res.ok()) throw new Error(`hydrate ${res.status()}`);
  return res.json();
}

test("a geyser places a geothermal generator from its drawer", async ({ page, request }) => {
  await resetView(request);
  try {
    await page.goto("/");
    const skip = page.getByTestId("onboard-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();

    // Geyser ids contain "geyser", so the ⌘K search surfaces them; selecting one
    // opens the GEOTHERMAL drawer.
    await page.locator(".searchbox input").fill("geyser");
    await page.keyboard.press("Enter");
    const drawer = page.getByTestId("node-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".t-title")).toContainText("GEYSER");
    // a satellite/plain miner claim must NOT be offered
    await expect(page.getByTestId("btn-claim")).toHaveCount(0);

    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/edit") && r.request().method() === "POST"),
      page.getByTestId("btn-claim-geyser").click(),
    ]);

    // one factory with a single Geothermal Generator group
    const h = await hydrate(request);
    const geyserFactory = Object.values<any>(h.plan.factories).find((f) => f.name.includes("GEYSER"));
    expect(geyserFactory, "a GEYSER factory was created").toBeTruthy();
    expect(
      Object.values<any>(h.plan.groups).some(
        (g) => g.factory === geyserFactory.id && g.machine === "Build_GeneratorGeoThermal_C",
      ),
    ).toBe(true);
  } finally {
    const h = await hydrate(request).catch(() => null);
    for (const f of Object.values<any>(h?.plan.factories ?? {})) {
      if (typeof f.name === "string" && f.name.includes("GEYSER")) {
        await edit(request, [{ type: "delete_factory", id: f.id }]).catch(() => {});
      }
    }
    await resetView(request);
  }
});
