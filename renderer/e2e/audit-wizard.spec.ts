// Audit #129 acceptance (promoted from the audit probe suite): wizard — supply-chain wizard → proposal review surface
// (wizard.rs / ProposalReview.tsx). Focus: apply/reject atomicity, stage-math
// display fidelity, and agreement between the two POWER figures the review
// shows side by side. Every probe declares its EXPECTED (correct) result in the
// header BEFORE any assertion; a failing probe is data for the mismatch
// protocol, NOT a reason to weaken the assert. Driven through the real wizard
// UI against the dev bridge's global solver + default fixture catalog:
//   Recipe_IronPlate_C = 3 ingot -> 2 plate @ 6s => 20/min per machine
//   Recipe_IngotIron_C = 1 ore   -> 1 ingot @ 2s => 30/min per machine
// so 25 plate/min = 37.5 ingot/min = 37.5 ore/min.

import { test, expect, type APIRequestContext } from "@playwright/test";
import { resetView } from "./helpers";

// NOTE: no serial mode — the runner uses --workers=1, and per-test isolation
// (each test seeds + deletes its own factories) means a failure must NOT
// cascade-skip sibling probes: every probe needs a verdict.

const API = "http://localhost:8791/api";

async function hydrate(request: APIRequestContext): Promise<any> {
  const res = await request.get(`${API}/hydrate`);
  if (!res.ok()) throw new Error(`hydrate ${res.status()}: ${await res.text()}`);
  return res.json();
}
async function edit(request: APIRequestContext, cmds: unknown[]): Promise<{ created: string[] }> {
  const res = await request.post(`${API}/edit`, { data: JSON.stringify(cmds) });
  if (!res.ok()) throw new Error(`edit ${res.status()}: ${await res.text()}`);
  return res.json();
}

// Counts of every plan collection whose growth would mean ◇ entities were
// materialized. plan.* are objects keyed by id (project() shape).
const counts = (h: any) => ({
  factories: Object.keys(h.plan.factories ?? {}).length,
  groups: Object.keys(h.plan.groups ?? {}).length,
  ports: Object.keys(h.plan.ports ?? {}).length,
  edges: Object.keys(h.plan.edges ?? {}).length,
  routes: Object.keys(h.plan.routes ?? {}).length,
  junctions: Object.keys(h.plan.junctions ?? {}).length,
  nodeClaims: Object.keys(h.plan.nodeClaims ?? {}).length,
});

// Open the wizard and solve for 25/min Iron Plate; resolves once the review
// surface is on screen. API seeds never stream to an open client, so the caller
// must have already reloaded to the map before driving the wizard.
async function wizardSolveIronPlate25(page: any): Promise<void> {
  await page.keyboard.press("p");
  await expect(page.getByTestId("wizard-modal")).toBeVisible();
  await page.getByTestId("wizard-item").fill("iron plate");
  await page.getByTestId("wizard-item-option").first().click();
  await page.fill('[data-testid="wizard-rate"]', "25");
  await page.click('[data-testid="wizard-solve"]');
  await expect(page.getByTestId("proposal-review")).toBeVisible({ timeout: 10_000 });
}

async function bootMap(page: any, request: APIRequestContext): Promise<void> {
  await resetView(request);
  await page.goto("/");
  const skip = page.getByTestId("onboard-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.getByTestId("map-root")).toBeVisible();
}

// Parse the first "<signed number> MW" figure out of a cell's text, e.g.
// "+12 MW", "+8.4 MW draw" -> 12 / 8.4.
function mw(text: string): number {
  const m = /([-+]?\d+(?:\.\d+)?)\s*MW/.exec(text);
  if (!m) throw new Error(`no MW figure in ${JSON.stringify(text)}`);
  return Number(m[1]);
}

// ---------------------------------------------------------------------------
// PROBE 1 — Reject leaves the plan byte-identical (apply/reject atomicity).
//
// Load the map; record planHash H0 and the count of every plan collection.
// Wizard 25/min Iron Plate → SOLVE → review; click REJECT.
//
// EXPECTED (correct behavior): after reject, planHash === H0 (the plan-content
// hash excludes proposals, so rejecting a proposal cannot move it); the factory
// count and every other collection count (groups/ports/edges/routes/junctions/
// nodeClaims) are UNCHANGED — zero ◇ entities materialized; the newly-created
// proposal's status === "rejected"; the review surface is closed and the map is
// shown again. No entity other than the proposal itself changed.
// ---------------------------------------------------------------------------
test("reject leaves the plan byte-identical (planHash + collection counts)", async ({ page, request }) => {
  await bootMap(page, request);

  const h0 = await hydrate(request);
  const H0: string = h0.planHash;
  const N0 = counts(h0);
  const beforeProposalIds = new Set(Object.keys(h0.plan.proposals ?? {}));

  await wizardSolveIronPlate25(page);

  // REJECT the proposal outright (no partial exclusion).
  await page.locator("button.prop-reject").click();

  // review closes and the map is shown again
  await expect(page.getByTestId("proposal-review")).not.toBeVisible();
  await expect(page.getByTestId("map-root")).toBeVisible();

  const h1 = await hydrate(request);
  // plan-content hash unchanged (proposals excluded from the hash)
  expect(h1.planHash).toBe(H0);
  // zero ◇ entities materialized — every collection count is unchanged
  expect(counts(h1)).toEqual(N0);

  // the ONE new proposal exists and is rejected
  const newProposalIds = Object.keys(h1.plan.proposals ?? {}).filter((id) => !beforeProposalIds.has(id));
  expect(newProposalIds).toHaveLength(1);
  expect(h1.plan.proposals[newProposalIds[0]].status).toBe("rejected");
});

// ---------------------------------------------------------------------------
// PROBE 2 — Two-stage chain produces exact stages / machines / ports.
//
// Wizard 25/min Iron Plate → SOLVE → review; read the CREATE row detail; then
// ACCEPT and inspect the created factory.
//
// EXPECTED (correct behavior): the CREATE item detail reads exactly
// "2 stages · 4 machines · Iron Plate 25.0/min" (plate stage Recipe_IronPlate_C
// ×2 @ 62% [20/min per machine], ingot stage Recipe_IngotIron_C ×2 @ 62%
// [30/min per machine → 37.5 ingot/min]); goal-check shows "25/25 ✓". After
// accept, the new IRON PLATE WORKS factory has exactly 2 machine groups (4
// machines total), exactly 1 IN port (Iron Ore) and exactly 1 OUT port (Iron
// Plate), and its Iron Ore claims cover the ≥37.5/min the chain draws.
// ---------------------------------------------------------------------------
test("two-stage chain: exact stages, machines and boundary ports", async ({ page, request }) => {
  await bootMap(page, request);
  await wizardSolveIronPlate25(page);

  // the CREATE row detail names the two stages, machine total and output rate
  const createDetail = page.locator("section:has(.prop-group-head.create) .prop-row-detail").first();
  await expect(createDetail).toHaveText("2 stages · 4 machines · Iron Plate 25.0/min");
  await expect(page.getByTestId("goal-check")).toContainText("25/25 ✓");

  // ids present before accept, so we can isolate the newly-created factory
  const beforeIds = new Set(Object.keys((await hydrate(request)).plan.factories ?? {}));

  await page.getByTestId("btn-accept-proposal").click();
  await expect(page.getByTestId("proposal-review")).not.toBeVisible();

  const h = await hydrate(request);
  const newIds = Object.keys(h.plan.factories ?? {}).filter((id) => !beforeIds.has(id));
  expect(newIds).toHaveLength(1);
  const fid = newIds[0];

  try {
    expect(String(h.plan.factories[fid].name).toUpperCase()).toContain("IRON PLATE WORKS");

    // exactly 2 machine groups, 4 machines total
    const groups = Object.values<any>(h.plan.groups).filter((g) => g.factory === fid);
    expect(groups).toHaveLength(2);
    expect(groups.reduce((s, g) => s + g.count, 0)).toBe(4);

    // exactly 1 IN port (Iron Ore) and 1 OUT port (Iron Plate)
    const ports = Object.values<any>(h.plan.ports).filter((p) => p.factory === fid);
    const inPorts = ports.filter((p) => p.direction === "in");
    const outPorts = ports.filter((p) => p.direction === "out");
    expect(inPorts).toHaveLength(1);
    expect(inPorts[0].item).toBe("Desc_OreIron_C");
    expect(outPorts).toHaveLength(1);
    expect(outPorts[0].item).toBe("Desc_IronPlate_C");

    // Iron Ore claims exist and cover the drawn demand (≥ 37.5/min). Capacity is
    // read off the pooled IN-port ceiling (null = open supply, trivially covers);
    // and the derived intake confirms the chain actually pulls 37.5/min ore.
    const oreClaims = Object.values<any>(h.plan.nodeClaims).filter((c) => c.factory === fid);
    expect(oreClaims.length).toBeGreaterThanOrEqual(1);
    const capacity = inPorts[0].rateCeiling ?? Infinity;
    expect(capacity).toBeGreaterThanOrEqual(37.5 - 1e-6);
    const oreDraw = h.derived.factories[fid]?.ports?.[inPorts[0].id];
    expect(oreDraw).toBeGreaterThanOrEqual(37.5 - 1e-3);
  } finally {
    await edit(request, [{ type: "delete_factory", id: fid }]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// PROBE 3 — Wizard CREATE power impact matches the solved Δ POWER.
//
// Wizard 25/min Iron Plate → SOLVE → review; parse the MW figure from the
// CREATE row's impact cell (N), and from the footer Δ POWER cell (M).
//
// EXPECTED: N ≈ M — both are the clock-scaled solved draw of the four @62%
// machines (fixed by audit #129: the CREATE impact now scales by
// clock^1.321928 like the solver, instead of nameplate × count). The CREATE
// impact renders as a whole number, so agreement means within ±0.5 MW —
// still an order of magnitude tighter than the ~2× gap the unscaled figure
// produced at these clocks.
//
// Harness note (#133): M is an EMPIRE-WIDE before/after delta — on a dirty
// shared plan the global solve can also re-clock leftover factories from
// earlier specs, legitimately splitting M from the CREATE-only N (observed
// once at |N−M| = 9 in the full serial run). Seed a fresh empire so the delta
// can only be the new chain's own draw; every spec after this one re-seeds
// itself (the resetView decoupling contract), as audit-import already relies
// on mid-suite.
// ---------------------------------------------------------------------------
test("CREATE power impact agrees with the footer Δ POWER draw", async ({ page, request }) => {
  const res = await request.post(`${API}/new_empire`, { data: "{}" });
  if (!res.ok()) throw new Error(`new_empire ${res.status()}: ${await res.text()}`);
  await bootMap(page, request);
  await wizardSolveIronPlate25(page);

  const createImpact = page.locator("section:has(.prop-group-head.create) .prop-row-impact").first();
  const N = mw((await createImpact.innerText()).trim());

  const powerCell = page.locator('[data-testid="proposal-review"] .prop-cell', { hasText: "Δ POWER" });
  const M = mw((await powerCell.innerText()).trim());

  // honest expectation: the two MW figures shown together are the same draw
  // (N is rendered as a whole number — allow its rounding, nothing more)
  expect(Math.abs(N - M)).toBeLessThanOrEqual(0.5 + 1e-9);
});
