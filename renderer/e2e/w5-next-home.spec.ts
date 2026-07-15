// PR 3 docked NEXT home + preferences + wildcard ideas. Reuses w4's in-spec
// OpenAI-compatible stub pattern (http.createServer — no real network,
// CI-offline safe), extended to also return WILDCARD ideas. Asserts: the
// wildcard block renders and TRY IT opens the wizard prefilled with the
// validated item + rate; the docked advisor NEXT tab renders the SAME cards as
// the resume dashboard (one shared rank owner); the status-bar NEXT chip
// deep-links to the panel NEXT tab; and a preference toggle persists (through
// hydrate) and re-ranks. Named w5- so it runs after w3/w4; self-contained
// seeding keeps standalone runs valid.

import { test, expect, type APIRequestContext } from "@playwright/test";
import http from "node:http";

import { resetView } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => resetView(request));

const API = "http://localhost:8791/api";
const STUB_PORT = 8921;
const HEADLINE = "Stub headline: unblock the starve first.";
const WILDCARD_TITLE = "Second rod line";
const KEY = "sk-w5-test-secret";

/** Provider call counter — a preference toggle must re-rank (one more call). */
let stubCalls = 0;

/** In-spec provider stub: reverses the candidate order (so engine=model) and
 *  always floats three wildcards — one with a KNOWN catalog item + rate, one
 *  pure-idea (no item), and one with an EMPTY title the firewall must drop. */
function startStub(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    stubCalls += 1;
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      let order: string[] = [];
      try {
        const envelope = JSON.parse(body) as { messages: { content: string }[] };
        const user = JSON.parse(envelope.messages[1].content) as { candidates: { id: string }[] };
        order = user.candidates.map((c) => c.id).reverse();
      } catch {
        /* empty order → firewall appends everything in heuristic order */
      }
      const notes: Record<string, string> = {};
      if (order[0]) notes[order[0]] = "Stub note: start here.";
      const content = JSON.stringify({
        order,
        headline: HEADLINE,
        notes,
        wildcards: [
          { title: WILDCARD_TITLE, rationale: "you have spare ingots", item: "Desc_IronRod_C", rate: 90 },
          { title: "Explore the northern desert", rationale: "untapped territory" },
          { title: "", rationale: "empty title — the firewall drops this" },
        ],
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => server.listen(STUB_PORT, "127.0.0.1", () => resolve(server)));
}

async function edit(request: APIRequestContext, cmds: unknown[]): Promise<{ created: string[] }> {
  const res = await request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
  if (!res.ok()) throw new Error(`edit ${res.status()}: ${await res.text()}`);
  return res.json();
}

test("docked NEXT home: wildcards + shared cards + deep-link + preferences", async ({
  page,
  request,
}) => {
  const stub = await startStub();
  try {
    // ---- seed a starved COPPER chain (own item) → a deficit_repair card ----
    const mk = async (name: string, x: number, y: number) =>
      (await edit(request, [{ type: "create_factory", name, position: { x, y }, region: "GRASS FIELDS" }]))
        .created[0];
    const port = async (factory: string, direction: string, item: string, ceiling: number | null, x: number) =>
      (
        await edit(request, [
          { type: "add_port", factory, direction, item, rate: 0, rateCeiling: ceiling, graphPos: { x, y: 100 } },
        ])
      ).created[0];
    const group = async (factory: string, machine: string, recipe: string, count: number) =>
      (
        await edit(request, [
          { type: "add_group", factory, machine, recipe, count, clock: 1.0, graphPos: { x: 300, y: 100 }, floor: 0 },
        ])
      ).created[0];
    const belt = (factory: string, from: unknown, to: unknown, item: string) =>
      edit(request, [{ type: "add_edge", factory, from, to, item, tier: 5 }]);
    const G = (id: string) => ({ kind: "group", id });
    const P = (id: string) => ({ kind: "port", id });

    const bay = await mk("W5 BAY", -5000, -2600);
    const bayIn = await port(bay, "in", "Desc_OreCopper_C", 480, 0);
    const bayOut = await port(bay, "out", "Desc_CopperIngot_C", null, 600);
    const smelters = await group(bay, "Build_SmelterMk1_C", "Recipe_IngotCopper_C", 8);
    await belt(bay, P(bayIn), G(smelters), "Desc_OreCopper_C");
    await belt(bay, G(smelters), P(bayOut), "Desc_CopperIngot_C");
    await edit(request, [{ type: "set_port_rate", id: bayOut, rate: 240 }]);

    const gulch = await mk("W5 GULCH", -4400, -2600);
    const gulchIn = await port(gulch, "in", "Desc_CopperIngot_C", null, 0);
    const gulchOut = await port(gulch, "out", "Desc_Wire_C", null, 600);
    const ctors = await group(gulch, "Build_ConstructorMk1_C", "Recipe_Wire_C", 16);
    await belt(gulch, P(gulchIn), G(ctors), "Desc_CopperIngot_C");
    await belt(gulch, G(ctors), P(gulchOut), "Desc_Wire_C");
    await edit(request, [
      {
        type: "add_route",
        kind: { kind: "belt", tier: 4 },
        from: bayOut,
        to: gulchIn,
        path: [{ x: -5000, y: -2600 }, { x: -4400, y: -2600 }],
      },
    ]);
    await edit(request, [{ type: "set_port_rate", id: gulchOut, rate: 480 }]);
    await edit(request, [{ type: "set_port_rate", id: bayOut, rate: 10 }]); // the dip

    // ---- configure the model (server-side is enough for the ranked payload) ----
    await request.post(`${API}/ai/config`, {
      data: JSON.stringify({ baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`, model: "stub-w5", apiKey: KEY }),
    });

    // ---- dashboard: model rank + WILDCARD block ----
    await page.goto("/");
    await expect(page.getByTestId("map-root")).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("h");
    await expect(page.getByTestId("dashboard")).toBeVisible();
    const dashFeed = page.getByTestId("dashboard").getByTestId("next-moves");
    await expect(dashFeed).toBeVisible();
    await expect(dashFeed.getByTestId("ai-headline")).toContainText(HEADLINE);

    // capture the dashboard's rendered card titles (shared-owner comparison)
    const dashCards = dashFeed.getByTestId("next-move");
    await expect(dashCards.first()).toBeVisible();
    const dashTitles = await dashCards.locator(".dash-step-label").allTextContents();
    expect(dashTitles.length).toBeGreaterThan(0);

    // wildcard block: two survive (empty title dropped), AI-attributed, dashed
    const wildcards = dashFeed.getByTestId("wildcard");
    await expect(wildcards).toHaveCount(2);
    await expect(dashFeed.getByTestId("wildcards")).toContainText("WILDCARD IDEAS");
    await expect(dashFeed.getByTestId("wildcards")).toContainText("Unverified");
    await expect(wildcards.first()).toContainText(WILDCARD_TITLE);

    // ---- TRY IT opens the WIZARD prefilled with the validated item + rate ----
    await wildcards.first().getByTestId("wildcard-try").click();
    await expect(page.getByTestId("dashboard")).not.toBeVisible();
    await expect(page.getByTestId("wizard-modal")).toBeVisible();
    await expect(page.getByTestId("wizard-item")).toHaveValue("Iron Rod");
    await expect(page.locator('[data-testid="wizard-rate"]')).toHaveValue("90");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("wizard-modal")).not.toBeVisible();

    // ---- status-bar NEXT chip → deep-links to the docked panel NEXT tab ----
    const nextChip = page.getByTestId("sb-next");
    await expect(nextChip).toBeVisible();
    await expect(nextChip).toContainText(dashTitles[0].trim());
    await nextChip.click();
    await expect(page.getByTestId("advisor-panel")).toBeVisible();
    const panelFeed = page.getByTestId("advisor-panel").getByTestId("next-moves");
    await expect(panelFeed).toBeVisible();

    // ---- the docked NEXT tab renders the SAME cards as the dashboard ----
    const panelCards = panelFeed.getByTestId("next-move");
    await expect(panelCards.first()).toBeVisible();
    const panelTitles = await panelCards.locator(".dash-step-label").allTextContents();
    expect(panelTitles).toEqual(dashTitles);
    // and the same wildcard block (shared rank owner)
    await expect(panelFeed.getByTestId("wildcard")).toHaveCount(2);

    // ---- a preference toggle PERSISTS (through hydrate) and RE-RANKS ----
    const callsBefore = stubCalls;
    const noTrains = panelFeed.getByTestId("pref-no-trains");
    await expect(noTrains).toHaveAttribute("aria-pressed", "false");
    await noTrains.click();
    await expect(noTrains).toHaveAttribute("aria-pressed", "true");
    // persisted: hydrate carries plan.meta.preferences.noTrains = true
    await expect
      .poll(async () => {
        const h = (await (await request.get(`${API}/hydrate`)).json()) as {
          plan: { meta: { preferences?: { noTrains?: boolean } } };
        };
        return h.plan.meta.preferences?.noTrains;
      })
      .toBe(true);
    // re-ranked: the epoch bump refetched the model (one more provider call)
    await expect.poll(() => stubCalls).toBeGreaterThan(callsBefore);
  } finally {
    stub.close();
    // leave the shared session pristine for any later spec
    await request.post(`${API}/ai/config`, { data: JSON.stringify({ baseUrl: "", model: "" }) });
    await request.post(`${API}/next/preferences`, {
      data: JSON.stringify({ noTrains: false, ignorePower: false }),
    });
  }
});
