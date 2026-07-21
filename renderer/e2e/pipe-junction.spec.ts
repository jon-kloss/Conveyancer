// Pipe Junction — the single 4-way Pipeline Junction Cross that both merges and
// splits FLUID lines. Placed from the + LOGISTIC catalog like a belt junction,
// but it carries fluids only (a solid edge is refused) and reads pipe-blue.

import { test, expect, type APIRequestContext } from "@playwright/test";
import { resetView } from "./helpers";

const API = "http://localhost:8791/api";

async function edit(
  request: APIRequestContext,
  cmds: unknown[],
): Promise<{ created: string[] }> {
  const res = await request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
  if (!res.ok()) throw new Error(`edit ${res.status()}: ${await res.text()}`);
  return res.json();
}
// A raw /edit that the server SHOULD reject — returns whether it failed.
async function editFails(request: APIRequestContext, cmds: unknown[]): Promise<boolean> {
  const res = await request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
  return !res.ok();
}
async function openGraph(page: any, name: string): Promise<void> {
  await page.locator(".searchbox input").fill(name);
  await page.keyboard.press("Enter");
  await page.getByTestId("btn-open-factory").click();
  await expect(page.locator(".react-flow__pane")).toBeVisible();
  await page.waitForTimeout(300);
}
async function dismissOnboarding(page: any): Promise<void> {
  const skip = page.getByTestId("onboard-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}
const P = (id: string) => ({ kind: "port", id });

test("place a Pipeline Junction from the catalog; it carries fluids, not solids", async ({
  page,
  request,
}) => {
  await resetView(request);
  const f = (
    await edit(request, [
      { type: "create_factory", name: "PIPE HALL", position: { x: -1000, y: 2100 }, region: "GRASS FIELDS" },
    ])
  ).created[0];
  // a water IN port to wire the junction to
  const water = (
    await edit(request, [
      { type: "add_port", factory: f, direction: "in", item: "Desc_Water_C", rate: 0, rateCeiling: 600, graphPos: { x: 0, y: 100 } },
    ])
  ).created[0];

  try {
    await page.goto("/");
    await dismissOnboarding(page);
    await openGraph(page, "PIPE HALL");

    // Place a Pipeline Junction from the + LOGISTIC catalog.
    await page.getByTestId("btn-logistic").click();
    await page
      .getByTestId("logistic-menu")
      .getByRole("button", { name: "Pipeline Junction" })
      .click();
    const node = page.locator('[data-testid^="junction-pipe_junction-"]');
    await expect(node).toBeVisible();
    // it reads as a fluid buildable (pipe-blue accent) — the class is on the
    // node itself (the testid sits on the .junction-card div).
    await expect(node).toHaveClass(/\bpipe\b/);

    // the placed junction's id (for wiring via the command surface)
    const jid = (await node.getAttribute("data-testid"))!.replace("junction-pipe_junction-", "");

    // WATER rides the cross — accepted.
    await edit(request, [
      { type: "add_edge", factory: f, from: P(water), to: { kind: "junction", id: jid }, item: "Desc_Water_C", tier: 1 },
    ]);

    // a SOLID (coal) onto the cross — refused server-side (pipes carry fluids only).
    const coal = (
      await edit(request, [
        { type: "add_port", factory: f, direction: "in", item: "Desc_Coal_C", rate: 0, rateCeiling: 240, graphPos: { x: 0, y: 260 } },
      ])
    ).created[0];
    expect(
      await editFails(request, [
        { type: "add_edge", factory: f, from: P(coal), to: { kind: "junction", id: jid }, item: "Desc_Coal_C", tier: 1 },
      ]),
    ).toBe(true);
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});
