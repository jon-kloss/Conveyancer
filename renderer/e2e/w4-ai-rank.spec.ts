// PR 10 bring-your-own-model ranking: the spec runs its OWN OpenAI-compatible
// stub provider inside the node test context (http.createServer — no real
// network, CI-offline safe) that reverses whatever candidate ids arrive and
// attaches a note to its top pick. Config happens through the SETTINGS
// POPOVER UI (the real user path), the ranked render is asserted against this
// run's own /api/next/rank payload, and killing the stub proves the honest
// fallback: heuristic order, no AI prose, error surfaced non-fatally. Named
// w4- so it runs after w3 (its seeds must not perturb earlier phase specs);
// self-contained seeding keeps standalone runs valid.

import { test, expect, type APIRequestContext } from "@playwright/test";
import http from "node:http";

import { resetView } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => resetView(request));

const API = "http://localhost:8791/api";
// Free port far from the suite's own 8791/5173 and the demo 8795/5199.
const STUB_PORT = 8917;
const STUB_HEADLINE = "Stub headline: unblock the starved chain first.";
const STUB_NOTE = "Stub note: this one pays off immediately.";
const KEY = "sk-w4-test-secret";

interface Move {
  id: string;
  title: string;
  evidence: string;
  note?: string;
}
interface Rank {
  engine: string;
  model?: string;
  headline?: string;
  error?: string;
  opportunities: Move[];
}

/** In-spec provider stub: parses the chat-completions request, reverses the
 *  candidate ids found in the user message, notes its top pick. */
function startStub(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      let order: string[] = [];
      try {
        const envelope = JSON.parse(body) as { messages: { content: string }[] };
        const user = JSON.parse(envelope.messages[1].content) as { candidates: { id: string }[] };
        order = user.candidates.map((c) => c.id).reverse();
      } catch {
        /* empty order → the firewall appends everything in heuristic order */
      }
      const notes: Record<string, string> = {};
      if (order[0]) notes[order[0]] = STUB_NOTE;
      const content = JSON.stringify({ order, headline: STUB_HEADLINE, notes });
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

test("model ranks and narrates NEXT MOVES; broken provider falls back honestly", async ({
  page,
  request,
}) => {
  const stub = await startStub();
  try {
    // ---- seed a two-card floor: a starved iron-rod chain (deficit_repair)
    // and a thin-headroom grid (power_margin). Leftover cards from earlier
    // serial specs may coexist — every assertion below is payload-derived. ----
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

    // Producer ships iron rods; sink demands more than the dipped upstream.
    const forge = await mk("NARRATOR FORGE", -4200, -1800);
    const forgeIn = await port(forge, "in", "Desc_IronIngot_C", 480, 0);
    const forgeOut = await port(forge, "out", "Desc_IronRod_C", null, 600);
    const ctors = await group(forge, "Build_ConstructorMk1_C", "Recipe_IronRod_C", 16);
    await belt(forge, P(forgeIn), G(ctors), "Desc_IronIngot_C");
    await belt(forge, G(ctors), P(forgeOut), "Desc_IronRod_C");
    await edit(request, [{ type: "set_port_rate", id: forgeOut, rate: 240 }]);

    const yard = await mk("RANKING YARD", -3600, -1800);
    const yardIn = await port(yard, "in", "Desc_IronRod_C", null, 0);
    const yardOut = await port(yard, "out", "Desc_IronRod_C", null, 600);
    await belt(yard, P(yardIn), P(yardOut), "Desc_IronRod_C");
    await edit(request, [
      {
        type: "add_route",
        kind: { kind: "belt", tier: 5 },
        from: forgeOut,
        to: yardIn,
        path: [{ x: -4200, y: -1800 }, { x: -3600, y: -1800 }],
      },
    ]);
    await edit(request, [{ type: "set_port_rate", id: yardOut, rate: 240 }]);
    await edit(request, [{ type: "set_port_rate", id: forgeOut, rate: 15 }]); // the dip

    // Thin-headroom grid (second guaranteed card, class 3): 4 coal generators
    // at 75 MW feed 16 smelters drawing 64 MW → ~15% headroom (warn band).
    const ridge = await mk("NARRATOR RIDGE", -4200, -1000);
    const coalIn = await port(ridge, "in", "Desc_Coal_C", 480, 0);
    const mwOut = await port(ridge, "out", "__PowerMW", null, 600);
    const gens = await group(ridge, "Build_GeneratorCoal_C", "Recipe_Power_Build_GeneratorCoal_Desc_Coal_C", 4);
    await belt(ridge, P(coalIn), G(gens), "Desc_Coal_C");
    await belt(ridge, G(gens), P(mwOut), "__PowerMW");
    await edit(request, [{ type: "set_port_rate", id: mwOut, rate: 75 }]);
    const ledge = await mk("NARRATOR LEDGE", -3600, -1000);
    const ledgeIn = await port(ledge, "in", "Desc_OreIron_C", 780, 0);
    const ledgeOut = await port(ledge, "out", "Desc_IronIngot_C", null, 600);
    const bank = await group(ledge, "Build_SmelterMk1_C", "Recipe_IngotIron_C", 16);
    await belt(ledge, P(ledgeIn), G(bank), "Desc_OreIron_C");
    await belt(ledge, G(bank), P(ledgeOut), "Desc_IronIngot_C");
    await edit(request, [{ type: "set_port_rate", id: ledgeOut, rate: 480 }]);
    await edit(request, [
      {
        type: "add_route",
        kind: { kind: "power" },
        from: ridge,
        to: ledge,
        path: [{ x: -4200, y: -1000 }, { x: -3600, y: -1000 }],
      },
    ]);

    // ---- unconfigured: rank answers heuristic, card-identical to /api/next ----
    const cfg0 = await (await request.get(`${API}/ai/config`)).json();
    expect(cfg0).toEqual({ configured: false, baseUrl: "", model: "", hasKey: false });
    const heuristic = (await (
      await request.post(`${API}/next/rank`, { data: "{}" })
    ).json()) as Rank;
    expect(heuristic.engine).toBe("heuristic");
    expect(heuristic.error).toBeUndefined();
    expect(heuristic.opportunities.length).toBeGreaterThanOrEqual(2);
    const plainIds = ((await (await request.get(`${API}/next`)).json()) as { opportunities: Move[] })
      .opportunities.map((o) => o.id);
    expect(heuristic.opportunities.map((o) => o.id)).toEqual(plainIds);

    // ---- configure THROUGH THE POPOVER UI ----
    await page.goto("/");
    await expect(page.getByTestId("map-root")).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("h");
    await expect(page.getByTestId("dashboard")).toBeVisible();
    await expect(page.getByTestId("next-moves")).toBeVisible();
    await expect(page.getByTestId("ai-chip")).toContainText("AI: OFF");
    // heuristic render: no AI prose anywhere
    await expect(page.getByTestId("ai-headline")).not.toBeVisible();
    await page.getByTestId("ai-chip").click();
    await expect(page.getByTestId("ai-settings")).toBeVisible();
    await page.getByTestId("ai-base-url").fill(`http://127.0.0.1:${STUB_PORT}/v1`);
    await page.getByTestId("ai-model").fill("stub-1");
    await page.getByTestId("ai-key").fill(KEY);
    await page.getByTestId("ai-save").click();
    await expect(page.getByTestId("ai-settings")).not.toBeVisible();
    await expect(page.getByTestId("ai-chip")).toContainText("AI: stub-1");

    // ---- the ranked payload: stub reversal + prose, firewall-shaped ----
    const ranked = (await (
      await request.post(`${API}/next/rank`, { data: "{}" })
    ).json()) as Rank;
    expect(ranked.engine).toBe("model");
    expect(ranked.model).toBe("stub-1");
    expect(ranked.headline).toBe(STUB_HEADLINE);
    expect(ranked.error).toBeUndefined();
    expect(ranked.opportunities.map((o) => o.id)).toEqual([...plainIds].reverse());
    expect(ranked.opportunities[0].note).toBe(STUB_NOTE);
    expect(ranked.opportunities[1].note).toBeUndefined();

    // ---- the dashboard renders the model order + attributed prose ----
    // (the save bumped rankEpoch, so the open dashboard already refetched)
    const headline = page.getByTestId("ai-headline");
    await expect(headline).toBeVisible();
    await expect(headline).toContainText(STUB_HEADLINE);
    await expect(headline).toContainText("AI · stub-1");
    const cards = page.getByTestId("next-move");
    await expect(cards.first()).toContainText(ranked.opportunities[0].title);
    const note = page.getByTestId("next-move-note").first();
    await expect(note).toBeVisible();
    await expect(note).toContainText(STUB_NOTE);
    // solver evidence stays byte-identical to the heuristic payload
    const topHeuristicTwin = heuristic.opportunities.find((o) => o.id === ranked.opportunities[0].id)!;
    await expect(cards.first().getByTestId("next-move-evidence")).toHaveText(topHeuristicTwin.evidence);

    // ---- key hygiene: the key never leaves the backend ----
    const cfgText = await (await request.get(`${API}/ai/config`)).text();
    expect(cfgText).toContain('"hasKey":true');
    expect(cfgText).not.toContain(KEY);
    expect(await (await request.get(`${API}/hydrate`)).text()).not.toContain(KEY);

    // ---- break the provider: honest heuristic fallback + surfaced error ----
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    const fallen = (await (
      await request.post(`${API}/next/rank`, { data: "{}" })
    ).json()) as Rank;
    expect(fallen.engine).toBe("heuristic");
    expect(fallen.error).toBeTruthy();
    expect(fallen.opportunities.map((o) => o.id)).toEqual(plainIds);
    expect(fallen.opportunities.every((o) => o.note === undefined)).toBe(true);

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("dashboard")).not.toBeVisible();
    await page.keyboard.press("h"); // remount → refetch against the dead stub
    await expect(page.getByTestId("dashboard")).toBeVisible();
    await expect(page.getByTestId("next-moves")).toBeVisible();
    await expect(cards.first()).toContainText(fallen.opportunities[0].title);
    await expect(page.getByTestId("ai-headline")).not.toBeVisible();
    await expect(page.getByTestId("next-move-note")).toHaveCount(0);
    // non-fatal: the status-bar chip carries the error, the dashboard lives on
    await expect(page.getByTestId("sb-error")).toContainText("model", { ignoreCase: true });
    await page.keyboard.press("Escape");
  } finally {
    stub.close();
    // leave the shared session unconfigured for any spec that follows
    await request.post(`${API}/ai/config`, { data: JSON.stringify({ baseUrl: "", model: "" }) });
  }
});
