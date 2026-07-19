import { describe, it, expect } from "vitest";
import { orphanClaimPorts, pickReusePort } from "./claimPorts";

// #120: ports left behind by released claims must be found (for reuse) while
// ports backed by live claims — including wizard aggregates — stay untouchable.

const p = (id: string, rateCeiling: number | null) => ({ id, rateCeiling });
const rp = (id: string, rateCeiling: number | null, wired: boolean) => ({ id, rateCeiling, wired });

describe("orphanClaimPorts", () => {
  it("no claims → every claim-shaped port is an orphan", () => {
    expect(orphanClaimPorts([p("a", 60), p("b", 120)], [])).toEqual([p("a", 60), p("b", 120)]);
  });

  it("each live claim consumes exactly one rate-matched port", () => {
    expect(orphanClaimPorts([p("a", 60), p("b", 60), p("c", 120)], [60, 120])).toEqual([p("b", 60)]);
  });

  it("fully-backed ports → no orphans", () => {
    expect(orphanClaimPorts([p("a", 60), p("b", 120)], [120, 60])).toEqual([]);
  });

  it("ceilings within ±0.5 count as matching (float drift)", () => {
    expect(orphanClaimPorts([p("a", 59.8)], [60])).toEqual([]);
  });
});

describe("pickReusePort", () => {
  it("reuses the released claim's port (the #120 round-trip)", () => {
    expect(pickReusePort([rp("a", 60, true)], [])).toEqual(rp("a", 60, true));
  });

  it("prefers the WIRED orphan so its belts relight — never just orphans[0]", () => {
    // unwired orphan listed FIRST: an orphans[0] mutant fails this
    expect(pickReusePort([rp("dark", 60, false), rp("lit", 60, true)], [])).toEqual(rp("lit", 60, true));
  });

  it("falls back to an unwired orphan when no wired one exists", () => {
    expect(pickReusePort([rp("dark", 60, false)], [])).toEqual(rp("dark", 60, false));
  });

  it("NEVER touches a wizard aggregate port (1 port, ceiling = Σ of 2 claims)", () => {
    // wizard: one 240/min port covering two live 120/min claims. Rate-matching
    // alone calls it an orphan; the count guard (1 port ≤ 2 claims) must veto.
    expect(pickReusePort([rp("agg", 240, true)], [120, 120])).toBeNull();
  });

  it("wizard single-node case: ceiling = need > node rate is still off-limits", () => {
    expect(pickReusePort([rp("agg", 200, true)], [120])).toBeNull();
  });

  it("bails when ANY same-item claim's node is unresolvable (save-only)", () => {
    // the null claim's port is invisible to rate-matching — stealing the
    // "orphan" would leave two live claims sharing one port
    expect(pickReusePort([rp("a", 60, true), rp("b", 60, false)], [null])).toBeNull();
  });

  it("genuine orphan beside a live claim is still reusable", () => {
    // 2 ports > 1 live claim; the 60 port is claimed, the 120 one is orphaned
    expect(pickReusePort([rp("live", 60, true), rp("orphan", 120, true)], [60])).toEqual(
      rp("orphan", 120, true),
    );
  });

  it("no numeric excess → null (fresh port gets added)", () => {
    expect(pickReusePort([rp("live", 60, true)], [60])).toBeNull();
  });
});
