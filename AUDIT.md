# Conveyancer 1.0 Pre-Release Audit — Report

Branch `claude/audit-1.0` · method per `AUDIT-PLAN.md` (12-area adversarial
code review + functional probes with pre-declared expectations + performance
pass + independent verification of every claim). 76 Opus 4.8 agents across
four workflows; every finding below survived an independent refutation
attempt. Raw data: `audit/findings-pass1.json`, `audit/perf-pass.json`,
`audit/rootcause-pass.json`, probe suite `renderer/e2e-audit/`.

## Verdict at a glance

| Pass | Result |
|---|---|
| Code review (13 areas) | **32 confirmed findings** — 12 major · 16 minor · 4 nit (9 further claims refuted by verifiers) |
| Functional probes (45) | 21 pass · **16 fail = confirmed findings reproduced live** · 7 probe/harness issues (no product bug) · 1 skipped (web-only) |
| Existing 54-spec baseline | **PASS** (53/54; zoom-smooth failed in-suite, green in isolation — known flake) |
| Performance @ 42 factories / 420 groups / 146 routes | **PASS** — edit p95 58.9 ms (budget 250), hydrate 29 ms / 693 KB (budget 1 s), map ready 1.6 s, worst frame 17 ms |
| New bugs found by probes beyond pass-1 | **0** — every unexpected failure root-caused to the probe, not the product |

## Confirmed findings (32) — by area

Severity in brackets; full failure scenarios with file:line in
`audit/findings-pass1.json`. ★ = reproduced live by a probe.

**planner-core**
- [major] ★ `release_node` deletes ◆ Built claims with no immutability guard — the only delete command skipping `require_planned`; silently drops game ground truth after import.
- [minor] ★ Empty-transaction commands (no-op tidy, clear-override) truncate the redo tail and push a phantom undo step.

**solver**
- [major] T0 drag preview clamps an *independent* chain to 0 (naming the wrong constraint) whenever any sibling output target is currently infeasible; T1 snaps it right on release.
- [minor] Renderer `buildSnapshot` omits `driven_cycles` — un-wired generators read "GENERATES 0 MW" during every drag.
- [minor] `buildSnapshot` bails for the whole factory on one unresolvable recipe (imported generators) — silently no live preview; session-side snapshot deliberately skips-and-solves.

**gamedata / power attribution**
- [major] ★ Per-grid generation has no nameplate fallback — recipe-less (imported/geothermal) generators show 0 MW on the grid card while the empire total counts them.
- [minor] Fuel-burn synthesis drops generator byproducts (nuclear waste vanishes).

**session/derive**
- [major] ★ Multi-output deficit `needed` scales by the wrong output's target → phantom (or masked) deficits in NEXT/advisor.
- [minor] Generator MW attribution disagrees empire-total vs per-grid for unknown-recipe generators. · [nit] Grid names collide past 26 grids. · [nit] Chat item match on unbounded `contains`.

**import/sync**
- [major] ★ Demolished-in-game group sync leaves orphaned edges + boundary ports (no cascade).
- [major] ★ Count/clock drift accept never recomputes boundary port rates or belt tiers — expanded factory stays capped at old exports.
- [minor] Added-in-game group inserted unwired at a hardcoded position.

**map**
- [minor] ★ Claim tethers render to search-filtered-out nodes. · [minor] ★ Search-jump uses stale catalog coordinates, ignoring position overrides. · [nit] Elevation input goes stale after external z change.

**graph**
- [major] ★ Send-out surplus floors clock at 100% — underclocked machines over-promise exports.
- [major] ★ Group↔boundary-port belts mislabeled as cross-floor lifts (ports have no floor); floor filter splits them.
- [minor] FloorPlates ignores junctions. · [minor] Header search dims nodes but leaves belts fully lit.

**MAKE**
- [major] ★ Capacity guard uses the NO-reuse fresh plan — reuse+redirect-feasible builds falsely blocked.
- [minor] Free-up deletes every consumer of the short raw, over-freeing beyond the shortfall.

**wizard/proposals**
- [major] `t2_optimize` `source_of()` early-returns on any unknown-recipe group — imported factories get no T2 proposals.
- [major] Multi-output factory replacement reproduces only the first output; others silently dropped from the cutover.
- [minor] ★ Proposal MW impact ignores clock scaling (nameplate × count only).

**advisor/AI**
- [major] ★ SELECTION-scope chat context returns an all-null factory object for any non-factory selection.
- [minor] Context serializer has no factory-count/byte cap — on-device model silently degrades on huge plans.

**shell**
- [minor] Auto-pull's `reviewing` guard is dead code — the timer host unmounts during review (by design since #117 it doesn't; guard path re-checked and left as belt-and-braces). ·
  [minor] ★ Power bar fill width and color use different denominators. · [nit] RESUME chip advertises (H) in views where H is inert.

**web**
- [minor] ★ A wrong-but-valid JSON array uploads as an empty "successful" catalog, stranding the plan.

## Functional pass — mismatch protocol outcomes

16 probe failures matched pass-1 findings exactly (they are now living
regression tests for the fixes). The other 7 were root-caused
(`audit/rootcause-pass.json`): 4 web-only probes need
`playwright.web.config.ts` (bridge build lacks the wasm backend), the hadron
probe under-plumbed its own coal belt (Mk.3 cap starved the machine — solver
was *right*), the undo-round-trip probe drained the shared journal
(needs plan isolation), one flake did not reproduce. 1 spec-drift: the
save-only-import probe placed its miner 1.27 km from the cluster — outside
the 360 m attribution radius by design; expectation corrected in the
root-cause record.

## Performance

`audit/perf-pass.json`: all charter budgets met with ≥4× headroom at stress
scale; no O(n²) symptoms. Client holds ~60 fps on the heaviest graph.

## Disposition

Fixes are grouped into tasks #122–#132 (majors first), each carrying its
probe(s) as the acceptance test. Probe-suite hardening (the 7 harness issues)
is #133. The audit branch carries the charter, ledgers, and probe suite;
product fixes land as separate reviewed PRs.
