// AUDIT area: session/derive (crates/app/src/session.rs) — the whole-empire
// derive: deficit accounting, derive determinism, per-factory solve-error
// isolation, and power-grid generation attribution for a DRIVEN (un-wired)
// generator. Every probe declares its EXPECTED (correct) result in the header
// BEFORE any assertion; a failing probe is data for the mismatch protocol, NOT
// a reason to weaken the assert. Seeded through the same command surface the UI
// uses, against the dev bridge's default fixture catalog:
//   Recipe_IngotIron_C   = 1 ore    -> 1 ingot @ 2s => 30/min per machine
//   Recipe_IngotCopper_C = 1 ore    -> 1 ingot @ 2s => 30/min per machine
//   Recipe_IronRod_C     = 1 ingot  -> 1 rod   @ 4s => 15/min per machine
//   Recipe_Wire_C        = 1 copper -> 2 wire  @ 4s => 15 copper/min, 30 wire/min
//   Build_GeneratorCoal_C = 75 MW nameplate, fuel Desc_Coal_C (burn recipe
//     Recipe_Power_Build_GeneratorCoal_Desc_Coal_C, products [(__PowerMW,75)])
// Belt Mk.1 caps a route at 60/min.
//
// These probes read the whole-empire derive through GET /api/hydrate, which
// solves every factory with T0Edit::Recompute (see Session::solve_all_readonly)
// — no page/UI is involved, so they run against `request` alone.

import { test, expect, type APIRequestContext } from "@playwright/test";
import { resetView } from "../e2e/helpers";

test.describe.configure({ mode: "serial" });

const API = "http://localhost:8791/api";

async function edit(request: APIRequestContext, cmds: unknown[]): Promise<{ created: string[] }> {
  const res = await request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
  if (!res.ok()) throw new Error(`edit ${res.status()}: ${await res.text()}`);
  return res.json();
}
// Non-throwing variant: returns the raw response so a probe can assert the
// STATUS itself (probe 3 needs to prove the edit path stays 200 across a
// broken factory rather than 500-ing the whole empire).
async function editRaw(request: APIRequestContext, cmds: unknown[]) {
  return request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
}
async function hydrate(request: APIRequestContext): Promise<any> {
  const res = await request.get(`${API}/hydrate`);
  if (!res.ok()) throw new Error(`hydrate ${res.status()}: ${await res.text()}`);
  return res.json();
}

const P = (id: string) => ({ kind: "port", id });
const G = (id: string) => ({ kind: "group", id });
const mk = async (request: APIRequestContext, name: string, x: number, y: number) =>
  (await edit(request, [{ type: "create_factory", name, position: { x, y }, region: "GRASS FIELDS" }])).created[0];
const port = async (
  request: APIRequestContext,
  factory: string,
  direction: string,
  item: string,
  ceiling: number | null,
  x: number,
  y = 100,
) =>
  (await edit(request, [{ type: "add_port", factory, direction, item, rate: 0, rateCeiling: ceiling, graphPos: { x, y } }]))
    .created[0];
const group = async (
  request: APIRequestContext,
  factory: string,
  machine: string,
  recipe: string,
  count = 1,
  x = 300,
  y = 100,
) => (await edit(request, [{ type: "add_group", factory, machine, recipe, count, clock: 1.0, graphPos: { x, y }, floor: 0 }])).created[0];
const belt = (request: APIRequestContext, factory: string, from: unknown, to: unknown, item: string, tier = 3) =>
  edit(request, [{ type: "add_edge", factory, from, to, item, tier }]);

const deficitFor = (h: any, portId: string) =>
  (h.derived.deficits as any[]).find((d) => d.port === portId);

// ---------------------------------------------------------------------------
// PROBE 1 — Multi-output deficit `needed` is independent of an unrelated
// output's target.
//
// EXPECTED (correct behavior): N2 == N1 (byte-equal within 1e-6): B's required
// copper intake through inY depends only on B's target and recipe, never on
// output A's target. (Current code computes needed = flow*requested/max_rate
// with requested = A's rate, so N2 ≈ 2*N1 — the probe fails and localizes to
// session.rs ~line 2148.)
//
// CHANNEL NOTE (documented, do NOT weaken): the descriptor reads `needed`
// through GET /api/hydrate, which derives every factory with Recompute. A
// factory with TWO output targets takes the Recompute path (no edited port),
// so t1 never sets `target_ceiling` and the deficit is attributed through the
// DEGRADED (shortfall) channel — `needed` comes from the memoized canonical
// probe solve, which is inherently independent of A. The `requested` find_map
// bug at ~2148 is only reached on the CLAMPED channel (a SetTarget edit-
// response deficit), so through the specified hydrate DRIVE this invariant is
// expected to hold (probe green). We still assert N2 == N1 verbatim; a red here
// would be a genuine cross-output leak.
// ---------------------------------------------------------------------------
test("multi-output deficit needed is independent of an unrelated output target", async ({ request }) => {
  await resetView(request);
  const f = await mk(request, "SESSION MULTI-OUT", -2600, 2600);
  const src = await mk(request, "SESSION COPPER SRC", -3400, 2600);
  try {
    // ---- F: output A (rod, created FIRST) fed by an uncapped iron-ingot input
    //         so A can hit 100/min and never itself deficits ----
    const inIron = await port(request, f, "in", "Desc_IronIngot_C", null, 0, 60);
    const outA = await port(request, f, "out", "Desc_IronRod_C", null, 640, 60); // A: FIRST out port
    const rod = await group(request, f, "Build_ConstructorMk1_C", "Recipe_IronRod_C", 20, 320, 60);
    await belt(request, f, P(inIron), G(rod), "Desc_IronIngot_C");
    await belt(request, f, G(rod), P(outA), "Desc_IronRod_C");
    // ---- F: input inY (copper) + output B (wire) via Recipe_Wire_C ----
    const inY = await port(request, f, "in", "Desc_CopperIngot_C", null, 0, 220);
    const outB = await port(request, f, "out", "Desc_Wire_C", null, 640, 220);
    const wire = await group(request, f, "Build_ConstructorMk1_C", "Recipe_Wire_C", 20, 320, 220);
    await belt(request, f, P(inY), G(wire), "Desc_CopperIngot_C");
    await belt(request, f, G(wire), P(outB), "Desc_Wire_C");

    // ---- SRC: ore -> copper ingot, exported and route-capped to F.inY ----
    const oreIn = await port(request, src, "in", "Desc_OreCopper_C", null, 0);
    const copperOut = await port(request, src, "out", "Desc_CopperIngot_C", null, 640);
    const smelt = await group(request, src, "Build_SmelterMk1_C", "Recipe_IngotCopper_C", 10);
    await belt(request, src, P(oreIn), G(smelt), "Desc_OreCopper_C");
    await belt(request, src, G(smelt), P(copperOut), "Desc_CopperIngot_C");
    await edit(request, [{ type: "set_port_rate", id: copperOut, rate: 120 }]);
    // Belt Mk.1 caps SRC.out -> F.inY at 60/min copper — well below B's demand.
    await edit(request, [
      {
        type: "add_route",
        kind: { kind: "belt", tier: 1 },
        from: copperOut,
        to: inY,
        path: [{ x: -3400, y: 2600 }, { x: -2600, y: 2600 }],
      },
    ]);

    // (4) A=100, B=480 (480 wire needs 240 copper/min — copper is capped at 60).
    await edit(request, [{ type: "set_port_rate", id: outA, rate: 100 }]);
    await edit(request, [{ type: "set_port_rate", id: outB, rate: 480 }]);
    const h1 = await hydrate(request);
    const d1 = deficitFor(h1, inY);
    expect(d1, "inY must be in deficit — copper is route-capped below B's demand").toBeTruthy();
    const N1 = d1.needed as number;

    // (5) bump only A to 200 — B untouched.
    await edit(request, [{ type: "set_port_rate", id: outA, rate: 200 }]);
    const h2 = await hydrate(request);
    const d2 = deficitFor(h2, inY);
    expect(d2, "inY must still be in deficit after A's target changes").toBeTruthy();
    const N2 = d2.needed as number;

    // EXPECTED: B's copper intake need is unmoved by A's target.
    expect(Math.abs(N2 - N1)).toBeLessThanOrEqual(1e-6);
  } finally {
    await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
    await edit(request, [{ type: "delete_factory", id: src }]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 2 — Whole-empire derive is deterministic (same plan → same derived,
// modulo timing fields).
//
// EXPECTED: The two stripped `derived` payloads are structurally identical:
// identical factory/route/circuit key sets, identical deficit Vec order and
// numeric values, identical circuit Vec order and GRID letter names, identical
// total_generation_mw / total_power_mw. Any difference (e.g. a HashMap-ordered
// field or a name that renumbers) is a determinism defect.
// ---------------------------------------------------------------------------
test("whole-empire derive is deterministic across two hydrates", async ({ request }) => {
  await resetView(request);
  // 3 factories + 1 belt route + 1 power route.
  const a1 = await mk(request, "DET INGOT", -2600, 2400);
  const a2 = await mk(request, "DET ROD", -1000, 2400);
  const a3 = await mk(request, "DET COAL", -1800, 1200);
  try {
    // a1: iron ore -> ingot, exported.
    const oreIn = await port(request, a1, "in", "Desc_OreIron_C", null, 0);
    const ingotOut = await port(request, a1, "out", "Desc_IronIngot_C", null, 640);
    const smelt = await group(request, a1, "Build_SmelterMk1_C", "Recipe_IngotIron_C", 2);
    await belt(request, a1, P(oreIn), G(smelt), "Desc_OreIron_C");
    await belt(request, a1, G(smelt), P(ingotOut), "Desc_IronIngot_C");
    await edit(request, [{ type: "set_port_rate", id: ingotOut, rate: 30 }]);
    // a2: ingot -> rod.
    const ingotIn = await port(request, a2, "in", "Desc_IronIngot_C", null, 0);
    const rodOut = await port(request, a2, "out", "Desc_IronRod_C", null, 640);
    const ctor = await group(request, a2, "Build_ConstructorMk1_C", "Recipe_IronRod_C", 2);
    await belt(request, a2, P(ingotIn), G(ctor), "Desc_IronIngot_C");
    await belt(request, a2, G(ctor), P(rodOut), "Desc_IronRod_C");
    await edit(request, [{ type: "set_port_rate", id: rodOut, rate: 30 }]);
    // a3: coal generator wired to a __PowerMW out port (a real generation site).
    const coalIn = await port(request, a3, "in", "Desc_Coal_C", 480, 0);
    const mwOut = await port(request, a3, "out", "__PowerMW", null, 640);
    const gens = await group(request, a3, "Build_GeneratorCoal_C", "Recipe_Power_Build_GeneratorCoal_Desc_Coal_C", 2);
    await belt(request, a3, P(coalIn), G(gens), "Desc_Coal_C");
    await belt(request, a3, G(gens), P(mwOut), "__PowerMW");
    await edit(request, [{ type: "set_port_rate", id: mwOut, rate: 150 }]);
    // belt a1 -> a2 (ingot), power a3 -> a2.
    await edit(request, [
      {
        type: "add_route",
        kind: { kind: "belt", tier: 3 },
        from: ingotOut,
        to: ingotIn,
        path: [{ x: -2600, y: 2400 }, { x: -1000, y: 2400 }],
      },
      {
        type: "add_route",
        kind: { kind: "power" },
        from: a3,
        to: a2,
        path: [{ x: -1800, y: 1200 }, { x: -1000, y: 2400 }],
      },
    ]);

    // Recursively delete wall-clock fields (camelCase per serde rename_all).
    const TIMING = new Set(["recomputeUs", "solveUs", "solveOnRelease", "recompute_us", "solve_us", "solve_on_release"]);
    const strip = (v: any): any => {
      if (Array.isArray(v)) return v.map(strip);
      if (v && typeof v === "object") {
        const out: Record<string, any> = {};
        for (const [k, val] of Object.entries(v)) if (!TIMING.has(k)) out[k] = strip(val);
        return out;
      }
      return v;
    };

    const d1 = strip((await hydrate(request)).derived);
    const d2 = strip((await hydrate(request)).derived); // NO intervening edit
    // Deep structural equality: factories/edges/ports/routes/deficits (order +
    // values), circuits (order + GRID names), generation/demand MW, totals.
    expect(d2).toEqual(d1);
    // Belt-and-braces on the fields the descriptor calls out explicitly.
    expect(d2.total_generation_mw ?? d2.totalGenerationMw).toEqual(d1.total_generation_mw ?? d1.totalGenerationMw);
    expect((d2.circuits as any[]).map((c) => c.name)).toEqual((d1.circuits as any[]).map((c) => c.name));
    expect((d2.deficits as any[]).map((x) => `${x.port}:${x.needed}`)).toEqual(
      (d1.deficits as any[]).map((x) => `${x.port}:${x.needed}`),
    );
  } finally {
    for (const id of [a1, a2, a3]) await edit(request, [{ type: "delete_factory", id }]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 3 — Per-factory solve error is isolated: one un-solvable factory does
// not blank the rest, and /api/edit still returns 200.
//
// EXPECTED: The edit responses are HTTP 200 throughout (no whole-empire
// failure). derived.factories[G].solveError is a non-null string;
// derived.factories[G].ports is empty. derived.factories[H] is unaffected:
// solveError null and its out-port rate equals the value it solved to before G
// was added. If instead adding G empties/zeros H's rates or the edit 500s,
// isolation is broken (session.rs error_factory + feed_downstream-with-empty-
// ports path).
//
// BREAK-MECHANISM NOTE (documented substitution): the descriptor's two example
// breakers are both inert here — an internal edge cycle solves to zero under
// the elastic T1 LP (no error; no DAG requirement in t1), and an edge to a
// missing node is rejected at command validation (require_edge_end → NotFound,
// which would 500 the SEEDING edit, not produce a stored broken factory). We
// therefore drive G through the same error_factory path deterministically: a
// factory whose ONLY group carries an unresolvable recipe. snapshot() skips the
// unknown-recipe group, leaving groups+edges empty, so empire_solve inserts
// error_factory("no machine groups yet") — solveError set, ports empty — while
// the loop continues to solve H. This is the exact isolation invariant the
// probe names.
// ---------------------------------------------------------------------------
test("a broken factory is isolated: H unaffected and every edit stays 200", async ({ request }) => {
  await resetView(request);
  const h = await mk(request, "SESSION HEALTHY", -2600, 2000);
  let g = "";
  try {
    // ---- HEALTHY H: ore -> ingot, target 30/min ----
    const oreIn = await port(request, h, "in", "Desc_OreIron_C", null, 0);
    const ingotOut = await port(request, h, "out", "Desc_IronIngot_C", null, 640);
    const smelt = await group(request, h, "Build_SmelterMk1_C", "Recipe_IngotIron_C", 1);
    await belt(request, h, P(oreIn), G(smelt), "Desc_OreIron_C");
    await belt(request, h, G(smelt), P(ingotOut), "Desc_IronIngot_C");
    await edit(request, [{ type: "set_port_rate", id: ingotOut, rate: 30 }]);

    const before = await hydrate(request);
    const hRateBefore = before.derived.factories[h].ports[ingotOut] as number;
    expect(hRateBefore).toBeCloseTo(30, 6); // H solves its target before G exists
    expect(before.derived.factories[h].solveError ?? null).toBeNull();

    // ---- BROKEN G: its ONLY group has an unresolvable recipe (edit stays 200) ----
    const gRes = await editRaw(request, [{ type: "create_factory", name: "SESSION BROKEN", position: { x: -1000, y: 2000 }, region: "GRASS FIELDS" }]);
    expect(gRes.status()).toBe(200);
    g = (await gRes.json()).created[0];
    const addGroupRes = await editRaw(request, [
      { type: "add_group", factory: g, machine: "Build_ConstructorMk1_C", recipe: "Recipe_DoesNotExist_C", count: 1, clock: 1.0, graphPos: { x: 300, y: 100 }, floor: 0 },
    ]);
    expect(addGroupRes.status()).toBe(200); // no whole-empire failure

    const after = await hydrate(request);
    // G errored, isolated: non-null solveError, empty ports.
    const dg = after.derived.factories[g];
    expect(typeof dg.solveError).toBe("string");
    expect(dg.solveError.length).toBeGreaterThan(0);
    expect(Object.keys(dg.ports)).toHaveLength(0);
    // H is untouched: still no error, still solving its 30/min target.
    const dh = after.derived.factories[h];
    expect(dh.solveError ?? null).toBeNull();
    expect(dh.ports[ingotOut] as number).toBeCloseTo(hRateBefore, 6);
  } finally {
    await edit(request, [{ type: "delete_factory", id: h }]).catch(() => {});
    if (g) await edit(request, [{ type: "delete_factory", id: g }]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 4 — An un-wired (driven) fuelled generator contributes to its power
// grid's generation, not just to the empire total.
//
// EXPECTED: derived.circuits contains the GEN↔LOAD grid with generation_mw > 0
// equal to the generator's fuel-limited output (≈ nameplate × count × clock
// when coal supply is sufficient), and that same value is reflected in
// derived.total_generation_mw. The grid must NOT read 0 MW generated for a
// fuelled driven generator. (phase2-empire only exercises the WIRED-to-
// __PowerMW generator path; the driven-in-grid attribution is unpinned.)
// ---------------------------------------------------------------------------
test("a driven fuelled generator contributes generation to its grid", async ({ request }) => {
  await resetView(request);
  const gen = await mk(request, "SESSION DRIVEN GEN", -1800, 900);
  const load = await mk(request, "SESSION LOAD", -1000, 900);
  try {
    // ---- GEN: claim coal, FUEL the generator (coalIn -> group edge), but add
    //          NO __PowerMW out port — leaving it driven via driven_cycles ----
    await edit(request, [{ type: "claim_node", factory: gen, node: "bp_resourcenode122", extractor: "Build_MinerMk2_C", clock: 1.0 }]);
    const coalIn = await port(request, gen, "in", "Desc_Coal_C", 480, 0);
    const g = await group(request, gen, "Build_GeneratorCoal_C", "Recipe_Power_Build_GeneratorCoal_Desc_Coal_C", 1);
    await belt(request, gen, P(coalIn), G(g), "Desc_Coal_C"); // fuelled, un-wired

    // ---- LOAD: a real consumer that draws power (ingot -> rod) ----
    const ingotIn = await port(request, load, "in", "Desc_IronIngot_C", null, 0);
    const rodOut = await port(request, load, "out", "Desc_IronRod_C", null, 640);
    const ctor = await group(request, load, "Build_ConstructorMk1_C", "Recipe_IronRod_C", 1);
    await belt(request, load, P(ingotIn), G(ctor), "Desc_IronIngot_C");
    await belt(request, load, G(ctor), P(rodOut), "Desc_IronRod_C");
    await edit(request, [{ type: "set_port_rate", id: rodOut, rate: 15 }]);

    // ---- power route GEN -> LOAD forms the grid ----
    await edit(request, [
      {
        type: "add_route",
        kind: { kind: "power" },
        from: gen,
        to: load,
        path: [{ x: -1800, y: 900 }, { x: -1000, y: 900 }],
      },
    ]);

    const h = await hydrate(request);
    // GEN solved (not error_factory): the driven generator is a valid solve.
    expect(h.derived.factories[gen].solveError ?? null).toBeNull();
    // The grid must contain both members and read the generator's real output.
    const grid = (h.derived.circuits as any[]).find(
      (c) => (c.members as string[]).includes(gen) && (c.members as string[]).includes(load),
    );
    expect(grid, "GEN↔LOAD grid must exist").toBeTruthy();
    // Fuel-sufficient coal → nameplate 75 MW × count 1 × clock 1.
    expect(grid.generationMw).toBeGreaterThan(0);
    expect(grid.generationMw).toBeCloseTo(75, 0);
    // ...and the empire total reflects the SAME driven generation.
    expect(h.derived.totalGenerationMw).toBeGreaterThan(0);
    expect(h.derived.totalGenerationMw).toBeCloseTo(75, 0);
  } finally {
    await edit(request, [{ type: "delete_factory", id: gen }]).catch(() => {});
    await edit(request, [{ type: "delete_factory", id: load }]).catch(() => {});
  }
});
