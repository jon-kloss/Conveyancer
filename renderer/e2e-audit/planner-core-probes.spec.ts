// AUDIT area: planner-core — command validation, undo/redo symmetry,
// Built-immutability guards, and cascade-delete atomicity, all driven through
// the same /api/edit command surface the renderer uses (dev bridge, port 8791).
//
// Every probe declares its EXPECTED (correct) result in a header BEFORE any
// assertion. Where the current code is suspected wrong the probe still asserts
// the CORRECT behavior: a failing probe is data for the mismatch protocol, NOT
// a reason to weaken the assert. API edits do not stream to an open client, so
// seeding happens via the API and (for the DOM-driven import probe) the page is
// reloaded + resetView'd to re-sync.
//
// Fixture catalog (dev bridge default) recipe used below:
//   Recipe_IronRod_C = 1 ingot -> 1 rod @ 4s => 15/min per Constructor machine.

import { test, expect, type APIRequestContext } from "@playwright/test";
import { resetView } from "../e2e/helpers";
import { fileURLToPath } from "node:url";

test.describe.configure({ mode: "serial" });

const API = "http://localhost:8791/api";
const SAVES = fileURLToPath(new URL("../../fixtures/saves", import.meta.url));

// One command per call, returning the created ids (creation order) so a probe
// can capture the entity it just minted.
async function edit(request: APIRequestContext, cmds: unknown[]): Promise<{ created: string[] }> {
  const res = await request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
  if (!res.ok()) throw new Error(`edit ${res.status()}: ${await res.text()}`);
  return res.json();
}
// Like edit(), but for commands EXPECTED to be rejected — returns the raw
// status + parsed body instead of throwing, so a probe can assert 422 + code.
async function editExpectError(request: APIRequestContext, cmds: unknown[]): Promise<{ status: number; body: any }> {
  const res = await request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  return { status: res.status(), body };
}
async function hydrate(request: APIRequestContext): Promise<any> {
  const res = await request.get(`${API}/hydrate`);
  if (!res.ok()) throw new Error(`hydrate ${res.status()}: ${await res.text()}`);
  return res.json();
}
async function undo(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${API}/undo`);
  if (!res.ok()) throw new Error(`undo ${res.status()}: ${await res.text()}`);
}
async function redo(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${API}/redo`);
  if (!res.ok()) throw new Error(`redo ${res.status()}: ${await res.text()}`);
}
const size = (o: unknown) => Object.keys((o ?? {}) as object).length;
const factoryCount = (h: any) => size(h.plan.factories);

const G = (id: string) => ({ kind: "group", id });
const J = (id: string) => ({ kind: "junction", id });

// ---------------------------------------------------------------------------
// PROBE 1 — Undo-all / redo-all round-trips the plan hash over a scripted
// command sequence (property-style undo/redo identity).
//
// Drives a 10-command script (create A/B, group, ports, belt route, junction,
// node claim, power route, priority switch), then drains the undo journal and
// the redo journal.
//
// EXPECTED: After undo-all (POST /api/undo until canUndo==false), plan
// factories, groups, ports, edges, junctions, routes, switches, and nodeClaims
// are ALL empty and planHash == H_empty (the baseline hash captured right after
// resetView). After redo-all (POST /api/redo until canRedo==false), planHash is
// BYTE-IDENTICAL to H_full (the hash captured after the 10th command) — every
// entity, id, count/clock, route binding, and switch restored exactly.
// ---------------------------------------------------------------------------
test("undo-all / redo-all round-trips the plan hash over a scripted sequence", async ({ request }) => {
  await resetView(request);
  const H_empty = (await hydrate(request)).planHash as string;

  let a = "";
  let b = "";
  try {
    // (1) create_factory A
    a = (await edit(request, [{ type: "create_factory", name: "RT ALPHA", position: { x: -3200, y: 3200, z: 0 }, region: "GRASS FIELDS" }])).created[0];
    // (2) create_factory B
    b = (await edit(request, [{ type: "create_factory", name: "RT BETA", position: { x: -3000, y: 3200, z: 0 }, region: "GRASS FIELDS" }])).created[0];
    // (3) add_group in A
    await edit(request, [{ type: "add_group", factory: a, machine: "Build_ConstructorMk1_C", recipe: "Recipe_IronRod_C", count: 4, clock: 1, graphPos: { x: 320, y: 100 }, floor: 0 }]);
    // (4) add_port OUT in A
    const aOut = (await edit(request, [{ type: "add_port", factory: a, direction: "out", item: "Desc_IronIngot_C", rate: 30, rateCeiling: null, graphPos: { x: 640, y: 100 } }])).created[0];
    // (5) add_port IN in B
    const bIn = (await edit(request, [{ type: "add_port", factory: b, direction: "in", item: "Desc_IronIngot_C", rate: 30, rateCeiling: null, graphPos: { x: 0, y: 100 } }])).created[0];
    // (6) add_route belt A.outPort -> B.inPort
    await edit(request, [{ type: "add_route", kind: { kind: "belt", tier: 1 }, from: aOut, to: bIn, path: [] }]);
    // (7) add_junction in A
    await edit(request, [{ type: "add_junction", factory: a, kind: "splitter", graphPos: { x: 480, y: 260 }, floor: 0 }]);
    // (8) claim_node in A
    await edit(request, [{ type: "claim_node", factory: a, node: "node-1", extractor: "Build_MinerMk1_C", clock: 1 }]);
    // (9) add_route power A -> B
    const powerRoute = (await edit(request, [{ type: "add_route", kind: { kind: "power" }, from: a, to: b, path: [] }])).created[0];
    // (10) add_priority_switch on the power route
    await edit(request, [{ type: "add_priority_switch", route: powerRoute, priority: 3 }]);

    const H_full = (await hydrate(request)).planHash as string;
    expect(H_full).not.toBe(H_empty);

    // ---- undo-all: drain the journal ----
    let guard = 0;
    for (;;) {
      const h = await hydrate(request);
      if (!h.canUndo) break;
      if (guard++ > 50) throw new Error("undo-all did not terminate");
      await undo(request);
    }
    const after = await hydrate(request);
    expect(size(after.plan.factories)).toBe(0);
    expect(size(after.plan.groups)).toBe(0);
    expect(size(after.plan.ports)).toBe(0);
    expect(size(after.plan.edges)).toBe(0);
    expect(size(after.plan.junctions)).toBe(0);
    expect(size(after.plan.routes)).toBe(0);
    expect(size(after.plan.switches)).toBe(0);
    expect(size(after.plan.nodeClaims)).toBe(0);
    expect(after.planHash).toBe(H_empty);

    // ---- redo-all: replay the journal ----
    guard = 0;
    for (;;) {
      const h = await hydrate(request);
      if (!h.canRedo) break;
      if (guard++ > 50) throw new Error("redo-all did not terminate");
      await redo(request);
    }
    const restored = await hydrate(request);
    // byte-identical round-trip identity: the redone plan hashes to H_full.
    expect(restored.planHash).toBe(H_full);
  } finally {
    // Defensive restore: if an assertion fired mid-journal, replay to the top
    // so sibling serial specs don't inherit a drained journal; then delete the
    // two factories this probe created.
    for (let i = 0; i < 60; i++) {
      const h = await hydrate(request).catch(() => null);
      if (!h || !h.canRedo) break;
      await redo(request).catch(() => {});
    }
    if (a) await edit(request, [{ type: "delete_factory", id: a }]).catch(() => {});
    if (b) await edit(request, [{ type: "delete_factory", id: b }]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 2 — release_node on an imported ◆ Built claim is rejected
// (Built immutability, §3.1.1).
//
// Seeds a real Built layer by running the checked-in Dunarr-076.sav through the
// import flow (exactly as phase4-import.spec.ts does), then picks a nodeClaim
// with status=="built" and attempts to release it.
//
// EXPECTED: HTTP 422 with DomainError code "built_immutable" (surfaced by the
// bridge as the "built entities are immutable …" message, action "release"/
// "delete"). After the rejected call, hydrate still contains claim C with
// status=="built" and C is still listed in its factory.nodeClaims.
//
// KNOWN MISMATCH (documented, do NOT weaken): ReleaseNode currently has NO
// require_planned guard — it returns 200 and deletes the claim regardless of
// status. This probe is EXPECTED to fail at the 422 assertion until the guard
// is added.
// ---------------------------------------------------------------------------
test("release_node on an imported Built claim is rejected (built-immutable)", async ({ page, request }) => {
  test.setTimeout(300_000); // cold-worker .sav parse
  await resetView(request);

  const baseline = factoryCount(await hydrate(request));
  try {
    await page.goto("/");
    await expect(page.getByTestId("map-root")).toBeVisible();

    // ---- import Dunarr-076 as the ◆ Built layer (phase4-import flow) ----
    await page.getByTestId("btn-data-menu").click();
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      page.getByTestId("btn-import").click(),
    ]);
    await chooser.setFiles(`${SAVES}/Dunarr-076.sav`);
    await expect(page.getByTestId("import-preview")).toBeVisible({ timeout: 120_000 });
    await page.getByTestId("btn-import-run").click();
    await expect(page.getByTestId("import-done")).toBeVisible({ timeout: 60_000 });
    await page.locator(".wizard-foot .btn-primary").click();

    // ---- pick a Built claim straight from canonical state ----
    const h = await hydrate(request);
    const claims = Object.values<any>(h.plan.nodeClaims);
    const builtClaim = claims.find((c) => c.status === "built");
    expect(builtClaim, "import must produce at least one ◆ Built node claim").toBeTruthy();
    const C = builtClaim.id as string;
    const owner = builtClaim.factory as string;
    expect(h.plan.factories[owner].nodeClaims).toContain(C);

    // ---- attempt to release it: must be refused ----
    const { status, body } = await editExpectError(request, [{ type: "release_node", id: C }]);
    expect(status).toBe(422);
    // the bridge surfaces DomainError via its Display string; built_immutable
    // reads "built entities are immutable: <id> (<action>)".
    expect(String(body?.error ?? body)).toMatch(/immutable/i);

    // ---- the claim survives untouched ----
    const h2 = await hydrate(request);
    expect(h2.plan.nodeClaims[C]).toBeTruthy();
    expect(h2.plan.nodeClaims[C].status).toBe("built");
    expect(h2.plan.factories[owner].nodeClaims).toContain(C);
  } finally {
    // Undo back down to the pre-import factory count (removes the release step
    // if the guard was missing and it committed, then the whole import).
    for (let i = 0; i < 8; i++) {
      const h = await hydrate(request).catch(() => null);
      if (!h || !h.canUndo || factoryCount(h) <= baseline) break;
      await undo(request).catch(() => {});
    }
  }
});

// ---------------------------------------------------------------------------
// PROBE 3 — A no-op command must not destroy the redo tail.
//
// Creates factory F (name NOOP), renames it to NOOP2, undoes the rename (so a
// redo tail exists: canRedo==true, name back to NOOP), then issues a
// tidy_layout on F while F has NO groups/ports/junctions — an empty forward
// batch, i.e. a no-op.
//
// EXPECTED: After the tidy_layout no-op, hydrate.canRedo REMAINS true; the
// subsequent /api/redo restores factories[F].name=="NOOP2". A no-op must
// neither truncate the redo tail nor commit an undoable step.
//
// KNOWN MISMATCH (documented, do NOT weaken): the current code commits an empty
// entry — canRedo flips to false and the rename can no longer be redone — so
// this probe is EXPECTED to fail at the "canRedo stays true" / redo assertions.
// ---------------------------------------------------------------------------
test("a no-op command must not destroy the redo tail", async ({ request }) => {
  await resetView(request);
  let f = "";
  try {
    f = (await edit(request, [{ type: "create_factory", name: "NOOP", position: { x: -3400, y: 3400, z: 0 }, region: "GRASS FIELDS" }])).created[0];
    await edit(request, [{ type: "rename_factory", id: f, name: "NOOP2" }]);

    await undo(request); // undo the rename
    let h = await hydrate(request);
    expect(h.canRedo).toBe(true);
    expect(h.plan.factories[f].name).toBe("NOOP");

    // no-op: F has no groups/ports/junctions, so tidy produces an empty batch.
    await edit(request, [{ type: "tidy_layout", factory: f }]);

    h = await hydrate(request);
    // the redo tail must survive the no-op
    expect(h.canRedo).toBe(true);

    await redo(request);
    h = await hydrate(request);
    expect(h.plan.factories[f].name).toBe("NOOP2");
  } finally {
    if (f) await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 4 — add_edge enforces the splitter output-port cap (1-in / 3-out).
//
// Builds factory F with one splitter junction J and four groups g1..g4, then
// connects J's OUTPUT to g1, g2, g3 (all carrying Desc_IronIngot_C), then
// attempts a 4th output edge J->g4.
//
// EXPECTED: the first three add_edge calls return 200; the fourth returns 422
// with DomainError code "invalid" and a message stating all 3 output ports are
// connected ("Splitter has all 3 output ports connected"). hydrate then shows
// EXACTLY 3 edges whose from == {kind:"junction", id:J}.
// ---------------------------------------------------------------------------
test("add_edge enforces the splitter output-port cap (1-in / 3-out)", async ({ request }) => {
  await resetView(request);
  let f = "";
  try {
    f = (await edit(request, [{ type: "create_factory", name: "SPLIT CAP", position: { x: -3600, y: 3600, z: 0 }, region: "GRASS FIELDS" }])).created[0];
    const j = (await edit(request, [{ type: "add_junction", factory: f, kind: "splitter", graphPos: { x: 320, y: 100 }, floor: 0 }])).created[0];
    const g: string[] = [];
    for (let i = 0; i < 4; i++) {
      g.push((await edit(request, [{ type: "add_group", factory: f, machine: "Build_ConstructorMk1_C", recipe: "Recipe_IronRod_C", count: 1, clock: 1, graphPos: { x: 640, y: 100 + i * 120 }, floor: 0 }])).created[0]);
    }

    // first three outputs: accepted
    for (let i = 0; i < 3; i++) {
      await edit(request, [{ type: "add_edge", factory: f, from: J(j), to: G(g[i]), item: "Desc_IronIngot_C", tier: 1 }]);
    }

    // fourth output: over the 3-out cap → rejected
    const { status, body } = await editExpectError(request, [{ type: "add_edge", factory: f, from: J(j), to: G(g[3]), item: "Desc_IronIngot_C", tier: 1 }]);
    expect(status).toBe(422);
    const msg = String(body?.error ?? body);
    expect(msg).toMatch(/invalid/i); // DomainError::Invalid Display: "invalid value: …"
    expect(msg).toMatch(/all 3 output ports connected/i);

    // exactly 3 edges leave the junction
    const h = await hydrate(request);
    const fromJ = Object.values<any>(h.plan.edges).filter((e) => e.from.kind === "junction" && e.from.id === j);
    expect(fromJ).toHaveLength(3);
  } finally {
    if (f) await edit(request, [{ type: "delete_factory", id: f }]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 5 — delete_factory cascades routes/switches/claims and one undo
// restores everything atomically (hash identity).
//
// A: group + OUT port; B: IN port. A belt route binds A.out->B.in; a power
// route joins A->B and carries a priority switch; A also has a node claim.
// Records H0 (planHash) and B's IN-port id, deletes A, then does a single undo.
//
// EXPECTED after delete_factory A: A and all of A's groups/ports/claims are
// absent; the belt route, the power route, and the priority switch are all
// absent; B still exists; B's IN port SURVIVES with boundRoute==null (the far
// endpoint was unbound by the cascade). After a SINGLE /api/undo: planHash is
// byte-identical to H0 — the factory, both routes, the switch, the claim, and
// B's port binding all restored in one atomic step.
// ---------------------------------------------------------------------------
test("delete_factory cascades and one undo restores everything (hash identity)", async ({ request }) => {
  await resetView(request);
  let a = "";
  let b = "";
  try {
    a = (await edit(request, [{ type: "create_factory", name: "CASCADE A", position: { x: -3800, y: 3800, z: 0 }, region: "GRASS FIELDS" }])).created[0];
    b = (await edit(request, [{ type: "create_factory", name: "CASCADE B", position: { x: -3600, y: 3800, z: 0 }, region: "GRASS FIELDS" }])).created[0];

    await edit(request, [{ type: "add_group", factory: a, machine: "Build_ConstructorMk1_C", recipe: "Recipe_IronRod_C", count: 1, clock: 1, graphPos: { x: 320, y: 100 }, floor: 0 }]);
    const aOut = (await edit(request, [{ type: "add_port", factory: a, direction: "out", item: "Desc_IronIngot_C", rate: 30, rateCeiling: null, graphPos: { x: 640, y: 100 } }])).created[0];
    const bIn = (await edit(request, [{ type: "add_port", factory: b, direction: "in", item: "Desc_IronIngot_C", rate: 30, rateCeiling: null, graphPos: { x: 0, y: 100 } }])).created[0];

    await edit(request, [{ type: "add_route", kind: { kind: "belt", tier: 1 }, from: aOut, to: bIn, path: [] }]);
    const powerRoute = (await edit(request, [{ type: "add_route", kind: { kind: "power" }, from: a, to: b, path: [] }])).created[0];
    await edit(request, [{ type: "add_priority_switch", route: powerRoute, priority: 5 }]);
    await edit(request, [{ type: "claim_node", factory: a, node: "node-cascade", extractor: "Build_MinerMk1_C", clock: 1 }]);

    const before = await hydrate(request);
    const H0 = before.planHash as string;
    // sanity: the belt route bound B's IN port before the delete
    expect(before.plan.ports[bIn].boundRoute).toBeTruthy();

    // ---- delete A ----
    await edit(request, [{ type: "delete_factory", id: a }]);
    const del = await hydrate(request);

    // A and everything owned by A is gone
    expect(del.plan.factories[a]).toBeFalsy();
    expect(Object.values<any>(del.plan.groups).filter((gr) => gr.factory === a)).toHaveLength(0);
    expect(Object.values<any>(del.plan.ports).filter((p) => p.factory === a)).toHaveLength(0);
    expect(Object.values<any>(del.plan.nodeClaims).filter((c) => c.factory === a)).toHaveLength(0);
    // both routes and the switch cascaded away
    expect(size(del.plan.routes)).toBe(0);
    expect(size(del.plan.switches)).toBe(0);
    // B survives; its IN port survives, now unbound
    expect(del.plan.factories[b]).toBeTruthy();
    expect(del.plan.ports[bIn]).toBeTruthy();
    expect(del.plan.ports[bIn].boundRoute).toBeNull();

    // ---- one undo restores the whole cascade atomically ----
    await undo(request);
    const restored = await hydrate(request);
    expect(restored.planHash).toBe(H0);
    expect(restored.plan.factories[a]).toBeTruthy();
    expect(size(restored.plan.routes)).toBe(2);
    expect(size(restored.plan.switches)).toBe(1);
    expect(restored.plan.ports[bIn].boundRoute).toBeTruthy();
  } finally {
    if (a) await edit(request, [{ type: "delete_factory", id: a }]).catch(() => {});
    if (b) await edit(request, [{ type: "delete_factory", id: b }]).catch(() => {});
  }
});
