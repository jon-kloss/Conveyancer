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
// A deliberately-slow provider for the H1 race spec — far from every other
// port the suite binds (8791/5173, the demo 8795/5199, w4's 8917/8919, this
// spec's 8921).
const SLOW_PORT = 8923;
const HEADLINE = "Stub headline: unblock the starve first.";
const WILDCARD_TITLE = "Second rod line";
const KEY = "sk-w5-test-secret";

/** Provider call counter — a preference toggle must re-rank (one more call). */
let stubCalls = 0;

/** The dev-only in-page store handle (see store.ts `__ficsitStore`). External
 *  /api/edit calls never reach the page store (no SSE in the dev bridge), so
 *  the shared-rank contracts below drive it directly — the same entry points
 *  the real UI calls. Typed narrowly to the members these specs touch. */
type StoreWin = {
  __ficsitStore: {
    getState(): {
      setAdvisorOpen(open: boolean): void;
      setAdvisorTab(tab: string): void;
      setDashboardOpen(open: boolean): void;
      setAiSettingsOpen(context: string | null): void;
      bumpRankEpoch(): void;
      dispatch(cmds: unknown[]): Promise<unknown>;
      rank: { opportunities: { id: string }[] } | null;
    };
  };
};

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

/** H1 race stub: answers the rank after a deliberate delay so a plan edit can
 *  land WHILE the first rank is still in flight. Returns an empty order (the
 *  firewall appends the heuristic list) — the race is about the STALE list
 *  refreshing away, not about the model's opinion. */
function startSlowStub(delayMs: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    stubCalls += 1;
    req.resume();
    req.on("end", () => {
      setTimeout(() => {
        const content = JSON.stringify({ order: [], headline: "slow rank", notes: {} });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      }, delayMs);
    });
  });
  return new Promise((resolve) => server.listen(SLOW_PORT, "127.0.0.1", () => resolve(server)));
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

    // ---- H2: the no-double-bill contract, pinned to EXACT call deltas. The
    // model was configured server-side (no client save → epoch still 0). The
    // dashboard's rank has resolved (headline above), so its provider calls
    // have settled — capture that baseline. (The absolute is 2, not 1: dev
    // StrictMode mounts→remounts the feed, so the first open bills twice. That
    // is a dev-only artifact of the double-mount, so the contract is pinned as
    // DELTAS — a second surface adds ZERO, an epoch bump adds exactly ONE.) ----
    const afterDash = stubCalls;
    expect(afterDash).toBeGreaterThan(0);
    // Mount the docked panel NEXT tab ALONGSIDE the still-open dashboard: two
    // surfaces, one store-owned rank owner. Driven through the store — the
    // dashboard scrim covers the status-bar chip, and this simultaneous-mount
    // state is exactly what the openRankFeed (planHash, epoch) guard protects.
    await page.evaluate(() => {
      const st = (window as unknown as StoreWin).__ficsitStore.getState();
      st.setAdvisorOpen(true);
      st.setAdvisorTab("next");
    });
    const panelFeedEarly = page.getByTestId("advisor-panel").getByTestId("next-moves");
    await expect(panelFeedEarly).toBeVisible();
    await expect(panelFeedEarly.getByTestId("next-move").first()).toBeVisible();
    // The second surface rode the first surface's rank — NOT ONE new call.
    // (Delete the rankedKey===key early-return in openRankFeed and the panel
    // re-bills here → this fails.)
    expect(stubCalls).toBe(afterDash);
    // An epoch bump (what a config save / preference toggle does) with BOTH
    // feeds mounted re-ranks exactly ONCE — not once per surface.
    await page.evaluate(() => {
      (window as unknown as StoreWin).__ficsitStore.getState().bumpRankEpoch();
    });
    await expect.poll(() => stubCalls).toBe(afterDash + 1);
    // Give any errant second-surface refetch a beat to appear; it must not.
    await expect(panelFeedEarly.getByTestId("next-move").first()).toBeVisible();
    expect(stubCalls).toBe(afterDash + 1);
    // Close the panel again; the rest of the flow re-opens it via the chip.
    await page.evaluate(() => {
      (window as unknown as StoreWin).__ficsitStore.getState().setAdvisorOpen(false);
    });
    await expect(page.getByTestId("advisor-panel")).not.toBeVisible();

    // wildcard block: two survive (empty title dropped), AI-attributed, dashed
    const wildcards = dashFeed.getByTestId("wildcard");
    await expect(wildcards).toHaveCount(2);
    await expect(dashFeed.getByTestId("wildcards")).toContainText("WILDCARD IDEAS");
    await expect(dashFeed.getByTestId("wildcards")).toContainText("Unverified");
    await expect(wildcards.first()).toContainText(WILDCARD_TITLE);

    // ---- TA-#4: TRY IT opens the WIZARD prefilled with the validated item +
    // rate, but writes NO plan state — only solving/accepting later makes it
    // real. Capture the plan geometry (hash + factory count) first. ----
    const geomBefore = (await (await request.get(`${API}/hydrate`)).json()) as {
      planHash: string;
      plan: { factories: Record<string, unknown> };
    };
    const hashBefore = geomBefore.planHash;
    const factoriesBefore = Object.keys(geomBefore.plan.factories).length;

    await wildcards.first().getByTestId("wildcard-try").click();
    await expect(page.getByTestId("dashboard")).not.toBeVisible();
    await expect(page.getByTestId("wizard-modal")).toBeVisible();
    await expect(page.getByTestId("wizard-item")).toHaveValue("Iron Rod");
    await expect(page.locator('[data-testid="wizard-rate"]')).toHaveValue("90");
    // The wizard is PREFILLED, but the plan is byte-for-byte unchanged: the
    // hash is stable and no factory was created by merely opening the wizard.
    const geomAfter = (await (await request.get(`${API}/hydrate`)).json()) as {
      planHash: string;
      plan: { factories: Record<string, unknown> };
    };
    expect(geomAfter.planHash).toBe(hashBefore);
    expect(Object.keys(geomAfter.plan.factories).length).toBe(factoriesBefore);
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

    // ---- M2: two mounted NEXT gears no longer share one open flag. The panel
    // is open (chip deep-link above); reopen the dashboard so BOTH <AiSettings/>
    // mount. Open the PANEL context's popover, then close the dashboard overlay
    // — unmounting the dashboard's gear must NOT slam the panel's popover shut. ----
    await page.keyboard.press("h");
    await expect(page.getByTestId("dashboard")).toBeVisible();
    // Open the panel popover (the dashboard scrim covers the panel's own chip,
    // so set the context-scoped flag the way a click would — scoped to "panel").
    await page.evaluate(() => {
      (window as unknown as StoreWin).__ficsitStore.getState().setAiSettingsOpen("panel");
    });
    const panelSettings = page.getByTestId("advisor-panel").getByTestId("ai-settings");
    await expect(panelSettings).toBeVisible();
    // The flag is context-scoped: only the panel renders its popover.
    await expect(page.getByTestId("dashboard").getByTestId("ai-settings")).toHaveCount(0);
    // Close the dashboard overlay → its <AiSettings/> unmounts; its cleanup
    // clears the flag ONLY if it still owns it (it doesn't — "panel" does).
    await page.evaluate(() => {
      (window as unknown as StoreWin).__ficsitStore.getState().setDashboardOpen(false);
    });
    await expect(page.getByTestId("dashboard")).not.toBeVisible();
    // Pre-M2 the shared boolean's cleanup would have force-closed this; now it
    // survives (the panel still owns its own key draft).
    await expect(panelSettings).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as StoreWin).__ficsitStore.getState().setAiSettingsOpen(null);
    });
  } finally {
    stub.close();
    // leave the shared session pristine for any later spec
    await request.post(`${API}/ai/config`, { data: JSON.stringify({ baseUrl: "", model: "" }) });
    await request.post(`${API}/next/preferences`, {
      data: JSON.stringify({ noTrains: false, ignorePower: false }),
    });
  }
});

// H1 race (RC-H1): an /api/edit landing WHILE the first model rank is in flight
// must not be swallowed. Before the fix, openRankFeed stamped `lastMergedHash`
// to "now" on resolve, claiming the post-edit hash for a pre-edit list — so the
// vanished card stuck as a stale, dead-clickable entry until an unrelated later
// edit. With a deliberately-slow provider we open a feed (ranking hash H0), edit
// to remove a card's subject mid-flight (→ H1), and assert the resolved+merged
// shared rank reflects H1 (the vanished card is gone), never the swallowed H0.
test("stale rank refreshes away when an edit lands during the first in-flight fetch", async ({
  page,
  request,
}) => {
  const slow = await startSlowStub(1500);
  try {
    // ---- seed an ISOLATED wire deficit: no earlier spec starves a wire input
    // port, so this is the ONLY `deficit_repair:Desc_Wire_C` row — clearing it
    // drops the card cleanly (deficits are per-starved-port, grouped by item). ----
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

    // Producer dips its wire output; a cable consumer downstream demands more.
    const spin = await mk("H1 SPINNER", -6000, -3000);
    const spinIn = await port(spin, "in", "Desc_CopperIngot_C", 480, 0);
    const spinOut = await port(spin, "out", "Desc_Wire_C", null, 600);
    const spinG = await group(spin, "Build_ConstructorMk1_C", "Recipe_Wire_C", 16);
    await belt(spin, P(spinIn), G(spinG), "Desc_CopperIngot_C");
    await belt(spin, G(spinG), P(spinOut), "Desc_Wire_C");
    await edit(request, [{ type: "set_port_rate", id: spinOut, rate: 240 }]);

    const weave = await mk("H1 WEAVE", -5400, -3000);
    const weaveIn = await port(weave, "in", "Desc_Wire_C", null, 0);
    const weaveOut = await port(weave, "out", "Desc_Cable_C", null, 600);
    const weaveG = await group(weave, "Build_ConstructorMk1_C", "Recipe_Cable_C", 16);
    await belt(weave, P(weaveIn), G(weaveG), "Desc_Wire_C");
    await belt(weave, G(weaveG), P(weaveOut), "Desc_Cable_C");
    await edit(request, [
      {
        type: "add_route",
        kind: { kind: "belt", tier: 5 },
        from: spinOut,
        to: weaveIn,
        path: [{ x: -6000, y: -3000 }, { x: -5400, y: -3000 }],
      },
    ]);
    await edit(request, [{ type: "set_port_rate", id: weaveOut, rate: 480 }]);
    await edit(request, [{ type: "set_port_rate", id: spinOut, rate: 10 }]); // the dip → wire short (H0)

    const WIRE_CARD = "deficit_repair:Desc_Wire_C";
    // H0 sanity: the wire deficit is a real card in the heuristic list.
    const h0 = (await (await request.get(`${API}/next`)).json()) as { opportunities: { id: string }[] };
    expect(h0.opportunities.map((o) => o.id)).toContain(WIRE_CARD);

    // point at the SLOW provider so the first rank stays in flight.
    await request.post(`${API}/ai/config`, {
      data: JSON.stringify({ baseUrl: `http://127.0.0.1:${SLOW_PORT}/v1`, model: "slow-w5", apiKey: KEY }),
    });

    await page.goto("/");
    await expect(page.getByTestId("map-root")).toBeVisible({ timeout: 10_000 });
    const callsAt0 = stubCalls;
    await page.keyboard.press("h");
    await expect(page.getByTestId("dashboard")).toBeVisible();
    await expect(page.getByTestId("dashboard").getByTestId("next-moves")).toBeVisible();
    // the first rank has REACHED the slow provider — it is in flight now, its
    // response still parked behind the delay.
    await expect.poll(() => stubCalls).toBeGreaterThan(callsAt0);

    // WHILE the rank is in flight, land an in-page edit that removes the wire
    // deficit's subject (raise the producer to meet demand) → planHash moves to
    // H1. External /api/edit never reaches the page store (no SSE in the dev
    // bridge), so dispatch through the store — the exact race the fix reconciles.
    await page.evaluate(async (id) => {
      await (window as unknown as StoreWin).__ficsitStore
        .getState()
        .dispatch([{ type: "set_port_rate", id, rate: 600 }]);
    }, spinOut);

    // After the slow rank resolves AND the merge reconciles against H1, the
    // shared rank must settle CLEAN — resolved (non-null) and without the stale
    // wire card. Poll the end-state: "pending" (rank not yet resolved) and
    // "has-wire" (the swallowed H0 list) are both transient under the fix and
    // terminal under the bug (→ timeout). Generous margin: the stub sleeps 1.5s.
    await expect
      .poll(
        async () =>
          await page.evaluate(() => {
            const r = (window as unknown as StoreWin).__ficsitStore.getState().rank;
            if (!r) return "pending";
            return r.opportunities.some((o) => o.id === "deficit_repair:Desc_Wire_C")
              ? "has-wire"
              : "clean";
          }),
        { timeout: 12_000 },
      )
      .toBe("clean");

    // corroboration: the backend agrees the deficit is gone at H1.
    const h1 = (await (await request.get(`${API}/next`)).json()) as { opportunities: { id: string }[] };
    expect(h1.opportunities.map((o) => o.id)).not.toContain(WIRE_CARD);
  } finally {
    await new Promise<void>((resolve) => slow.close(() => resolve()));
    await request.post(`${API}/ai/config`, { data: JSON.stringify({ baseUrl: "", model: "" }) });
  }
});
