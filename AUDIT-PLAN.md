# Conveyancer 1.0 Pre-Release Audit — Test Strategy

Goal: find every remaining logic, display, and performance bug before 1.0.
Method: for EVERY feature, (a) an adversarial code review and (b) a functional
probe with the EXPECTED RESULT written down BEFORE the probe runs. Any mismatch
is root-caused — either the code is wrong (bug, fix or file it) or the
expectation was wrong (document why).

Orchestration: Fable 5 directs; all review/probe/verify agents run Opus 4.8
(`model: 'opus'`). Read-only review agents fan out in parallel. Functional
probes share ONE dev bridge (port 8791) so they execute as serialized batches.
Every finding is adversarially verified by an independent agent before it
reaches the report. Branch: `claude/audit-1.0` from latest main.

## Passes

1. **Code review pass** — 12 area agents, parallel, read-only. Each returns
   findings (severity, file, failure scenario) plus probe DESCRIPTORS (what to
   drive, expected result) for behaviors the current e2e suite doesn't pin.
2. **Functional pass** — probe descriptors compiled into playwright specs and
   run in serialized batches against the bridge; baseline = existing 54-spec
   suite must stay green. Each probe's expectation is declared in the spec
   header; failures are re-run once to filter flakes, then root-caused.
3. **Performance pass** — scripted stress plan (≥40 factories, ≥400 groups,
   ≥100 routes, imported-scale claims): measure solve round-trip (`LAST x ms`
   chip source), hydrate size/time, graph mount time, map pan/zoom frame
   budget. Expected: T1 solve < 250ms at stress scale, hydrate < 1s, no
   O(n²) hot paths in derive/render. Mismatch → profile and localize.
4. **Verify pass** — every finding from passes 1–3 gets an independent
   refutation attempt (read code, run the repro). Only CONFIRMED findings with
   concrete failure scenarios enter the report.

## Areas (12) — review focus → functional probes (expected result)

1. **planner-core** (commands/entities/undo/patches): command validation
   completeness, undo symmetry for EVERY command, Built-immutability guards,
   cascade deletes (factory→groups→edges→ports→junctions→claims), id
   collisions. Probe: property-style undo/redo round-trip over a scripted
   command sequence → plan hash identical after undo-all/redo-all.
2. **solver T0/T1 + wasm** (t0.rs/t1.rs/parity): pull-weight edge cases
   (junction chains, multi-output recipes, driven generators), hard-stop
   bisection exactness, T0/T1 parity epsilon, belt-cap and ceiling naming.
   Probe: parity sweep over generated topologies (diamond, junction manifold,
   generator bank) → |T0−T1| < 1e-6 on feasible targets; hard-stop names the
   true binding constraint.
3. **gamedata** (docs parse/fixture/burn synthesis/schematics/world): real
   Docs.json parse coverage (1.0/1.1/1.2 field variants), fluid normalization,
   burn-recipe math (MW·60/MJ), alt-recipe gating, node catalog dedupe/purity.
   Probe: parse fixture + assert invariants (every recipe machine exists,
   every burn recipe MW = product qty, no fluid on belt-only paths).
4. **app session/derive** (session.rs): derive determinism (same plan → same
   derived), generator MW attribution (wired vs driven), circuit ledger,
   advisor gating, per-factory solve error isolation. Probe: bridge /derive on
   crafted plans → exact expected rates/MW published in the spec.
5. **import pipeline** (save parse worker/cluster/Built layer/drift/sync):
   cluster boundary correctness, Built immutability post-import, re-import
   drift → proposal (no silent overwrite), sync conflict classes. Probe: run
   the checked-in fixture save through import → expected factory/claim/port
   counts; re-import unchanged → zero drift items.
6. **map view** (MapView/CanvasLayer/pins/zoom/search/claims drawers): pin
   drag/pan interaction, declutter stability, filter inertness rule, claim
   flows (claim/release/move/tier/reuse guards), route draw, overlay toggles.
   Probe: scripted drawer flows → port/claim invariants (counts, ceilings)
   after each op; canvas node count stamp matches filter.
7. **graph view** (GraphView/layout/tools/context menu/floors/trace): edge
   reconciliation (measured preserved), tidy determinism, box-select
   hit-testing, floor filtering, junction caps in UI, trace dim precedence.
   Probe: build known graph → assert node/edge DOM counts, tidy twice →
   identical layout (idempotent), trace from a machine → exact dimmed set.
8. **MAKE family** (makeChain/MakeFromResources/power): planner math vs
   catalog, reuse/redirect correctness, pooled headroom vs wiring agreement,
   junction manifolds, power sizing/1% floor, guard/build default agreement.
   Probe: matrix of {1|2|3 ports} × {capped|open} × {item|power} builds →
   exact group counts/clocks/edge topology published per cell.
9. **proposals/wizard** (wizard.rs/review surface/cutover/optimizer/queue):
   stage math, aggregate port ceilings, apply/reject atomicity, cutover
   retire/incoming tagging, T2 proposal validity, build-queue ordering.
   Probe: wizard a 2-stage chain → expected stages/machines/ports; reject →
   plan unchanged (hash); apply → solver feasible.
10. **advisor/NEXT/AI** (heuristics/opportunities/chat/webllm/rank): card
    gating conditions, deep-links resolve, rank staleness, chat context
    serializer bounds, webllm availability gating. Probe: crafted plan states
    → exact expected card set (each card's trigger documented).
11. **shell/chrome** (titlebar/DataMenu/statusbar/toasts/onboarding/resume/
    errors): portal/slot lifecycle across views, DATA menu state machine
    (two-click wipe, sync gating), friendly-error coverage for every
    DomainError, undo toasts, keyboard map (both platforms). Probe: walk every
    chrome control in both views → documented visible outcome each.
12. **web platform** (wasm backend/worker/IndexedDB/upload/deploy): worker
    message protocol completeness, IndexedDB migration/versioning, docs
    upload error paths, __WASM_BACKEND__ gating consistency, bundle size.
    Probe: web-smoke flow + forced-failure uploads (truncated json) →
    friendly error, no wedged state.

Cross-cutting sweeps (parallel with areas): dead code / TODO / stale-comment
scan; CSS/display audit at 1366×768, 1600×900, 1920×1080 (screenshot diffs of
every surface); z-index/stacking inventory; accessibility basics (focus
traps in modals, aria on interactive controls).

## Mismatch protocol

For each failed probe: (1) re-run once (flake filter); (2) bisect expectation
vs implementation — read the code that produces the value; (3) classify BUG
(fix now if ≤ ~30 LoC and risk-free, else file with repro) or SPEC-DRIFT
(expectation corrected, documented in the report). Nothing is silently
dropped; the report lists every probe with its expected/actual/verdict.

## Deliverables

- `AUDIT.md` on the audit branch: per-area findings (confirmed only), every
  probe with expected vs actual, perf numbers, fix list (done vs filed).
- Small confirmed fixes committed on the audit branch (each with a test).
- Larger confirmed bugs filed as tasks with repro steps.
