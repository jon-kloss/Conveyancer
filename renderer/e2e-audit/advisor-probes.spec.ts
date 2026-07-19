// AUDIT area: advisor (opportunity engine /api/next + context serializer
// /api/context). Every probe declares its EXPECTED (correct) result in the
// header BEFORE any assertion; a failing probe is DATA for the mismatch
// protocol, not a reason to weaken the assert.
//
// Driven entirely through the dev bridge (API-only — the ranked payload and the
// context snapshot are both pure server derivations, so no page is needed).
// Seeded via /api/edit BEFORE reading /api/next or /api/context; every created
// factory is torn down in finally{}. NOTE: /api/next groups deficits EMPIRE-WIDE
// per item, so probes that assert an exact deficit_repair evidence string or the
// ABSENCE of a deficit_repair card (probes 3 & 4, and the copper card in probe 2)
// assume no OTHER live plan state starves the same item — true within this file
// (each test cleans up before the next) and requires the audit batch to run
// against a plan not concurrently starving Desc_CopperIngot_C / Desc_IronIngot_C.

import { test, expect, type APIRequestContext } from "@playwright/test";
import { resetView } from "../e2e/helpers";

test.describe.configure({ mode: "serial" });

// Deterministic boot — never inherit a dead predecessor's viewState.
test.beforeEach(async ({ request }) => resetView(request));

const API = "http://localhost:8791/api";

// The honest note the engine appends to a demoted power_deficit under
// ignore_power (opportunities.rs IGNORE_POWER_NOTE) — copied verbatim.
const IGNORE_POWER_NOTE = " — power ignored by preference — this grid is still overdrawn";

async function edit(request: APIRequestContext, cmds: unknown[]): Promise<{ created: string[] }> {
  const res = await request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
  if (!res.ok()) throw new Error(`edit ${res.status()}: ${await res.text()}`);
  return res.json();
}

interface Opportunity {
  id: string;
  kind: string;
  title: string;
  evidence: string;
  item?: string;
  action: { kind: string; item?: string; rate?: number; tab?: string; id?: string };
}

async function nextMoves(request: APIRequestContext): Promise<Opportunity[]> {
  const res = await request.get(`${API}/next`);
  if (!res.ok()) throw new Error(`next ${res.status()}: ${await res.text()}`);
  return ((await res.json()) as { opportunities: Opportunity[] }).opportunities;
}

async function setPrefs(
  request: APIRequestContext,
  prefs: { noTrains: boolean; ignorePower: boolean },
): Promise<void> {
  const res = await request.post(`${API}/next/preferences`, { data: JSON.stringify(prefs) });
  if (!res.ok()) throw new Error(`prefs ${res.status()}: ${await res.text()}`);
}

async function context(request: APIRequestContext, scope: unknown): Promise<unknown> {
  const res = await request.post(`${API}/context`, { data: JSON.stringify(scope) });
  if (!res.ok()) throw new Error(`context ${res.status()}: ${await res.text()}`);
  return ((await res.json()) as { payload: unknown }).payload;
}

// ---- shared seed builders (same command surface the UI uses) ----
const mkFactory = async (
  request: APIRequestContext,
  name: string,
  x: number,
  y: number,
): Promise<string> =>
  (await edit(request, [{ type: "create_factory", name, position: { x, y }, region: "GRASS FIELDS" }]))
    .created[0];

const addPort = async (
  request: APIRequestContext,
  factory: string,
  direction: "in" | "out",
  item: string,
  rateCeiling: number | null,
  x: number,
): Promise<string> =>
  (
    await edit(request, [
      { type: "add_port", factory, direction, item, rate: 0, rateCeiling, graphPos: { x, y: 100 } },
    ])
  ).created[0];

const addGroup = async (
  request: APIRequestContext,
  factory: string,
  machine: string,
  recipe: string,
  count: number,
): Promise<string> =>
  (
    await edit(request, [
      { type: "add_group", factory, machine, recipe, count, clock: 1.0, graphPos: { x: 300, y: 100 }, floor: 0 },
    ])
  ).created[0];

const belt = (
  request: APIRequestContext,
  factory: string,
  from: unknown,
  to: unknown,
  item: string,
  tier = 5,
): Promise<{ created: string[] }> => edit(request, [{ type: "add_edge", factory, from, to, item, tier }]);

const setRate = (request: APIRequestContext, id: string, rate: number): Promise<{ created: string[] }> =>
  edit(request, [{ type: "set_port_rate", id, rate }]);

const G = (id: string) => ({ kind: "group", id });
const P = (id: string) => ({ kind: "port", id });

// ---------------------------------------------------------------------------
// PROBE 1 — SELECTION-scope context resolves a non-factory selection (route).
//
// EXPECTED: POST /api/context {"scope":"selection","id":<routeId>} returns a
// ContextSnapshot whose payload describes the SELECTED ROUTE — carrying its id
// (and ideally kind/endpoints), or AT MINIMUM a non-null subject for scope
// 'selection'. It must NOT be the all-null factory object
// {"scope":"factory","factory":null,"groups":null,"ports":null,"derived":null}.
// (Current code routes Selection through the Factory arm and does
// state.factories.get(routeId) — a miss — so it returns exactly that null
// object; the route id never appears → this probe FAILS, confirming the bug.)
// ---------------------------------------------------------------------------
test("SELECTION-scope context resolves a selected route, not an all-null factory", async ({
  request,
}) => {
  const f1 = await mkFactory(request, "AUDIT P1 F1", 8800, 8200);
  const f2 = await mkFactory(request, "AUDIT P1 F2", 9400, 8200);
  try {
    const outPort = await addPort(request, f1, "out", "Desc_CopperIngot_C", null, 600);
    const inPort = await addPort(request, f2, "in", "Desc_CopperIngot_C", null, 0);
    const routeId = (
      await edit(request, [
        {
          type: "add_route",
          kind: { kind: "belt", tier: 5 },
          from: outPort,
          to: inPort,
          path: [
            { x: 8800, y: 8200 },
            { x: 9400, y: 8200 },
          ],
        },
      ])
    ).created[0];
    expect(routeId).toBeTruthy();

    const payload = await context(request, { scope: "selection", id: routeId });

    // The selected route's identity must survive into the snapshot.
    const allNullFactory = {
      scope: "factory",
      factory: null,
      groups: null,
      ports: null,
      derived: null,
    };
    expect(payload).not.toEqual(allNullFactory);
    // A route-describing snapshot names the route it was asked about.
    expect(JSON.stringify(payload)).toContain(routeId);
  } finally {
    await edit(request, [
      { type: "delete_factory", id: f1 },
      { type: "delete_factory", id: f2 },
    ]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 2 — IGNORE POWER demotes power_deficit below deficit_repair, adds the
// honest note, and hides power_margin.
//
// EXPECTED (default prefs): opportunities contain a kind==='power_deficit' card
// (the overdrawn grid), a kind==='power_margin' card (the thin grid), and a
// deficit_repair:Desc_CopperIngot_C card (the starved copper chain); EVERY
// power_deficit (class 0) ranks above EVERY deficit_repair (class 1) → the last
// power_deficit index < the first deficit_repair index.
// EXPECTED (ignorePower=true): NO kind==='power_margin' card remains; the
// power_deficit card still exists and its evidence ends with the exact suffix
// ' — power ignored by preference — this grid is still overdrawn'; and the
// power_deficit is demoted to class 3, so the deficit_repair:Desc_CopperIngot_C
// index is now < every power_deficit index.
// ---------------------------------------------------------------------------
test("ignorePower demotes power_deficit, appends the note, and hides power_margin", async ({
  request,
}) => {
  const created: string[] = [];
  try {
    // (1) OVERDRAWN grid: GEN1 drives 30 MW; LOAD1 draws 64 MW (16x smelter @ 4).
    const gen1 = await mkFactory(request, "AUDIT OD GEN", 7000, 7000);
    created.push(gen1);
    const gen1Coal = await addPort(request, gen1, "in", "Desc_Coal_C", 480, 0);
    const gen1Mw = await addPort(request, gen1, "out", "__PowerMW", null, 600);
    const gen1G = await addGroup(
      request,
      gen1,
      "Build_GeneratorCoal_C",
      "Recipe_Power_Build_GeneratorCoal_Desc_Coal_C",
      2,
    );
    await belt(request, gen1, P(gen1Coal), G(gen1G), "Desc_Coal_C");
    await belt(request, gen1, G(gen1G), P(gen1Mw), "__PowerMW");
    await setRate(request, gen1Mw, 30);

    const load1 = await mkFactory(request, "AUDIT OD LOAD", 7600, 7000);
    created.push(load1);
    const load1Ore = await addPort(request, load1, "in", "Desc_OreIron_C", 480, 0);
    const load1Out = await addPort(request, load1, "out", "Desc_IronIngot_C", null, 600);
    const load1G = await addGroup(request, load1, "Build_SmelterMk1_C", "Recipe_IngotIron_C", 16);
    await belt(request, load1, P(load1Ore), G(load1G), "Desc_OreIron_C");
    await belt(request, load1, G(load1G), P(load1Out), "Desc_IronIngot_C");
    await setRate(request, load1Out, 480);
    await edit(request, [
      { type: "add_route", kind: { kind: "power" }, from: gen1, to: load1, path: [{ x: 7000, y: 7000 }, { x: 7600, y: 7000 }] },
    ]);

    // (2) THIN grid: GEN2 drives 75 MW; LOAD2 draws 64 MW → ~14% headroom (warn).
    const gen2 = await mkFactory(request, "AUDIT THIN GEN", 7000, 7600);
    created.push(gen2);
    const gen2Coal = await addPort(request, gen2, "in", "Desc_Coal_C", 480, 0);
    const gen2Mw = await addPort(request, gen2, "out", "__PowerMW", null, 600);
    const gen2G = await addGroup(
      request,
      gen2,
      "Build_GeneratorCoal_C",
      "Recipe_Power_Build_GeneratorCoal_Desc_Coal_C",
      2,
    );
    await belt(request, gen2, P(gen2Coal), G(gen2G), "Desc_Coal_C");
    await belt(request, gen2, G(gen2G), P(gen2Mw), "__PowerMW");
    await setRate(request, gen2Mw, 75);

    const load2 = await mkFactory(request, "AUDIT THIN LOAD", 7600, 7600);
    created.push(load2);
    const load2Ore = await addPort(request, load2, "in", "Desc_OreIron_C", 480, 0);
    const load2Out = await addPort(request, load2, "out", "Desc_IronIngot_C", null, 600);
    const load2G = await addGroup(request, load2, "Build_SmelterMk1_C", "Recipe_IngotIron_C", 16);
    await belt(request, load2, P(load2Ore), G(load2G), "Desc_OreIron_C");
    await belt(request, load2, G(load2G), P(load2Out), "Desc_IronIngot_C");
    await setRate(request, load2Out, 480);
    await edit(request, [
      { type: "add_route", kind: { kind: "power" }, from: gen2, to: load2, path: [{ x: 7000, y: 7600 }, { x: 7600, y: 7600 }] },
    ]);

    // (3) STARVED copper chain: producer ships copper ingots to a wire line, then
    // the producer output dips → an honest empire-wide copper-ingot deficit.
    const bay = await mkFactory(request, "AUDIT COPPER BAY", 7000, 8200);
    created.push(bay);
    const bayOre = await addPort(request, bay, "in", "Desc_OreCopper_C", 480, 0);
    const bayOut = await addPort(request, bay, "out", "Desc_CopperIngot_C", null, 600);
    const bayG = await addGroup(request, bay, "Build_SmelterMk1_C", "Recipe_IngotCopper_C", 8);
    await belt(request, bay, P(bayOre), G(bayG), "Desc_OreCopper_C");
    await belt(request, bay, G(bayG), P(bayOut), "Desc_CopperIngot_C");
    await setRate(request, bayOut, 240);

    const gulch = await mkFactory(request, "AUDIT WIRE GULCH", 7600, 8200);
    created.push(gulch);
    const gulchIn = await addPort(request, gulch, "in", "Desc_CopperIngot_C", null, 0);
    const gulchOut = await addPort(request, gulch, "out", "Desc_Wire_C", null, 600);
    const gulchG = await addGroup(request, gulch, "Build_ConstructorMk1_C", "Recipe_Wire_C", 16);
    await belt(request, gulch, P(gulchIn), G(gulchG), "Desc_CopperIngot_C");
    await belt(request, gulch, G(gulchG), P(gulchOut), "Desc_Wire_C");
    await edit(request, [
      { type: "add_route", kind: { kind: "belt", tier: 4 }, from: bayOut, to: gulchIn, path: [{ x: 7000, y: 8200 }, { x: 7600, y: 8200 }] },
    ]);
    await setRate(request, gulchOut, 480);
    await setRate(request, bayOut, 10); // the dip → copper-ingot deficit

    // ---- default prefs: family presence + class order ----
    await setPrefs(request, { noTrains: false, ignorePower: false });
    const before = await nextMoves(request);

    const hasPowerDeficitBefore = before.some((o) => o.kind === "power_deficit");
    const hasPowerMarginBefore = before.some((o) => o.kind === "power_margin");
    expect(hasPowerDeficitBefore, "overdrawn grid must fire power_deficit").toBe(true);
    expect(hasPowerMarginBefore, "thin grid must fire power_margin").toBe(true);
    const copperIdxBefore = before.findIndex((o) => o.id === "deficit_repair:Desc_CopperIngot_C");
    expect(copperIdxBefore, "starved copper chain must fire deficit_repair").toBeGreaterThanOrEqual(0);

    // class 0 (power_deficit) ranks above class 1 (deficit_repair): every
    // power_deficit precedes the first deficit_repair.
    const lastPowerDeficitBefore = before.map((o) => o.kind).lastIndexOf("power_deficit");
    const firstDeficitRepairBefore = before.findIndex((o) => o.kind === "deficit_repair");
    expect(lastPowerDeficitBefore).toBeLessThan(firstDeficitRepairBefore);

    // ---- ignorePower=true: demote + note + hide margin ----
    await setPrefs(request, { noTrains: false, ignorePower: true });
    const after = await nextMoves(request);

    // the advisory margin card is hidden entirely.
    expect(after.some((o) => o.kind === "power_margin"), "power_margin hidden under ignorePower").toBe(false);

    // the overdraw FACT survives, now carrying the honest note.
    const powerDeficitsAfter = after.filter((o) => o.kind === "power_deficit");
    expect(powerDeficitsAfter.length, "power_deficit is never suppressed").toBeGreaterThan(0);
    for (const pd of powerDeficitsAfter) {
      expect(pd.evidence.endsWith(IGNORE_POWER_NOTE)).toBe(true);
    }

    // demotion to class 3: the copper repair (class 1) now ranks ABOVE every
    // demoted power_deficit.
    const copperIdxAfter = after.findIndex((o) => o.id === "deficit_repair:Desc_CopperIngot_C");
    const firstPowerDeficitAfter = after.findIndex((o) => o.kind === "power_deficit");
    expect(copperIdxAfter, "copper repair still present after toggle").toBeGreaterThanOrEqual(0);
    expect(firstPowerDeficitAfter).toBeGreaterThanOrEqual(0);
    expect(copperIdxAfter).toBeLessThan(firstPowerDeficitAfter);
  } finally {
    await setPrefs(request, { noTrains: false, ignorePower: false }).catch(() => {});
    for (const id of created) {
      await edit(request, [{ type: "delete_factory", id }]).catch(() => {});
    }
  }
});

// ---------------------------------------------------------------------------
// PROBE 3 — route_bottleneck_fix names the SMALLEST sufficient belt tier for a
// transport-capped starve.
//
// EXPECTED: opportunities contain a kind==='route_bottleneck_fix' card for this
// Mk.1 route whose title contains 'bump it to Mk.2' (smallest belt tier with
// capacity >= flow+recoverable = 60+40 = 100 is Mk.2 @ 120) and whose evidence
// is exactly '60.0/60.0 per min at 100% with 40.0/min recoverable through it'.
// There is NO deficit_repair:Desc_CopperIngot_C card — the producer makes the
// full 100/min copper demand, so the production gap is 0 (the miss is pure
// transport, owned by the route card).
// ---------------------------------------------------------------------------
test("route_bottleneck_fix names the smallest sufficient tier (Mk.2) for a capped starve", async ({
  request,
}) => {
  await setPrefs(request, { noTrains: false, ignorePower: false });
  const prod = await mkFactory(request, "AUDIT P3 PROD", 8800, 7000);
  const sink = await mkFactory(request, "AUDIT P3 SINK", 9400, 7000);
  try {
    // PROD: 8 smelters can make 240 copper ingot; driven to 100 (blind to belt).
    const prodOre = await addPort(request, prod, "in", "Desc_OreCopper_C", 480, 0);
    const prodOut = await addPort(request, prod, "out", "Desc_CopperIngot_C", null, 600);
    const prodG = await addGroup(request, prod, "Build_SmelterMk1_C", "Recipe_IngotCopper_C", 8);
    await belt(request, prod, P(prodOre), G(prodG), "Desc_OreCopper_C");
    await belt(request, prod, G(prodG), P(prodOut), "Desc_CopperIngot_C");
    await setRate(request, prodOut, 100);

    // SINK: 16 constructors of wire; 200 wire/min → 100 copper-ingot demand.
    const sinkIn = await addPort(request, sink, "in", "Desc_CopperIngot_C", null, 0);
    const sinkOut = await addPort(request, sink, "out", "Desc_Wire_C", null, 600);
    const sinkG = await addGroup(request, sink, "Build_ConstructorMk1_C", "Recipe_Wire_C", 16);
    await belt(request, sink, P(sinkIn), G(sinkG), "Desc_CopperIngot_C");
    await belt(request, sink, G(sinkG), P(sinkOut), "Desc_Wire_C");
    await setRate(request, sinkOut, 200);

    // Mk.1 belt route (cap 60) → 100/min demand cannot flow.
    const routeId = (
      await edit(request, [
        {
          type: "add_route",
          kind: { kind: "belt", tier: 1 },
          from: prodOut,
          to: sinkIn,
          path: [{ x: 8800, y: 7000 }, { x: 9400, y: 7000 }],
        },
      ])
    ).created[0];

    const opps = await nextMoves(request);

    const card = opps.find((o) => o.id === `route_bottleneck_fix:${routeId}`);
    expect(card, "capped Mk.1 route must fire route_bottleneck_fix").toBeTruthy();
    expect(card!.kind).toBe("route_bottleneck_fix");
    expect(card!.title).toContain("bump it to Mk.2");
    expect(card!.evidence).toBe("60.0/60.0 per min at 100% with 40.0/min recoverable through it");
    expect(card!.action.kind).toBe("selectRoute");

    // production_gap is 0 → the deficit-repair family is correctly silent here.
    expect(opps.some((o) => o.id === "deficit_repair:Desc_CopperIngot_C")).toBe(false);
  } finally {
    await edit(request, [
      { type: "delete_factory", id: prod },
      { type: "delete_factory", id: sink },
    ]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 4 — deficit_repair names an already-full contributing route when the
// miss is production, not transport.
//
// EXPECTED: opportunities contain deficit_repair:Desc_IronIngot_C with
// action.kind==='wizardGoal', action.rate===40, and evidence exactly
// 'need 100.0/min, supplied 60.0/min across 1 port(s); the Mk.1 route is already
// full — upgrading it is also required once production rises'. There is NO
// route_bottleneck_fix card for this route — the transport gap is 0 (the
// producer makes only the belt cap), so recoverable is 0 and the route-fix
// family is correctly gated out.
// ---------------------------------------------------------------------------
test("deficit_repair names the already-full route when the miss is production", async ({
  request,
}) => {
  await setPrefs(request, { noTrains: false, ignorePower: false });
  const prod = await mkFactory(request, "AUDIT P4 PROD", 8800, 7600);
  const sink = await mkFactory(request, "AUDIT P4 SINK", 9400, 7600);
  try {
    // PROD: 8 smelters can make 240 iron ingot; driven to exactly 60 (the Mk.1 cap).
    const prodOre = await addPort(request, prod, "in", "Desc_OreIron_C", 480, 0);
    const prodOut = await addPort(request, prod, "out", "Desc_IronIngot_C", null, 600);
    const prodG = await addGroup(request, prod, "Build_SmelterMk1_C", "Recipe_IngotIron_C", 8);
    await belt(request, prod, P(prodOre), G(prodG), "Desc_OreIron_C");
    await belt(request, prod, G(prodG), P(prodOut), "Desc_IronIngot_C");
    await setRate(request, prodOut, 60);

    // SINK: 16 constructors of iron rod; 100 rod/min → 100 iron-ingot demand.
    const sinkIn = await addPort(request, sink, "in", "Desc_IronIngot_C", null, 0);
    const sinkOut = await addPort(request, sink, "out", "Desc_IronRod_C", null, 600);
    const sinkG = await addGroup(request, sink, "Build_ConstructorMk1_C", "Recipe_IronRod_C", 16);
    await belt(request, sink, P(sinkIn), G(sinkG), "Desc_IronIngot_C");
    await belt(request, sink, G(sinkG), P(sinkOut), "Desc_IronRod_C");
    await setRate(request, sinkOut, 100);

    // Mk.1 belt route (cap 60): full, but production is the true shortfall.
    const routeId = (
      await edit(request, [
        {
          type: "add_route",
          kind: { kind: "belt", tier: 1 },
          from: prodOut,
          to: sinkIn,
          path: [{ x: 8800, y: 7600 }, { x: 9400, y: 7600 }],
        },
      ])
    ).created[0];

    const opps = await nextMoves(request);

    const card = opps.find((o) => o.id === "deficit_repair:Desc_IronIngot_C");
    expect(card, "production shortfall must fire deficit_repair").toBeTruthy();
    expect(card!.action.kind).toBe("wizardGoal");
    expect(card!.action.rate).toBe(40);
    expect(card!.evidence).toBe(
      "need 100.0/min, supplied 60.0/min across 1 port(s); the Mk.1 route is already full — upgrading it is also required once production rises",
    );

    // transport_gap is 0 → recoverable 0 → the route-fix family is gated out.
    expect(opps.some((o) => o.id === `route_bottleneck_fix:${routeId}`)).toBe(false);
  } finally {
    await edit(request, [
      { type: "delete_factory", id: prod },
      { type: "delete_factory", id: sink },
    ]).catch(() => {});
  }
});
