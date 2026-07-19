// AUDIT area: gamedata — nameplate/burn/variable-power synthesis through the
// solve, plus per-grid vs empire generation attribution. Every probe declares
// its EXPECTED (correct) result in the header BEFORE any assertion; a failing
// probe is data for the mismatch protocol, not a reason to weaken the assert.
//
// Seeded through the same command surface the UI uses, against the dev bridge's
// default fixture catalog (contains Build_GeneratorGeoThermal_C, Build_GeneratorCoal_C
// @ 75 MW / 300 MJ coal, Build_HadronCollider_C with Recipe_Diamond_C /
// Recipe_DarkMatter_C variable-power recipes).

import { test, expect, type APIRequestContext } from "@playwright/test";
import { resetView } from "../e2e/helpers";

// NOTE: no serial mode — the runner uses --workers=1, and per-test isolation
// (each test seeds + deletes its own factories) means a failure must NOT
// cascade-skip sibling probes: every probe needs a verdict.

const API = "http://localhost:8791/api";

async function edit(request: APIRequestContext, cmds: unknown[]): Promise<{ created: string[] }> {
  const res = await request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
  if (!res.ok()) throw new Error(`edit ${res.status()}: ${await res.text()}`);
  return res.json();
}

interface DerivedGroup { inRates: Record<string, number>; outRates: Record<string, number>; powerMw: number }
interface DerivedFactory {
  groups: Record<string, DerivedGroup>;
  edges: Record<string, { flow: number; saturation: number }>;
  ports: Record<string, number>;
  totalPowerMw: number;
  solveError: string | null;
}
interface Hydrate {
  plan: { factories: Record<string, unknown> };
  derived: {
    factories: Record<string, DerivedFactory>;
    totalGenerationMw: number;
    totalPowerMw: number;
  };
}
async function hydrate(request: APIRequestContext): Promise<Hydrate> {
  const res = await request.get(`${API}/hydrate`);
  if (!res.ok()) throw new Error(`hydrate ${res.status()}: ${await res.text()}`);
  return res.json();
}

const POWER = "__PowerMW";
const G = (id: string) => ({ kind: "group", id });
const P = (id: string) => ({ kind: "port", id });

// ---------------------------------------------------------------------------
// PROBE 1 — Geothermal (recipe-less) generator on a grid: per-grid generation
// must equal nameplate, not 0.
//
// EXPECTED: The GRID card containing GEO FARM reads generation = 400 MW
// (200 MW nameplate x 2 generators) and the empire status bar sb-power reports
// the SAME 400 MW of generation. (Current behavior will instead show the GRID
// card at 0 MW generated / browned-out while the empire total shows 400 MW —
// the mismatch is the bug.)
// ---------------------------------------------------------------------------
test("geothermal grid card reads nameplate generation, not 0", async ({ page, request }) => {
  await resetView(request);

  const gf = (
    await edit(request, [
      { type: "create_factory", name: "GEO FARM", position: { x: -2600, y: 2400 }, region: "GRASS FIELDS" },
    ])
  ).created[0];
  // Two geothermal generators: fuel-less, recipe-less (imported-style). Each is
  // a 200 MW nameplate variable-power generator ⇒ 400 MW of generation.
  await edit(request, [
    {
      type: "add_group",
      factory: gf,
      machine: "Build_GeneratorGeoThermal_C",
      recipe: "",
      count: 2,
      clock: 1.0,
      graphPos: { x: 300, y: 100 },
      floor: 0,
    },
  ]);
  const ls = (
    await edit(request, [
      { type: "create_factory", name: "LOAD SINK", position: { x: -1600, y: 2400 }, region: "GRASS FIELDS" },
    ])
  ).created[0];
  // Power circuit endpoints are FACTORY ids. `path` is a required geometry
  // field on AddRoute (the probe descriptor omits it); the two pin positions
  // are the endpoints, exactly as phase2-empire draws a power line.
  await edit(request, [
    {
      type: "add_route",
      kind: { kind: "power" },
      from: gf,
      to: ls,
      path: [
        { x: -2600, y: 2400 },
        { x: -1600, y: 2400 },
      ],
    },
  ]);

  try {
    await page.goto("/");
    await expect(page.getByTestId("map-root")).toBeVisible();
    const skip = page.getByTestId("onboard-skip");
    if (await skip.isVisible().catch(() => false)) await skip.click();

    // Empire generation (nameplate fallback) — the CORRECT side of the mismatch.
    await expect(page.getByTestId("sb-power")).toContainText("400 MW");

    // TAB opens the audit drawer; POWER tab shows per-grid cards.
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("audit-drawer")).toBeVisible();
    await page.locator(".audit-tab", { hasText: "POWER" }).click();

    // The GRID card that lists GEO FARM must attribute the full 400 MW of
    // generation to the grid — same figure the empire status bar shows. Under
    // the bug this row reads "0 MW of 0 MW generated" / NO GEN because per-grid
    // generation sums solved __PowerMW out-rates, which are 0 for a recipe-less
    // generator (skipped by the material solve), while the empire total uses the
    // nameplate fallback.
    const gridCard = page.getByTestId("audit-drawer").locator(".audit-row", { hasText: "GEO FARM" });
    await expect(gridCard).toContainText("400 MW generated");
  } finally {
    await edit(request, [{ type: "delete_factory", id: gf }]).catch(() => {});
    await edit(request, [{ type: "delete_factory", id: ls }]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 2 — Coal-generator burn math end-to-end: 75 MW nameplate consumes
// exactly 15 coal/min.
//
// EXPECTED: Driving the generator to 75 MW pulls exactly 15 Desc_Coal_C/min on
// the input edge/port (75 x 60 / 300 MJ = 15) and the group produces 75
// __PowerMW. Doubling mwOut to 150 (2 generators' worth) pulls exactly 30
// coal/min. Pins MW*60/MJ burn synthesis through the solve.
// ---------------------------------------------------------------------------
test("coal generator burns exactly 15 coal/min per 75 MW", async ({ request }) => {
  await resetView(request);

  const pt = (
    await edit(request, [
      { type: "create_factory", name: "POWER TEST", position: { x: -2600, y: 2000 }, region: "GRASS FIELDS" },
    ])
  ).created[0];

  try {
    // Coal in-port (descriptor's `cap` is the AddPort `rateCeiling` field).
    const coalIn = (
      await edit(request, [
        {
          type: "add_port",
          factory: pt,
          direction: "in",
          item: "Desc_Coal_C",
          rate: 0,
          rateCeiling: 120,
          graphPos: { x: 0, y: 100 },
        },
      ])
    ).created[0];
    const mwOut = (
      await edit(request, [
        {
          type: "add_port",
          factory: pt,
          direction: "out",
          item: POWER,
          rate: 0,
          rateCeiling: null,
          graphPos: { x: 600, y: 100 },
        },
      ])
    ).created[0];
    const gen = (
      await edit(request, [
        {
          type: "add_group",
          factory: pt,
          machine: "Build_GeneratorCoal_C",
          recipe: "Recipe_Power_Build_GeneratorCoal_Desc_Coal_C",
          count: 1,
          clock: 1.0,
          graphPos: { x: 300, y: 100 },
          floor: 0,
        },
      ])
    ).created[0];
    const coalEdge = (
      await edit(request, [
        { type: "add_edge", factory: pt, from: P(coalIn), to: G(gen), item: "Desc_Coal_C", tier: 3 },
      ])
    ).created[0];
    await edit(request, [{ type: "add_edge", factory: pt, from: G(gen), to: P(mwOut), item: POWER, tier: 3 }]);

    // ---- drive the generator to 75 MW ----
    await edit(request, [{ type: "set_port_rate", id: mwOut, rate: 75 }]);
    let df = (await hydrate(request)).derived.factories[pt];
    expect(df.solveError).toBeNull();
    // 75 MW x 60s / 300 MJ per coal = 15 coal/min on the input edge and port.
    expect(df.edges[coalEdge].flow).toBeCloseTo(15, 3);
    expect(df.ports[coalIn]).toBeCloseTo(15, 3);
    // ...and the group produces exactly 75 __PowerMW.
    expect(df.groups[gen].outRates[POWER]).toBeCloseTo(75, 3);

    // ---- double the draw to 150 MW (2 generators' worth) ----
    await edit(request, [{ type: "set_port_rate", id: mwOut, rate: 150 }]);
    df = (await hydrate(request)).derived.factories[pt];
    expect(df.solveError).toBeNull();
    expect(df.edges[coalEdge].flow).toBeCloseTo(30, 3);
    expect(df.ports[coalIn]).toBeCloseTo(30, 3);
    expect(df.groups[gen].outRates[POWER]).toBeCloseTo(150, 3);
  } finally {
    await edit(request, [{ type: "delete_factory", id: pt }]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 3 — Variable-power recipe draw is per-recipe average, not the machine's
// fixed/zero draw.
//
// EXPECTED: With Recipe_Diamond_C the factory totalPowerMw = 500 MW
// (variable-power average 250 + 500/2), and with Recipe_DarkMatter_C on the same
// machine it = 1000 MW (500 + 1000/2) — the hungrier recipe beats the machine
// estimate. It must NOT read the machine's raw mPowerConsumption (~0) nor a fixed
// per-machine number.
// ---------------------------------------------------------------------------
test("hadron variable-power draw follows the recipe, not the machine", async ({ request }) => {
  await resetView(request);

  const ac = (
    await edit(request, [
      { type: "create_factory", name: "ACCEL", position: { x: -2600, y: 1600 }, region: "GRASS FIELDS" },
    ])
  ).created[0];

  try {
    // ---- Recipe_Diamond_C: 20 Coal -> 1 Diamond @ 2s. One machine @ clock 1
    // makes 30 Diamond/min. Drive the out-port at that single-machine rate so
    // the solve runs exactly count 1. Ample (uncapped) coal supply. ----
    const coalIn = (
      await edit(request, [
        { type: "add_port", factory: ac, direction: "in", item: "Desc_Coal_C", rate: 0, rateCeiling: null, graphPos: { x: 0, y: 100 } },
      ])
    ).created[0];
    const diamondOut = (
      await edit(request, [
        { type: "add_port", factory: ac, direction: "out", item: "Desc_Diamond_C", rate: 0, rateCeiling: null, graphPos: { x: 600, y: 100 } },
      ])
    ).created[0];
    const grp = (
      await edit(request, [
        {
          type: "add_group",
          factory: ac,
          machine: "Build_HadronCollider_C",
          recipe: "Recipe_Diamond_C",
          count: 1,
          clock: 1.0,
          graphPos: { x: 300, y: 100 },
          floor: 0,
        },
      ])
    ).created[0];
    const eCoal = (
      await edit(request, [
        { type: "add_edge", factory: ac, from: P(coalIn), to: G(grp), item: "Desc_Coal_C", tier: 3 },
      ])
    ).created[0];
    const eDiamond = (
      await edit(request, [
        { type: "add_edge", factory: ac, from: G(grp), to: P(diamondOut), item: "Desc_Diamond_C", tier: 3 },
      ])
    ).created[0];
    await edit(request, [{ type: "set_port_rate", id: diamondOut, rate: 30 }]);

    let df = (await hydrate(request)).derived.factories[ac];
    expect(df.solveError).toBeNull();
    // 250 constant + 500/2 factor = 500 MW at one machine, clock 1.
    expect(df.totalPowerMw).toBeCloseTo(500, 3);

    // ---- swap the recipe on the SAME machine to Recipe_DarkMatter_C
    // (1 Diamond -> 1 DarkMatter @ 2s ⇒ 30/min at one machine). Rewire to the
    // new recipe's items so the group stays demand-driven at count 1; the
    // recipe swap is the point, the plumbing just keeps it running. ----
    await edit(request, [
      { type: "delete_edge", id: eCoal },
      { type: "delete_edge", id: eDiamond },
    ]);
    await edit(request, [
      { type: "set_group_recipe", id: grp, machine: "Build_HadronCollider_C", recipe: "Recipe_DarkMatter_C" },
    ]);
    const diamondIn = (
      await edit(request, [
        { type: "add_port", factory: ac, direction: "in", item: "Desc_Diamond_C", rate: 0, rateCeiling: null, graphPos: { x: 0, y: 260 } },
      ])
    ).created[0];
    const dmOut = (
      await edit(request, [
        { type: "add_port", factory: ac, direction: "out", item: "Desc_DarkMatter_C", rate: 0, rateCeiling: null, graphPos: { x: 600, y: 260 } },
      ])
    ).created[0];
    await edit(request, [
      { type: "add_edge", factory: ac, from: P(diamondIn), to: G(grp), item: "Desc_Diamond_C", tier: 3 },
      { type: "add_edge", factory: ac, from: G(grp), to: P(dmOut), item: "Desc_DarkMatter_C", tier: 3 },
    ]);
    await edit(request, [{ type: "set_port_rate", id: dmOut, rate: 30 }]);

    df = (await hydrate(request)).derived.factories[ac];
    expect(df.solveError).toBeNull();
    // 500 constant + 1000/2 factor = 1000 MW — the hungrier recipe beats the
    // machine's 500 MW estimate and its ~0 raw mPowerConsumption.
    expect(df.totalPowerMw).toBeCloseTo(1000, 3);
  } finally {
    await edit(request, [{ type: "delete_factory", id: ac }]).catch(() => {});
  }
});

