// PR 10 bring-your-own-model ranking: the spec runs its OWN OpenAI-compatible
// stub provider inside the node test context (http.createServer — no real
// network, CI-offline safe) that reorders the candidate ids it receives and
// notes its top two picks. Config happens through the SETTINGS POPOVER UI
// (the real user path), the ranked render is asserted against this run's own
// /api/next/rank payload, and killing the stub proves the honest fallback:
// heuristic order, no AI prose, error surfaced non-fatally. Review additions:
// the M5 merge pins (an edit while open re-bills NOTHING and model prose
// never outlives the evidence it quoted), the M7 Escape layering, the L5
// save-time URL rejection, and the H1 hydrate-latency probe against a
// deliberately slow provider. Named w4- so it runs after w3 (its seeds must
// not perturb earlier phase specs); self-contained seeding keeps standalone
// runs valid.

import { test, expect, type APIRequestContext } from "@playwright/test";
import http from "node:http";

import { resetView } from "./helpers";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => resetView(request));

const API = "http://localhost:8791/api";
// Free ports far from the suite's own 8791/5173 and the demo 8795/5199.
const STUB_PORT = 8917;
const SLOW_PORT = 8919;
const STUB_HEADLINE = "Stub headline: unblock the starved chain first.";
const STUB_NOTE = "Stub note: this one pays off immediately.";
const STUB_NOTE_2 = "Stub note two: margin is thinner than it looks.";
const KEY = "sk-w4-test-secret";

// The card the M5 pin edits (its evidence quotes supplied/min) — hoisted to
// the model's top so the note-drop and headline-drop are DOM-observable in
// the top-3 render.
const DEFICIT_ID = "deficit_repair:Desc_IronRod_C";

/** The stub's deterministic order, replicated by the assertions below: the
 *  iron-rod deficit first (the card whose evidence the M5 edit changes),
 *  every power_margin card next (evidence untouched by that edit), the rest
 *  reversed. */
const stubOrder = (ids: string[]): string[] => [
  ...ids.filter((i) => i === DEFICIT_ID),
  ...ids.filter((i) => i.startsWith("power_margin:")),
  ...ids.filter((i) => i !== DEFICIT_ID && !i.startsWith("power_margin:")).reverse(),
];

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

/** Call counter for the M5 pin: an /api/edit while the dashboard is open
 *  must not add a single provider call. */
let stubCalls = 0;

/** In-spec provider stub: parses the chat-completions request, applies
 *  stubOrder to the candidate ids found in the user message, and notes its
 *  top two picks. */
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
        order = stubOrder(user.candidates.map((c) => c.id));
      } catch {
        /* empty order → the firewall appends everything in heuristic order */
      }
      const notes: Record<string, string> = {};
      if (order[0]) notes[order[0]] = STUB_NOTE;
      if (order[1]) notes[order[1]] = STUB_NOTE_2;
      const content = JSON.stringify({ order, headline: STUB_HEADLINE, notes });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => server.listen(STUB_PORT, "127.0.0.1", () => resolve(server)));
}

/** H1 probe stub: a provider that takes 3 s to answer. The rank call must
 *  run OFF the session lock, so a concurrent hydrate answers immediately. */
function startSlowStub(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      setTimeout(() => {
        const content = JSON.stringify({ order: [], headline: "slow", notes: {} });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      }, 3000);
    });
  });
  return new Promise((resolve) => server.listen(SLOW_PORT, "127.0.0.1", () => resolve(server)));
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
    expect(plainIds).toContain(DEFICIT_ID);
    expect(plainIds.some((i) => i.startsWith("power_margin:"))).toBe(true);

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

    // ---- the ranked payload: stub order + prose, firewall-shaped ----
    const ranked = (await (
      await request.post(`${API}/next/rank`, { data: "{}" })
    ).json()) as Rank;
    expect(ranked.engine).toBe("model");
    expect(ranked.model).toBe("stub-1");
    expect(ranked.headline).toBe(STUB_HEADLINE);
    expect(ranked.error).toBeUndefined();
    expect(ranked.opportunities.map((o) => o.id)).toEqual(stubOrder(plainIds));
    expect(ranked.opportunities[0].id).toBe(DEFICIT_ID);
    expect(ranked.opportunities[0].note).toBe(STUB_NOTE);
    expect(ranked.opportunities[1].note).toBe(STUB_NOTE_2);

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
    // S2: the note's attribution badge is the AI chip, verbatim
    await expect(note.locator(".dash-badge.ai")).toHaveText("AI");
    // solver evidence stays byte-identical to the heuristic payload
    const topHeuristicTwin = heuristic.opportunities.find((o) => o.id === ranked.opportunities[0].id)!;
    await expect(cards.first().getByTestId("next-move-evidence")).toHaveText(topHeuristicTwin.evidence);

    // ---- key hygiene: the key never leaves the backend ----
    const cfgText = await (await request.get(`${API}/ai/config`)).text();
    expect(cfgText).toContain('"hasKey":true');
    expect(cfgText).not.toContain(KEY);
    expect(await (await request.get(`${API}/hydrate`)).text()).not.toContain(KEY);

    // ---- M5: an edit while the dashboard is open re-bills NOTHING — the
    // fresh heuristic list merges under the model's standing order, and
    // prose never outlives the evidence it quoted: the edited card's note
    // (and the headline, keyed to that same top card) drop; the untouched
    // card's note survives. ----
    const shown = Math.min(3, ranked.opportunities.length);
    const titlesBefore: string[] = [];
    for (let i = 0; i < shown; i++) {
      titlesBefore.push((await cards.nth(i).locator(".dash-step-label").textContent())!);
    }
    await expect(cards.nth(1).getByTestId("next-move-note")).toContainText(STUB_NOTE_2);
    const callsBefore = stubCalls;
    const evidenceBefore = ranked.opportunities[0].evidence;
    // A REAL in-page dispatch (the test fixture's own /api/edit never reaches
    // the page store — no SSE in the dev bridge): ease the dip 15 → 30, which
    // rewrites the iron-rod deficit's evidence but keeps the card alive.
    await page.evaluate(
      async (args) => {
        type StoreWin = {
          __ficsitStore: { getState(): { dispatch(cmds: unknown[]): Promise<unknown> } };
        };
        await (window as unknown as StoreWin).__ficsitStore
          .getState()
          .dispatch([{ type: "set_port_rate", id: args.id, rate: args.rate }]);
      },
      { id: forgeOut, rate: 30 },
    );
    // the merged render carries the FRESH evidence…
    await expect(cards.first().getByTestId("next-move-evidence")).not.toHaveText(evidenceBefore);
    // …the changed card's note is gone (evidence gate)…
    await expect(cards.first().getByTestId("next-move-note")).toHaveCount(0);
    // …the headline died with the top card's evidence…
    await expect(page.getByTestId("ai-headline")).not.toBeVisible();
    // …the untouched card's note is still there (still model-attributed)…
    await expect(cards.nth(1).getByTestId("next-move-note")).toContainText(STUB_NOTE_2);
    // …the model ORDER is preserved (heuristic order would not lead with the
    // deficit card the stub hoisted)…
    await expect(cards.first().locator(".dash-step-label")).toContainText("short");
    await expect(cards.first().locator(".dash-step-label")).toContainText("/min empire-wide");
    for (let i = 1; i < shown; i++) {
      await expect(cards.nth(i).locator(".dash-step-label")).toHaveText(titlesBefore[i]);
    }
    // …and the provider was never called for any of it.
    expect(stubCalls).toBe(callsBefore);

    // ---- M7: Escape peels ONE layer — popover first, dashboard survives ----
    await page.getByTestId("ai-chip").click();
    await expect(page.getByTestId("ai-settings")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ai-settings")).not.toBeVisible();
    await expect(page.getByTestId("dashboard")).toBeVisible();

    // ---- L5: save-time URL validation, protocol-aware ----
    await page.getByTestId("ai-chip").click();
    await expect(page.getByTestId("ai-settings")).toBeVisible();
    await page.getByTestId("ai-base-url").fill("not a url");
    await page.getByTestId("ai-save").click();
    await expect(page.getByTestId("ai-url-error")).toBeVisible();
    await expect(page.getByTestId("ai-settings")).toBeVisible(); // still open, nothing saved
    // the likeliest paste mistake PARSES (protocol "localhost:") — still rejected
    await page.getByTestId("ai-base-url").fill("localhost:11434/v1");
    await expect(page.getByTestId("ai-url-error")).not.toBeVisible(); // cleared on edit
    await page.getByTestId("ai-save").click();
    await expect(page.getByTestId("ai-url-error")).toBeVisible();
    await expect(page.getByTestId("ai-url-error")).toContainText("http");
    // focus is inside the form field: the popover's own Escape handler owns
    // this close (App's window handler yields at isEditableTarget)
    await page.getByTestId("ai-base-url").click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("ai-settings")).not.toBeVisible();
    await expect(page.getByTestId("dashboard")).toBeVisible();
    // the failed saves changed nothing backend-side
    await expect(page.getByTestId("ai-chip")).toContainText("AI: stub-1");

    // ---- break the provider: honest heuristic fallback + surfaced error ----
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    const fallen = (await (
      await request.post(`${API}/next/rank`, { data: "{}" })
    ).json()) as Rank;
    expect(fallen.engine).toBe("heuristic");
    expect(fallen.error).toBeTruthy();
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

    // ---- H1: a provider call in flight never wedges the bridge — hydrate
    // (and every other endpoint) answers while the model is still thinking.
    // Generous margins: the stub sleeps 3 s, hydrate must answer in < 1.5 s. ----
    const slow = await startSlowStub();
    try {
      await request.post(`${API}/ai/config`, {
        data: JSON.stringify({ baseUrl: `http://127.0.0.1:${SLOW_PORT}/v1`, model: "slow-1" }),
      });
      const inflight = request.post(`${API}/next/rank`, { data: "{}" });
      await new Promise((r) => setTimeout(r, 500)); // rank is off-lock by now
      const t0 = Date.now();
      const hyd = await request.get(`${API}/hydrate`);
      const elapsedMs = Date.now() - t0;
      expect(hyd.ok()).toBe(true);
      expect(elapsedMs).toBeLessThan(1500);
      expect((await inflight).ok()).toBe(true); // drain before teardown
    } finally {
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  } finally {
    stub.close();
    // leave the shared session unconfigured for any spec that follows
    await request.post(`${API}/ai/config`, { data: JSON.stringify({ baseUrl: "", model: "" }) });
  }
});
