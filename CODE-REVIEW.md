# Code Review — full-codebase fresh-eyes pass (2026-07-11)

Eleven independent reviewers (one per dimension: domain model, proposals/transport, solvers, session/empire, wizard/jobs, import/advisor/chat, persistence/gamedata, renderer state, renderer UI, security/robustness, tests/CI, plus a cross-cutting sweep) reviewed the codebase with no knowledge of how it was written. 72 raw findings were deduplicated to 67; each survivor was then handed to an adversarial verifier instructed to refute it against the actual code and DECISIONS.md. **60 findings were confirmed, 7 refuted.**

Each confirmed finding below carries the verifier's decisive evidence. Fix disposition is tracked by the fix pipeline (two independent fix proposals per major+ finding, reconciled by an arbiter, applied sequentially — one commit per issue).

**Totals: 1 critical · 29 major · 30 minor**


## Critical (1)

### C1. Fluid normalization pass divides synthesized liquid-fuel burn recipes by 1000, silently understating generator fuel consumption 1000x
`crates/gamedata/src/docs.rs:414` · found by *persist-gamedata*

parse_docs synthesizes generator burn recipes (lines 360-390) with `per_min = mw * 60.0 / fuel_item.energy_mj`. In real Docs.json, mEnergyValue for fluids is MJ per cubic meter (Desc_LiquidFuel_C = 750, and 250 MW * 60 / 750 = 20 m3/min, which is the game's actual Fuel Generator consumption), so `per_min` is already in m3/min. But the synthesized recipes are inserted into gd.recipes BEFORE the liter->m3 normalization loop (lines 403-417), which then divides every fluid ingredient by 1000 — including the already-correct synthesized burn ingredient. That loop exists to convert authored recipe amounts (which Docs stores in liters) and must not touch the synthesized ones.

**Failure:** User points FICSIT_DOCS_JSON at a real install and plans fuel power: a Fuel Generator's burn recipe becomes 0.02 m3/min instead of 20 m3/min, so the solver reports ~1000x less fuel needed than reality. All liquid-fueled generators (Fuel, Turbofuel, Liquid Biofuel, Rocket/Ionized Fuel) are silently wrong; the bundled fixture only has coal (solid), so no test catches it.

**Suggested fix:** Run the liter->m3 normalization over parsed recipes first, then synthesize burn recipes; or tag synthesized recipes and skip them in the normalization loop; or compute per_min from the already-normalized fluid unit. Add a fixture liquid-fuel generator case.

**Verifier:** Finding is accurate. Sharpening: only the fuel ingredient is corrupted — the __PowerMW product has form RF_POWER (docs.rs:397) and escapes the division, so power output stays right while fuel consumption drops 1000×, making the error invisible in MW totals. The in-code comment at docs.rs:357-359 ("the fuel math itself is exact") shows the synthesized value was intended to be final. Fix: run the liter→m³ normalization over authored recipes before synthesizing burn recipes (or skip Recipe_Power_* classes in the loop). Nuclear (solid rods) and coal are unaffected; all RF_LIQUID fuels are.


## Major (29)

### M1. DeleteFactory cascades route deletion without removing the priority switches riding those routes, leaving dangling PrioritySwitch.route references
`crates/planner-core/src/commands.rs:438` · found by *core-model*

DeleteFactory collects and removes every route touching the factory (lines 427-453) but never removes PrioritySwitch entities whose `route` field points at those routes. DeleteRoute (lines 1036-1046) does exactly this cascade ("switches riding this line go with it", also promised in DECISIONS.md: "Deleting a line cascades its switches"), so the invariant is clearly intended — DeleteFactory just skips it. Nothing else prunes orphans: the derived-circuit pass in crates/app/src/session.rs:1195 silently `continue`s past switches whose route no longer exists, and the orphan is persisted in the plan file forever.

**Failure:** Create factories A and B, add a power route between them, AddPrioritySwitch on that route, then DeleteFactory A. The route is removed but the switch survives with switch.route pointing at a deleted route. The map keeps a ghost square pin floating at the old line midpoint whose drawer reads "UNGRIDDED · ? ⚡ ?" (renderer/src/map/SwitchDrawer.tsx:14-27), it participates in no circuit, and the orphan record is saved to the plan file permanently — the user has no way to remove it except finding and clicking the ghost pin.

**Suggested fix:** In the DeleteFactory route-removal loop, before `state.remove(COLL_ROUTES, &rid)`, remove all switches where `s.route == rid` (same code as the DeleteRoute arm), recording each into the transaction so undo restores them.

**Verifier:** Finding is accurate. One sharpening: the orphan is recoverable — SwitchDrawer includes a DELETE action (Command::DeleteSwitch, commands.rs:1290-1300), so the user can remove it by clicking the ghost pin, as the finding itself concedes; hence major, not critical. Fix is mechanical: in the DeleteFactory route-removal loop (around commands.rs:438-453), before removing each route, also collect and remove switches with `s.route == rid`, mirroring DeleteRoute's cascade at 1036-1046. Note also DeleteFactory bypasses DeleteRoute's require_planned check on routes, so the cascade must be added inline rather than by delegating to DeleteRoute.

### M2. SDD §3.1.1 'edits to built entities materialize as planned_delta' is not implemented anywhere — built-entity edits are hard-rejected and planned_delta is never written
`crates/planner-core/src/commands.rs:286` · found by *core-model*

SDD §3.1 invariant 1 (docs/04-sdd.md line 71) says: "Built entities are immutable except via import; edits to built entities materialize as `planned_delta`." The code implements only the first half: `require_planned` returns DomainError::BuiltImmutable, and a workspace-wide grep shows `planned_delta` is only ever initialized to `None` (commands.rs:507, app/src/import.rs:206,442) — no command, solver write-back, or accept path ever sets it. DECISIONS.md does not record this as an accepted deviation, and the Phase 2 roadmap row claims "planned/built dual state" was delivered.

**Failure:** User imports a save (Phase 4, shipped in this PR), producing Built factories and groups. They try to change a built group's count/clock/recipe to plan an expansion → SetGroupCount/SetGroupClock/SetGroupRecipe all error "built entities are immutable" with no planned_delta alternative. A core documented workflow (planning changes on top of the built layer) is a dead end; the spec-promised behavior does not exist.

**Suggested fix:** Either implement planned_delta materialization for edits targeting Built groups (create a Planned delta group and link it), or record the deferral explicitly in DECISIONS.md/BACKLOG and soften the SDD claim — a reviewer should not merge a doc that asserts an invariant the code half-implements.

**Verifier:** Sharpened: (1) the UI contradiction is concrete — Inspector.tsx:400's footer claims delta materialization while its clock controls (lines 172/185) dispatch unguarded and will surface BuiltImmutable errors on built groups; (2) partial mitigation exists — AddGroup does not check factory status (commands.rs:489-516), so users CAN add new ◇ planned groups inside a built factory; what is impossible is modifying a built group's count/clock/recipe, exactly what planned_delta was specified for; (3) the ui-spec's "◇ Δ#7 — 2 ITEMS PENDING BUILD" chip (docs/02-ui-spec.md:139) depends on the same missing mechanism. Severity major is correct: documented spec workflow is a reachable dead end, but no data loss or crash.

### M3. WASM t0_solve serializes the Rust Result envelope and BTreeMaps as ES Maps, so the renderer's T0 drag projection always fails and returns null
`crates/solver-wasm/src/lib.rs:13` · found by *solver*

t0_solve serializes `let result = solver::t0::solve(...)` — a `Result<SolveResult, SolveError>` — with default `serde_wasm_bindgen::to_value`. Verified against serde-wasm-bindgen 0.6.5 source: (a) Result serializes as an externally-tagged object `{Ok: {...}}` / `{Err: {...}}` (ser.rs serialize_newtype_variant), and (b) `serialize_maps_as_objects` is false by default, so `groups`/`edges`/`ports` (BTreeMaps) become ES2015 `Map` objects, not plain objects. The renderer (renderer/src/solver/t0.ts:92-99) casts the return value directly to `WasmSolveResult` and calls `Object.entries(r.groups)` — `r.groups` is undefined because the real key is `Ok` — which throws, is swallowed by the bare `catch` at t0.ts:107, and returns null. Even if the envelope were unwrapped, the Map-typed `edges`/`ports` would still break every `r.edges[id]`/`r.ports[id]` lookup downstream.

**Failure:** User drags any output-target slider: `t0SetTarget` throws internally on every frame and returns null, so `setProjected` (Inspector.tsx:63) never fires. The SDD §4 optimistic-drag feature ('renderer runs WASM T0 locally and renders italic projected values') silently never works — no projected rates, no live belt saturation during drag — with zero error surfaced. Fix: unwrap the Result in the wrapper (return Err as JsValue) and serialize with `Serializer::json_compatible()` or `serialize_maps_as_objects(true)`; add a JS-side shape/parity test.

**Suggested fix:** In t0_solve, match on the solve Result and return Err(...) across the boundary for the error arm; serialize the Ok arm with `serde_wasm_bindgen::Serializer::json_compatible()` (or `.serialize_maps_as_objects(true)`) so BTreeMaps become plain objects matching the TS `Record` types. Add a vitest that calls the built wasm and asserts the golden Modular Frame numbers (the SDD §11 'T0-WASM parity' test).

**Verifier:** Finding is fully accurate on mechanism and fix; severity downgraded from critical to major because the failure is a silent no-op, not a crash or data loss: the slider still moves (setDragValue at Inspector.tsx:58 precedes the wasm call) and release still settles authoritatively via T1, so only the live italic projections / drag-frame belt saturation feature is dead — completely and on every frame, but with graceful degradation.

### M4. T1 hard-errors ('solver internal error: infeasible') for any infeasible state it cannot fix by clamping the single edited port — dead-ending whole factories, violating SDD §5.2 'no dead ends'
`crates/solver/src/t1.rs:218` · found by *solver*

run_lp imposes strict equality `inflow == rate` on every output target (t1.rs:144), and the only fallback is the ceiling pass at t1.rs:218-228, which (a) exists only for the edited/derived SetTarget port, and (b) only clamps if find_binding locates a saturated edge or input ceiling. Verified three user-reachable failures: [1] Recompute on a multi-output factory after a belt/ceiling change that makes a fixed target unreachable → Err(Internal{"infeasible"}) (trigger_for_factory in session.rs:824-833 only converts Recompute→SetTarget for single-output factories); [2] SetTarget on an output port with no incoming edge → ceiling pass maxes t=0, find_binding returns None, no clamp, final solve `0 == rate` infeasible → Err; [3] a group whose recipe input has no wired edge (`0 == m*in_rate` forces m=0) with any nonzero target → Err. Case [3] is the normal state of every factory mid-construction. session.rs:926-933 turns the Err into error_factory, wiping all derived rates for the factory.

**Failure:** User adds a machine group, wires only its output, sets the factory target to 30/min → the entire factory panel shows 'solver internal error: infeasible' with no rates, no binding constraint, no hard-stop — the exact dead end SDD §5.2 forbids ('Infeasible → return the binding constraint'). Meanwhile the T0 preview for the same snapshot returns rates as if everything works (verified), so drag and settle disagree maximally.

**Suggested fix:** Make output targets elastic: `inflow + deficit_p == rate` with heavily-penalized deficit variables (or `inflow <= rate` plus maximization terms), so the LP always solves and per-port shortfalls become reportable deficits/bindings. Add a real SolveError::Infeasible variant instead of Internal, and extend the ceiling/clamp path to all output ports, not just the edited one.

**Verifier:** Finding is accurate and slightly understated in one respect: even when the ceiling pass runs and succeeds, a max_rate of 0 with no saturated edge/ceiling (the mid-construction case) silently discards the achievable-rate information because the clamp is gated on find_binding returning Some (t1.rs:220), so the fix needs both (a) clamping to max_rate whenever the fixed-target solve would be infeasible regardless of whether a named binding exists, and (b) a maximize-all or per-port fallback for Recompute on multi-output factories. Severity stays major (not critical): canonical state is untouched, undo works, and the dead end clears once the user wires the missing input or zeroes the target — but it is the routine state of every factory mid-construction, and the T0 drag preview (verified Ok with full rates on the same snapshot) maximally disagrees with the T1 settle.

### M5. T0 hard-stop ceiling uses two-point affine extrapolation, but flows are only piecewise-linear when any recipe has multiple outputs — producing no clamp and a wrongly-named binding
`crates/solver/src/t0.rs:238` · found by *solver*

The ceiling analysis (t0.rs:233-292) samples demand_pass at T=0 and T=1 and treats every flow as affine `f0 + T*(f1-f0)`. But group cycles are `max` over the demands of each recipe output (t0.rs:177), so for multi-output recipes (all refinery byproduct recipes) flows are convex piecewise-linear in T, and the slope measured on [0,1] is wrong beyond the kink. Verified: refinery producing plastic+residue, residue port fixed at 8/min, crude pipe capped at 300 (true plastic max 200) — on [0,1] the residue branch dominates cycles, so the crude edge shows zero sensitivity to T. Drag plastic to 500: T0 returns clamped=false, target_ceiling names the plastic belt (max_rate 780, an unrelated edge), and the crude edge flow is 750 at saturation 2.5. T1 on the same input clamps to 200 and names the crude belt.

**Failure:** During drag on any factory with a byproduct recipe, the slider does not hard-stop where it should (SDD §5.2: UI hard-stops the slider at the ceiling and names it): the preview shows belts at >100% saturation with clamped=false and a ceiling tick at the wrong place naming the wrong constraint; on release T1 snaps the target from 500 down to 200 — a large, unexplained drag-vs-settle jump. The module's own header claim ('makes the hard-stop ceiling exact') is false for multi-output recipes.

**Suggested fix:** Handle the piecewise linearity: either iterate (recompute f0/f1 with the base point at the current candidate T until the binding stabilizes — the function is convex so a ratio-test walk over the kinks terminates), or evaluate demand_pass at the requested T and bisect for the true ceiling; at minimum re-run demand_pass at the computed max_rate and reject/refine if any constraint is still violated.

**Verifier:** Sharpening: the wrongly-named T0 binding is stored in the projected DerivedFactory but the Inspector's binding strip and hard-stop read only the authoritative T1 targetCeiling (Inspector.tsx:33,56), so the wrong name is not directly displayed. The user-visible failure window is the first drag after any non-slider edit on a multi-output factory: trigger_for_factory (session.rs:825-831) falls back to Recompute when outputs.len()>1, leaving targetCeiling null, so the slider has no hard stop (sliderMax=rate*2), the drag preview shows belts >100% with clamped=false, and release snaps the target down (500→200). After one release on that port, subsequent drags hard-stop correctly via T1's ceiling. Also breaks the SDD §11 T0-vs-T1 parity-within-epsilon contract and the module's own exactness claim; fix requires per-segment slope handling (e.g. sample above every group's kink or compute ceilings per dominating output branch).

### M6. Upstream factory in an error state propagates no supply ceiling, so downstream factories silently solve as fully supplied
`crates/app/src/session.rs:921` · found by *session-empire*

In empire_solve, when a factory fails to produce a snapshot (line 898), has no groups (line 918), or its T1 solve errors (line 928), the loop `continue`s BEFORE the feed-downstream block (lines 978-1004). No entry is inserted into `supplies` for its bound out-port routes, so the downstream factory's In-port ceiling (lines 906-917) falls back to the canonical ceiling only — typically unconstrained. DECISIONS.md #31 requires In-port ceilings tightened to min(canonical, upstream supply, belt cap); an erroring upstream supplies 0, not infinity.

**Failure:** Create factory A (rod maker, no groups yet — a normal intermediate planning state), bind its Out port by route to factory B's In port, give B a screw group and target 200/min. Empire solve marks A 'no machine groups yet' but B solves unconstrained: B shows full 200/min production, its route shows flow=50 with supplied=0, and no DeficitRow is emitted — the audit DEFICITS tab and the advisor new_deficit rule both stay silent while the plan is unbuildable.

**Suggested fix:** When a factory errors or is skipped, insert supply=0 for every route bound to its Out ports (and record route_supply=0), so downstream ceilings clamp to zero and the starvation surfaces as a deficit.

**Verifier:** Confirmed exactly as described; the only mitigation is that the upstream factory itself shows an error card, but downstream solves at full target with no deficit anywhere. Fix caveat: inserting supply=0 on the error paths is insufficient alone — the deficit emitter's `ceiling.max_rate > 0.0` guard at session.rs:1070 (protecting the division at :1071) suppresses DeficitRows for zero ceilings, so a zero-supply branch must be added there too or downstream clamps to 0 still silently.

### M7. Total starvation (supply ceiling = 0) is excluded from deficit rows by the `ceiling.max_rate > 0.0` guard
`crates/app/src/session.rs:1070` · found by *session-empire*

The deficit condition is `requested > ceiling.max_rate + 1e-6 && ceiling.max_rate > 0.0`. When the upstream supply is exactly 0 (e.g., upstream target set to 0), T1's ceiling pass yields max_rate=0 with binding=InputCeiling on the dst port, the downstream solve clamps to 0 — and then the guard drops the row entirely. The guard exists to avoid the divide-by-zero in `needed = flow * requested / ceiling.max_rate` (line 1071), but it deletes the most severe deficit case instead of handling it.

**Failure:** Using the exact fixture from tests/session.rs empire_routes_propagate_supply_and_deficits: set rod_out rate to 0.0 while screw factory still targets 200/min. Partial starvation (rate 30) produces one DeficitRow, but full starvation (rate 0) produces derived.deficits = [] — the DEFICITS tab shows nothing and the advisor new_deficit card never fires precisely when the shortage is worst.

**Suggested fix:** Handle max_rate==0 explicitly: emit the row with needed derived from the requested target's input requirement (e.g., scale from the recipe or from a probe solve at the requested rate) and supplied=0, instead of guarding the row away.

**Verifier:** Sharpened: exposure is broader than target-set-to-0 — any upstream factory that hits error_factory (missing recipe/machine data, no groups, solver error; session.rs:899-932) leaves result.ports empty, so out_rate=0 (session.rs:1000) and supply=0 takes the same silent path. Also, the fix is not merely removing the guard: at max_rate=0 the route flow is also 0, so `needed = flow * requested / max_rate` is 0/0 (NaN); `needed` must come from a different source in that branch (e.g. an unclamped probe solve or the recipe input ratio for the requested target).

### M8. Factories with more than one Out port dead-end into solve_error('infeasible') on any supply dip instead of clamping
`crates/app/src/session.rs:825` · found by *session-empire*

trigger_for_factory only synthesizes a SetTarget (which enables T1's ceiling/clamp fallback pass, t1.rs:216-228) when `snapshot.outputs.len() == 1`; otherwise it returns Recompute. Under Recompute, t1 constrains every output to `inflow == rate` with no clamp path, so run_lp returns Infeasible and empire_solve replaces the whole factory with error_factory('infeasible') (line 928-933). This contradicts SDD §5.2 / t1's own header ('Infeasible → clamp to best achievable and name the binding constraint — no dead ends') and the §5.4/DECISIONS #31 contract that upstream dips surface as DEFICIT rows.

**Failure:** A factory with two Out ports (e.g., one item shipped to two consumers via two routes, or a refinery with a byproduct port) is fed by an upstream route. The user lowers the upstream target: the downstream factory is now infeasible, its entire derived block collapses to solve_error='infeasible' (no group rates, no edge flows, total_power_mw=0 — so circuit demand is silently understated too), and no deficit row is produced. The same happens on accept_proposal/import_save, which always solve with Recompute.

**Suggested fix:** Extend T1 to run the ceiling/clamp fallback on infeasibility for Recompute triggers (e.g., maximize a uniform scale factor over targets, or clamp per-port), or have the session retry an infeasible Recompute as SetTarget per output; emit the binding constraint so the deficit path works for multi-output factories.

**Verifier:** Finding is correct as written; two sharpenings. First, the dead end is not limited to fully-untouched factories: even when the trigger IS a SetTarget on one of the multi-output factory's own ports (arm 1, session.rs:812-817), the ceiling pass maximizes only the edited port while the OTHER outputs stay pinned `inflow == rate` (t1.rs:143-145), so if the dip makes the other outputs alone unsatisfiable, both run_lp calls fail and the same error_factory('infeasible') results — the clamp fallback is per-port, not per-factory. Second, one mitigation on scope: the wizard (wizard.rs:441-456) creates exactly one Out port per goal factory, so wizard-built empires only hit this after the user manually adds a second Out port (byproduct or second consumer) — a supported and UI-encouraged flow, but not the default topology, which is consistent with the phase-2 e2e (single-output chain) never catching it. Severity major stands: no canonical-state corruption (write-backs are skipped on the Err path), but the derived block dead-ends with no binding constraint named, no deficit row, and 0 MW draw silently understating circuit demand.

### M9. Persist failure after undo.commit permanently diverges disk from memory, later causing silent data loss and an undo panic
`crates/app/src/session.rs:331` · found by *session-empire*

edit() (and accept_proposal at line 437, import_save at line 593) calls `self.undo.commit(tx)` — which irreversibly appends the entry and advances the in-memory cursor — before `self.file.commit(...)?`. If the SQLite write fails (disk full, I/O error), the error propagates but the in-memory state and undo log keep the entry. PlanFile::commit mirrors only the NEW entry's forward patches into entity rows, so the failed entry's changes are never written; the next successful edit persists its own entry on top. Same pattern in undo()/redo(): UndoLog mutates state before file.checkpoint can fail.

**Failure:** Edit E1 hits a transient disk-full error (user sees an error toast but the app keeps running with E1 applied in memory). Edit E2 succeeds. On reopen, the plan is missing E1's changes but contains E2's — a silently lost edit — and the persisted undo journal no longer matches the entity rows, so a subsequent undo can hit `state.apply_batch(...).expect("inverse patch must apply cleanly")` in planner-core/src/undo.rs:88 and crash the app.

**Suggested fix:** Persist first, commit to the in-memory log only after file.commit succeeds (build the UndoEntry without mutating the log, or roll back state + pop the entry on PersistError). Replace the .expect in UndoLog::undo/redo with a recoverable error.

**Verifier:** The claimed undo panic at undo.rs:88 does not occur: PlanState::apply_batch (state.rs:290-308) is upsert/delete-based, and journal entries carry well-formed whole-entity values, so a skewed journal degrades semantically (orphaned entities after undoing past the gap) but cannot fail apply_batch. Drop that from the finding. Sharper immediate symptom to add: on the failed edit the renderer never receives the patches (error response), so the UI shows the plan without the edit while canonical Rust state has it applied — a live renderer/memory/disk three-way divergence (plan_hash mismatch, proposal staleness) even before reopen. Same pre-persist mutation pattern also in undo()/redo() (session.rs:346-362) and import_save/accept_proposal.

### M10. Surplus consumption can emit two AddRoute commands from the same source port, making the whole proposal impossible to accept
`crates/app/src/wizard.rs:656` · found by *wizard-jobs*

Phase 1 pushes one `surplus_taken` entry per (queue-pop, port) with no aggregation by port (wizard.rs:145-161). An intermediate item that is an ingredient of two stages (e.g. iron rods feeding both Modular Frames and Screws) is popped from the queue twice; if the first pop does not exhaust the surplus port's availability, the second pop taps the SAME port again, producing two `surplus_taken` entries with the same port id. Phase 4 (wizard.rs:656-716) turns each entry into an independent RouteAdd ProposalItem containing `Command::AddRoute { from: port.clone(), .. }`. `AddRoute` for cargo kinds rejects a source port that is already bound (`commands.rs:936` "a port is already bound to a route"), so the second route command fails.

**Failure:** Plan has a factory with an unbound rods OUT port producing 100/min surplus; user runs the wizard for Modular Frames with the default surplus_first=true. Rods are consumed in two pops (frames' direct rods, then screws' rods), both from the same port. The proposal drafts fine, but `Session::accept_proposal` hits the duplicate AddRoute, errors, and rolls back the entire accept — the wizard's flagship flow ends in an opaque "a port is already bound to a route" error unless the user manually excludes one surplus row.

**Suggested fix:** Aggregate `surplus_taken` by (port, item) before building RouteAdd items (sum the takes), so each source port yields exactly one AddPort+AddRoute pair.

**Verifier:** Confirmed as described. Sharpening: the code's own comment at wizard.rs:121 ("one route per port") states the invariant being violated, so this is a bug even by local intent; the natural fix is to aggregate surplus_taken by port id before phase 4 (summing take, using max tier). Note the related same-item-different-ports case is fine: the shared alias "surplus.{item}" is overwritten between ProposalItems, but sequential application in accept_proposal resolves each route before the next AddPort rebinds the symbol. Only the same-port-twice case breaks, and it fails at accept time (after drafting succeeds) with rollback of the whole proposal.

### M11. A goal item with no production stage (raw/extractable item, or alternate-only recipe) emits an edge referencing a `$g.<item>` alias that is never created, so accept always fails
`crates/app/src/wizard.rs:524` · found by *wizard-jobs*

The CREATE item unconditionally appends `AddEdge { from: EdgeEnd::Group("$g.{goal_item}"), to: "$site.out" }` (wizard.rs:524-535). The `g.<item>` alias is only registered when a stage exists for the item (wizard.rs:476), and phase 1 routes extractable items to `raw` instead of `demand` (wizard.rs:176-179), so a goal like "produce Iron Ore at 240/min" yields zero stages. The same hole opens when `craftable` (line 168, which ignores `r.alternate`) is true but `pick_recipe` with include_alternates=false (line 819) returns None — a demand entry with no stage. `resolve_aliases` errors on the unresolved `$g.…` alias, and `accept_proposal` rolls back everything.

**Failure:** User clicks FIX WITH SOLVER on an iron-ore deficit row in the audit drawer (AuditDrawer.tsx:257 prefills the wizard with the ore item) and presses SOLVE. The solver claims nodes and returns a normal-looking proposal, but ACCEPT always fails with "unresolved proposal alias g.Desc_OreIron_C" and the eval consequence silently skips the entire CREATE item — a dead-end proposal, violating the no-dead-ends principle (UI spec §171).

**Suggested fix:** When the goal item has no stage, wire `$in.{item}` (or the claim-fed in port) directly to `$site.out`, or refuse the goal up front with an Infeasible outcome naming the reason.

**Verifier:** Confirmed as described, including the second trigger: the craftable test at wizard.rs:168-175 ignores r.alternate while pick_recipe (wizard.rs:819) filters alternates, so an alternate-only-craftable goal lands in demand but gets no stage (phase-2 continue at wizard.rs:208-210) and hits the same dangling $g. alias. Two sharpenings: (1) WizardModal's own quick-fill deficit chips (WizardModal.tsx:199) are an additional entry path beyond AuditDrawer, so the bug is reachable without the audit drawer; (2) mid-chain ingredient edges are already guarded by `stages.iter().any(|s| &s.item == ing)` at wizard.rs:505 — only the goal→site.out edge at line 524 lacks the guard, so the minimal fix is to gate that edge (and arguably route $in.{goal_item} → $site.out for pure-extraction goals, or return Infeasible/relaxation per the no-dead-ends principle in wizard.rs:66).

### M12. T2 mini-proposals set goal = (product, current_rate) but the consequence evaluator measures production DELTA, so every T2 proposal renders "Goal NOT met ✗"
`crates/app/src/wizard.rs:1008` · found by *wizard-jobs*

`t2_optimize` pushes `goal.push((product.clone(), cur_rate))` — the factory's existing output rate. `Session::eval_proposal` computes `achieved` as `out_rate_of(after) - out_rate_of(before)` (session.rs:521-522) and `goal_met = achieved >= requested` (session.rs:563). A recipe swap by design keeps output constant (the point is fewer machines at the same rate), so the delta is ~0, `achieved 0.0 < requested cur_rate`, and `goalMet` is false.

**Failure:** User runs OPTIMIZE on the screw factory (80/min); T2 proposes the Cast Screw swap. The review surface footer renders the GOAL CHECK cell red: "0.0/80.0 ✗ … Goal NOT met." (ProposalReview.tsx:161-172) even though the swap preserves 80/min exactly — users are told every optimization fails its goal. The integration test (proposals.rs:542-580) never evals the T2 proposal, so this went unnoticed.

**Suggested fix:** For T2 proposals set the goal requested to 0 delta (or add a goal semantics flag: 'maintain' vs 'add'), or have eval_proposal compare absolute post-accept rate for T2Optimize-source proposals.

**Verifier:** Finding confirmed as stated, with one sharpening: the amber 'Goal NOT met.' strip (ProposalReview.tsx:161) only renders when warnings exist, which a clean swap may not produce — but the GOAL CHECK footer cell renders the red ✗ unconditionally once the consequence loads, so every T2 proposal with nonzero output shows a failed goal. Fix direction: either push the expected delta (0.0) as the T2 goal, or record goals with absolute/delta semantics and have eval_proposal compare absolute after-rates for T2Optimize proposals.

### M13. Demand-graph expansion has no cycle detection or iteration cap — cyclic recipe data (real Docs.json recycled recipes with alternates on) hangs the solve thread and grows the log buffer without bound
`crates/app/src/wizard.rs:191` · found by *wizard-jobs*

Phase 1 is a plain work-queue expansion: every pop with rate > 1e-9 pushes its recipe's ingredients (wizard.rs:191-193). The only termination guard is the rate falling below 1e-9. Real game data (SDD §7: the app parses the install's Docs.json) contains recipe cycles — Recycled Plastic ↔ Recycled Rubber — whose loop gain does not decay toward zero. With `include_alternates=true` (a UI toggle) and a plastic/rubber goal, the queue never drains: the loop spins forever, pinning a core, and each iteration appends a log line to the unbounded `Job::log` Vec that the UI polls, so memory grows steadily. Cancellation works (checked per pop) but the job never completes on its own and there is no phase timeout despite the 5-15s contract (SDD §5.5).

**Failure:** User with a real game install enables alternates and asks for Plastic at 60/min → the SOLVE phase list sits on DEMAND GRAPH forever, the log floods, memory climbs until the user guesses to hit CANCEL; solve never returns Proposal or Infeasible.

**Suggested fix:** Track visited (item, cumulative-rate) with a per-item expansion cap or max queue iterations; on hitting the cap return Infeasible naming the cycle instead of spinning.

**Verifier:** The named cycle is wrong: Recycled Plastic ↔ Recycled Rubber has round-trip gain 0.25 (6-in→12-out both ways) and self-terminates in ~40 pops. The real non-terminating cycles are the packager package/unpackage recipe pairs (gain exactly 1.0), reached in the stated scenario via Diluted Fuel → Water → Unpackage Water ↔ Package Water. The bug is broader than claimed: because the bundled world snapshot lacks oil/water nodes, any oil-based goal (e.g. Plastic) hangs even with alternates OFF, via Crude Oil → Unpackage Oil ↔ Package Oil.

### M14. Re-import cluster-to-factory matching is greedy in cluster iteration order, so a nearby new cluster can steal a built factory's match and corrupt it on accept
`crates/app/src/import.rs:288` · found by *import-advisor-chat*

diff_against_built iterates clusters in DBSCAN discovery order (which is save object order) and matches each cluster to its nearest not-yet-matched Built factory within 250 m (`Some((f, d)) if d <= REMATCH_M => { matched.insert(...) }`). Matching is first-come, not globally nearest-pair: a cluster that is 240 m from factory F can claim F before the cluster that is 5 m from F is considered.

**Failure:** Plan has Built factory F (centroid P). Player builds a new outpost ~200 m from P. On re-import DBSCAN emits C_new (the outpost) before C_old (F's machines). C_new is within 250 m of F and matches it -> drift items say all of F's real groups were 'demolished in game' and the outpost's groups were 'added'; C_old is then reported '+ NEW IN GAME'. Accepting the proposal rewrites F's Built groups to the outpost's contents and creates a duplicate factory on top of the real one.

**Suggested fix:** Match globally: compute all (cluster, built-factory) pairs within 250 m, sort by distance, and greedily take the closest pairs (or use assignment), instead of per-cluster nearest-unmatched in iteration order.

**Verifier:** Confirmed as described, with two sharpenings: (1) the corruption requires the new cluster's machines to precede the existing factory's machines in save-object order (clusters are emitted in first-member index order) — e.g., the player rebuilt F's machines after building the outpost; if the true cluster iterates first it matches correctly at d≈0 and the outpost correctly becomes NEW IN GAME. (2) Severity is tempered by the drift being a user-reviewed proposal (never auto-applied) and reversible in one undo — but the drift rows themselves are false ("demolished in game" for standing machines), so the user has no signal to reject. Fix: assign matches globally nearest-pair (or two-pass: near-zero-distance matches first, then remaining clusters), rather than first-come per cluster.

### M15. Built factories with no matching cluster (fully demolished in game) produce no drift item — re-import reports IN SYNC
`crates/app/src/import.rs:278` · found by *import-advisor-chat*

diff_against_built only iterates `clusters`; a Built factory that no cluster matches is never visited, so nothing is emitted for it. The group-level diff detects a single group vanishing inside a matched factory (`demolished in game`, count 0), but an entire factory vanishing — the more drastic drift — is silently ignored. SDD §8.4 says the snapshot 'is diffed against the current Built layer' into Create/Modify drift items; a whole factory gone is exactly such drift.

**Failure:** Plan has Built factories A and B from the first import. Player demolishes B completely in game and re-imports. Clusters = [A'] which matches A with no group changes -> items is empty -> import_save returns ImportOutcome::InSync and the UI says the built layer matches the save, while B still exists in the plan as ◆ Built and feeds solver/power/deficit math with phantom production.

**Suggested fix:** After the cluster loop, iterate Built factories not in `matched` and emit drift items (all groups -> count 0, or a factory-level 'demolished in game' op) so the user can review the removal.

**Verifier:** Finding confirmed as stated. Sharpening: SDD §8 only names Create/Modify drift items (no Delete kind), but the fix needs no new vocabulary — a vanished factory can be emitted as one UpdateGroup{count:0} Modify item per remaining group (the exact op the group-level "demolished in game" path already uses), via a post-loop pass over Built factories absent from `matched`. Minor caveat: if another unmatched Built factory sits within 250 m of the surviving cluster it could absorb the match instead, changing symptoms but not the core defect.

### M16. Group diff compares only machine count, so clock-only drift is silently reported as in sync
`crates/app/src/import.rs:305` · found by *import-advisor-chat*

In diff_against_built the matched-group arm is `Some((count, _, _)) if *count == g.count => {}` — the existing clock is captured in the tuple but never compared against the cluster's mean clock `g.clock`. SyncOp::UpdateGroup carries and applies `clock`, so clocks are only synced as a side effect of a count change.

**Failure:** Factory has a Built group of 8 smelters at 100% (imported earlier). Player overclocks all 8 to 200% in game (count unchanged) and re-imports -> no drift item is generated; if that's the only change, import_save returns InSync. The planner's Built layer now silently under-states throughput and power draw by 2x relative to the real save — 'silently-wrong math' in every downstream deficit/power calculation.

**Suggested fix:** Also emit an UpdateGroup drift item when `(existing_clock - g.clock).abs()` exceeds a small epsilon, with a 'reclocked in game' label.

**Verifier:** Core claim verified exactly as written. Two sharpenings: (1) the fix needs an epsilon comparison, not `!=` — the cluster clock is a mean rounded to 3 decimals (import.rs:141) and the stored clock is clamped (import.rs:204), both f64, so exact equality would risk false drift; empirically the stored clock survives import unchanged (the T1 write-back at session.rs:940 did not alter it in the reproduced scenario), so an epsilon compare is safe for the 'identical re-import → IN SYNC' exit criterion. (2) The 'every downstream deficit/power calculation is 2x wrong' framing is overstated: imported factories start with no ports (import.rs:224), so the empire LP solves them to zero throughput until the user wires targets, and once targets exist the solver derives clocks from the LP rather than the stored value. The concrete wrong-math surface is wherever the stored group.clock is read directly — e.g. the T2 wizard's current-rate math (wizard.rs:912-913, 997) and the group as displayed/synced state. The primary defect is the broken drift-detection contract: the planner reports IN SYNC while the save has diverged, and the only way clocks ever sync is as a side effect of a count change.

### M17. DBSCAN expansion is O(n^2) time with unbounded duplicate stack pushes — multi-second stall and potential multi-GB memory blowup on large saves
`crates/app/src/import.rs:104` · found by *import-advisor-chat*

cluster() scans all points for every popped point (`for (k, p) in pts.iter().enumerate()` inside the while loop), giving O(n^2) distance checks with no spatial index. Worse, neighbors are pushed whenever `cluster_of[k].is_none()`, and points are only marked assigned when popped — so a point already on the stack is re-pushed by every subsequently popped neighbor. In one dense/chained cluster of m machines the stack accumulates O(m^2) entries. DECISIONS.md only benchmarks 867 machines (<100 ms); megabase saves with 10k–30k manufacturers are normal Satisfactory endgame.

**Failure:** Import of a contiguous megabase save with ~20k manufacturers/generators (all chained within eps=120 m): ~4e8 hypot calls plus a scratch stack growing toward 20k^2/2 ≈ 2e8 usize entries (~1.6 GB) -> the import command stalls for seconds-to-minutes while holding the session Mutex (blocking every other IPC command; import_run is a sync Tauri command), and can abort the process on allocation failure.

**Suggested fix:** Mark points visited when pushed (not when popped) to bound the stack at O(n), and bucket points into a 120 m grid so neighbor scans only touch adjacent cells (O(n) expected).

**Verifier:** Core defect confirmed but two claims need sharpening. (1) Time: measured 1.6 s for a 20k-machine chained megabase in an optimized standalone build — 'multi-second', yes, but 'minutes' only at far larger n or much slower hardware; quadratic growth means 30k → ~3.6 s+. (2) Memory: the multi-GB stack requires a mutually-within-eps clique of ~20k points; a realistic chained/grid layout peaks at only ~14 MB, while a dense clique of 10k measured 399 MB. The clique case is plausible (not pathological) only because line 105 clusters on XY and ignores Z, so vertically stacked megabase floors collapse onto one pad. Two independent fixes: mark points visited at push time (eliminates the O(m²) duplicate-push amplification, one-line change) and use a spatial grid hash keyed at eps to replace the O(n) inner scan (drops time to ~O(n·neighbors)).

### M18. Arming state (active_keys) and debounce timestamps are not persisted, so every app restart re-fires duplicate cards for still-true conditions
`crates/app/src/advisor.rs:233` · found by *import-advisor-chat*

AdvisorState persists `cards` and `muted` (loaded in session.rs:252-258) but `active_keys` and `last_fire` are in-memory only and cards don't record their condition key, so they can't be reconstructed. After reopen, the first edit runs gate() with an empty active_keys: every condition that was already true (node conflict, deficit, hot route, thin power margin, open drift proposal) counts as 'newly armed' and fires a brand-new card, which is persisted alongside the identical card from the previous session.

**Failure:** User has one unresolved node conflict and an open drift proposal, closes the app nightly for a week -> the feed accumulates 7 duplicate 'Node X is double-booked' cards and 7 duplicate drift cards (all persisted via save_advisor_card), directly violating the fires-only-when-condition-BECOMES-true contract (DECISIONS.md Phase-5 gating entry) and the anti-nag design.

**Suggested fix:** Persist condition keys (e.g. store `key` on AdvisorCard and seed active_keys from non-dismissed loaded cards on open, or persist active_keys/last_fire in the meta table).

**Verifier:** Two sharpenings. First, the duplicate fires on the first advise() after reopen, which happens on the first edit/undo/redo/re-import — not on hydrate itself (hydrate() at session.rs:274 only calls solve_all_readonly); a session where the user merely views the plan produces no duplicates, so "7 duplicates in 7 nightly sessions" assumes at least one edit per session (realistic for dogfooding). Second, there is a partial user escape hatch: dismissing a duplicate mutes its whole rule persistently (session.rs:654-668), stopping future re-fires — but at the cost of silencing the rule for ALL conditions, which is itself a distortion of the anti-nag contract (the user must choose between accumulating duplicates and never hearing about new conflicts). Same-rule duplicates within one gate pass also fold to one card via the 30s debounce, so the accumulation is one duplicate per rule per session, not per condition. Fix requires persisting active_keys (or recording the condition key on cards and re-priming active_keys from undismissed persisted cards at load).

### M19. Conditions suppressed by debounce (or pause) are still recorded as seen, so they can never fire — a second simultaneous deficit is permanently silent
`crates/app/src/advisor.rs:295` · found by *import-advisor-chat*

gate() sets `self.active_keys = current` from ALL evaluated events, including ones skipped because `debounced` was true (line 276) or because `self.paused` (line 268). A condition swallowed by the 30 s per-rule debounce is armed as 'already active' and will never produce a card unless it fully clears and reappears. The spec/DECISIONS contract is 'at most once per rule per 30 s' — a delay, not permanent suppression. The unit test ('debounce folds same-rule bursts') enshrines the drop.

**Failure:** Accepting one proposal starves factories A and B at once -> two new_deficit events in the same gate call; only A's card fires, B's key enters active_keys. B stays starved for days and the advisor never mentions it (badge shows 1 issue). Same mechanism: any conditions that appear while the advisor is paused are permanently swallowed on unpause.

**Suggested fix:** Only insert into active_keys the events that actually fired plus those already in active_keys; leave debounced/paused-suppressed keys out so they re-arm on the next gate pass.

**Verifier:** Sharpened: simultaneity is not required — any new same-rule condition arising within 30 s of the last fire is permanently swallowed (advise() runs per edit, session.rs:638-644, so two edits seconds apart starving different factories hits this), making the bug far more common than the two-deficits-in-one-call framing. Restart does not recover the lost card: active_keys/last_fire are unpersisted, so all persisting conditions re-arm, the first same-rule event re-fires (duplicating its card) and the rest are re-debounced deterministically. The pause half of the finding is also mechanically real (line 295 arms keys while the paused loop is skipped), though DECISIONS.md only specs 'never while paused', leaving unpause behavior undocumented rather than violated. Mitigation keeping this at major rather than critical: the audit drawer's DEFICITS tab still lists the swallowed deficit, so only the advisor feed/badge under-reports, not the product as a whole. Fix direction: only insert keys into active_keys for events that actually fired (or that were skipped solely because !newly_armed), so debounced/paused edges re-arm on the next gate.

### M20. Rolling .bak is taken by copying only the main DB file before opening — it clobbers the previous good backup with a possibly stale or torn snapshot
`crates/persist/src/plan_file.rs:47` · found by *persist-gamedata, security-robustness*

PlanFile::open does `std::fs::copy(&path, path.with_extension("ficsit.bak"))` before Connection::open. The file runs in WAL mode, so after a crash/kill the last session's committed transactions live in `world.ficsit-wal`, not the main file. The copy (a) ignores the -wal sidecar, so the .bak silently lacks every commit since the last checkpoint, and (b) if the crash happened mid-checkpoint, the main file alone is not a consistent database, so the .bak is corrupt. Worse, the copy happens unconditionally before any integrity/open check: if world.ficsit itself is corrupted, open() overwrites the only good .bak with the corrupt bytes and then fails — destroying exactly the backup the mechanism exists to provide.

**Failure:** App crashes mid-session (WAL holds the session's commits). User relaunches: .bak is replaced with a pre-session (or torn) snapshot. If the main file is then found corrupt — the one scenario where .bak matters — restoring the .bak loses the whole session, or the .bak itself fails to open. SDD s10's 'rolling .bak on open' safety net is defeated in the crash case.

**Suggested fix:** Open the database first (letting SQLite recover the WAL), verify with `PRAGMA integrity_check` or at least a successful open, then produce the .bak via the SQLite backup API or VACUUM INTO (which snapshots main+WAL consistently). Never overwrite an existing .bak until the live file has been validated.

**Verifier:** Confirmed as written. One sharpening: in the pure crash-relaunch case (no corruption), the live DB is fine — Connection::open at line 49 recovers the WAL — so sub-claim (a) only makes the .bak stale, not the working data lost; the acute damage is the clobber path (c), where a corrupt main file overwrites the good .bak and then open() fails, leaving zero usable copies. Fix shape: open the connection first (which recovers the WAL), and only after a successful open/integrity check take the backup via the SQLite backup API or VACUUM INTO — never a raw pre-open file copy of a WAL database. Severity major stands: it silently defeats a documented data-safety mechanism but does not corrupt live data in normal operation.

### M21. Variable-power manufacturers get power_mw ~= 0 from real Docs.json — Particle Accelerator/Converter/Quantum Encoder draw is silently omitted from power planning
`crates/gamedata/src/docs.rs:278` · found by *persist-gamedata*

The `"FGBuildableManufacturer" | "FGBuildableManufacturerVariablePower"` arm reads `power_mw: f(c, "mPowerConsumption")` for both. In real Docs.json, variable-power machines (Build_HadronCollider_C, Build_Converter_C, Build_QuantumEncoder_C) carry their real draw in mEstimatedMininumPowerConsumption / mEstimatedMaximumPowerConsumption (e.g. 250-750 MW), while mPowerConsumption is ~0. The parser explicitly opts these machines in but ignores the fields that hold their consumption.

**Failure:** With a real Docs.json, a factory full of Particle Accelerators shows ~0 MW load; circuit margin math (OK/WARN/CRIT grammar) reports healthy headroom on a grid that would brown out in game — silently wrong power results for late-game plans. The fixture has no variable-power machine, so tests never exercise it.

**Suggested fix:** For FGBuildableManufacturerVariablePower, use the mean of mEstimatedMininumPowerConsumption and mEstimatedMaximumPowerConsumption (the game's stated average draw) when mPowerConsumption is 0, and add a fixture entry covering it.

**Verifier:** Confirmed as described. Sharpening: severity stays major (not critical) because it only manifests with a real game install's Docs.json — the bundled fixture path and all tests are unaffected — and only for the three FGBuildableManufacturerVariablePower classes. A correct fix should average mEstimatedMininumPowerConsumption/mEstimatedMaximumPowerConsumption (note the "Mininum" typo is genuine in Docs.json), or better, use the per-recipe mVariablePowerConsumptionConstant + mVariablePowerConsumptionFactor/2 since draw varies by recipe, not just machine.

### M22. Backend edit rejections are unhandled everywhere — validation failures become silent no-ops with no user feedback
`renderer/src/state/store.ts:153` · found by *renderer-state*

backend.edit() throws on 422 (DomainError: Invalid, BuiltImmutable, NotFound — commands.rs has ~19 Invalid validation sites, including junction port caps at commands.rs:725-759), but store.dispatch has no catch and the store's `error` field is only set in hydrate(). Every one of the ~50 call sites uses `void dispatch(...)` (grep shows no catch around any of them), so a rejected edit is an unhandled promise rejection: nothing happens on screen and the user gets zero feedback. In multi-step async flows it's worse: RoutePopover.confirm (renderer/src/map/RoutePopover.tsx:99-141) awaits dispatch — a throw aborts before onClose(), leaving the popover stuck open, and if the second dispatch (add_route) fails after the first (add_port) succeeded, an orphan IN port is committed to the plan.

**Failure:** In the factory graph, user drags a second input connection onto a splitter (in-cap 1): Rust rejects with DomainError::Invalid, the renderer draws nothing, shows no message, and logs only an unhandled rejection — the user cannot tell why the connect 'did nothing'. Drawing a route whose add_route command fails leaves a dangling rate-0 port in the plan and a frozen popover.

**Suggested fix:** Catch rejections in store.dispatch, surface them (toast/status strip via a store error field), and return a result the async flows can branch on; wrap RoutePopover.confirm in try/finally so onClose always runs.

**Verifier:** Finding confirmed as stated, with two sharpenings: (1) the count is ~45 `void dispatch` call sites, not ~50; (2) RoutePopover.tsx:119's comment "two commands, one undo step" is also factually wrong in the current code — the two commands go through two separate backend.edit transactions (RoutePopover.tsx:132 and 135), so besides the orphan-port-on-failure hazard, even the success path creates two undo entries; batching both commands into one dispatch would fix both the atomicity and the undo granularity. The mitigating factor keeping this at major rather than critical: junction cards do display live port usage ("1/1 IN", JunctionNode.tsx:53), so the user has ambient cap information — but the rejected action itself still yields zero feedback, and the stuck popover plus committed orphan port are genuine state corruption from the user's perspective.

### M23. Cmd/Ctrl+Z performs a plan-level undo even while the user is typing in a text input, silently mutating the plan and killing native text undo
`renderer/src/App.tsx:34` · found by *renderer-ui*

The global key handler runs `if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); void (e.shiftKey ? redo() : undo()); }` with no e.target check, unlike the Tab and 'a' branches right below it which do exclude HTMLInputElement/HTMLSelectElement. The app has many text inputs: the ⌘K SearchBox, factory rename input (SummaryDrawer), elevation input, chat composer, wizard rate/constraint inputs, AddGroupMenu/AddPortMenu query fields, clock fine input.

**Failure:** User is renaming a factory (or typing in advisor chat / search), makes a typo, presses Cmd+Z to undo the typo -> native text undo is preventDefault'ed AND the last plan command (e.g. the node claim or group they just created) is silently undone behind the drawer. The user thinks they edited text; the plan changed.

**Suggested fix:** Guard the undo/redo branch with the same target check used for Tab/'a' (and include the chat/search inputs), or check document.activeElement is not an editable element.

**Verifier:** Confirmed for the rename, elevation, search (⌘K), AddGroupMenu and AddPortMenu inputs. One correction: the advisor chat composer is NOT affected — AdvisorPanel.tsx:322 calls e.stopPropagation() on every keydown, so Cmd+Z there never reaches the global handler. Fix is the same guard the sibling branches already use (skip when e.target is an input/textarea/select or contentEditable).

### M24. Rail/truck/drone routes are never drawn on the map and are absent from the audit SATURATION tab — they become invisible and unselectable, violating A3.1
`renderer/src/map/MapView.tsx:158` · found by *renderer-ui*

The canvas data sync builds route render data with `.filter((r) => r.kind.kind === "belt")` and power lines with `kind === "power"`; rail/truck/drone routes match neither, so MapCanvasLayer never receives them and hitTestRoute can never return them. AuditDrawer.tsx:92 likewise does `if (r.kind.kind !== "belt") continue;`. docs/03-addendum-a.md A3.1 says "the throughput vs demand line carries the flow color and drives the route's encoding on the map", and DECISIONS.md records no deviation.

**Failure:** Right-drag a route between two factories >=800 m apart -> RoutePopover defaults to RAIL -> CONFIRM. A drawer opens, but no line appears on the map. Click anywhere to deselect: the rail route is now invisible on the map, un-clickable (hitTestRoute only sees belt routes), and missing from the audit SATURATION rows — the entity is unreachable from every primary surface. Same happens instantly when switching an existing belt route to RAIL in the KindSwitcher: the line vanishes while its drawer is open.

**Suggested fix:** Include rail/truck/drone routes in the canvas routes array (with their transport throughput as capacity, distinct dash/pattern per kind) and in the audit saturation rows.

**Verifier:** Confirmed end-to-end. Sharpening: the drawer opens on creation (selection set by RoutePopover) and the transport math/solver capacity are intact — the defect is purely that non-belt cargo routes have no map rendering, no hit-test, and no audit rows, making them unreachable after deselection (only undo can remove one, since delete requires selecting it). Also reproduces via RouteDrawer's kind switcher (RouteDrawer.tsx:263): switching belt→rail makes the line vanish on the next data sync while its drawer is open. hitTestPower cannot compensate since powerLines is filtered to kind==="power".

### M25. Backend command rejections are unhandled at every dispatch call site — failed edits silently desync the UI (e.g. Delete on a built entity clears selection and does nothing, with an unhandled promise rejection)
`renderer/src/graph/GraphView.tsx:505` · found by *renderer-ui*

store.dispatch (renderer/src/state/store.ts:153) awaits backend.edit with no error handling, and every UI call site fires it as `void dispatch([...])` (GraphView Backspace/Delete handler, RouteDrawer DELETE, SummaryDrawer, Inspector, NodeDrawer, AuditDrawer UPGRADE TIER, etc.). planner-core rejects many plausible commands (commands.rs BuiltImmutable for delete/modify of ◆ built entities imported from a save; built pins locked). The rejection surfaces nowhere — no toast, no error state; it is an unhandled promise rejection.

**Failure:** After a save import, the user selects an imported ◆ built machine group in the graph view and presses Delete. GraphView dispatches delete_group and immediately runs setSelection(null); the backend returns BuiltImmutable, dispatch rejects unhandled. The card stays, selection is gone, no feedback of any kind — the user cannot tell whether the delete worked, and any transient backend failure (dev-bridge restart, IPC error) makes every edit silently vanish the same way.

**Suggested fix:** Catch in store.dispatch, surface the DomainError (status strip/toast) and skip the optimistic UI steps (e.g. don't clear selection before the dispatch resolves); alternatively hide/disable delete affordances for built entities.

**Verifier:** Confirmed, with one sharpening: "silently desync the UI" is inaccurate — dispatch throws before its set() runs and the backend rolls back partial batches (session.rs:311-317), so renderer state stays consistent with canonical state. The actual defect is that every edit rejection (BuiltImmutable on built entities, validation errors, transient IPC/dev-bridge failures) produces zero user feedback anywhere in the app — only an unhandled promise rejection — plus the Delete handler clears selection even when the delete was refused. The store already has an `error` field but it is only wired to hydrate.

### M26. RoutePopover advertises 'CONFIRM ⏎' but Enter is not wired; instead MapView's Enter handler can switch to factory view, unmounting the popover and losing the route draft
`renderer/src/map/RoutePopover.tsx:192` · found by *renderer-ui*

The primary button reads `CONFIRM ⏎` but RoutePopover installs no keydown handler. Meanwhile MapView's window keydown (MapView.tsx:394) runs unconditionally while the popover is open: `e.key === "Enter" && selection?.kind === "factory"` -> setView({mode:"factory"}).

**Failure:** User left-clicks the source pin (selection = factory), right-drags to a target pin, the popover opens, user presses Enter as the button instructs -> the app dives into the factory graph view; MapView (and the popover) unmount and the drafted route is discarded. With no factory selected, Enter simply does nothing — the labeled shortcut is dead either way.

**Suggested fix:** Add a keydown listener in RoutePopover (Enter -> confirm, Escape -> onClose, stopPropagation), and suppress MapView shortcuts while the popover is open.

**Verifier:** Sharpened: the discarded work is only the popover's transient choices (candidate/transport/tier) — no committed plan data is lost and undo is unaffected; the primary harm is an advertised shortcut triggering surprise navigation into the factory graph. Also note: if focus is on a popover radio/select, Enter is swallowed by the MapView guard (:381) and simply does nothing — the shortcut is dead or destructive, never functional. Fix is either a keydown handler in RoutePopover (Enter→confirm, plus stopping propagation) or gating MapView's Enter branch on the popover being closed.

### M27. The Playwright e2e suite — the project's only automated coverage of the renderer and every phase exit criterion — is never run in CI
`.github/workflows/ci.yml:40` · found by *tests-ci*

ci.yml has three jobs (rust, shell, renderer); the renderer job runs only `pnpm typecheck` and `pnpm build`. There are no renderer unit tests anywhere (renderer/package.json has no test runner, no *.test.* files exist), so the five specs in renderer/e2e/ are the sole automated verification of the UI, the Web Worker save parser, undo keybindings, the wizard, proposals, and the advisor. README.md line 10 claims "every exit criterion is covered by the e2e suite" and each phase in DECISIONS.md is closed as "e2e-verified", but nothing gates merges on those tests actually passing.

**Failure:** A PR that breaks the renderer (e.g. the undo keyboard handler, the import wizard, or the proposal review flow) passes all CI checks green and merges to main; windows.yml then immediately auto-publishes a GitHub Release (v0.1.<run#>) of the broken build to end users, with no automated signal that the exit-criterion behavior regressed.

**Suggested fix:** Add a CI job that installs Playwright browsers (`pnpm exec playwright install --with-deps chromium`), builds the dev-bridge, and runs `pnpm exec playwright test` (the config already boots the bridge + vite itself); make windows.yml's release job depend on it or on the CI workflow.

**Verifier:** Sharpened: it is worse than the finding states — windows.yml's release job does not depend on the CI workflow at all, so a main push whose ci.yml run fails (even typecheck) can still publish a Release; e2e-in-CI is also demonstrably feasible since playwright.config.ts self-spawns the dev-bridge headlessly. One softening caveat: docs/00-handoff.md:46 prescribed CI as only "(fmt, clippy, test, tsc)", so the initial CI scaffold matched the handoff — but that predates the e2e suite and no DECISIONS.md/BACKLOG.md entry accepts leaving e2e ungated while auto-releasing.

### M28. Hardcoded machine-specific absolute path makes the e2e suite unrunnable on any other checkout
`renderer/e2e/phase4-import.spec.ts:8` · found by *tests-ci*

`const SAVES = "/home/user/Conveyancer/fixtures/saves";` bakes this specific machine's checkout location into the spec. The .sav fixtures are committed to the repo (fixtures/saves/), so the suite is meant to be portable — README's Testing section tells any developer to run `cd renderer && pnpm exec playwright test` — but `chooser.setFiles(`${SAVES}/${file}`)` resolves against the absolute path, not the repo.

**Failure:** Anyone cloning the repo to a different directory (a teammate's machine, a GitHub Actions runner at /home/runner/work/...) runs the suite per README; phase4-import.spec.ts throws ENOENT in setFiles, the phase-4 test fails, and because later specs consume state left by earlier ones, phase-5 assertions on the imported world fail too. This also silently blocks ever adding the e2e suite to CI (finding 1) until fixed.

**Suggested fix:** Resolve relative to the spec file: `const SAVES = path.resolve(__dirname, "../../fixtures/saves")` (or `new URL("../../fixtures/saves", import.meta.url)`).

**Verifier:** Core claim confirmed. One sharpening: the knock-on claim that phase-5 assertions fail is overstated — phase5-advisor.spec.ts does not reference the imported Dunarr world (no "Dunarr"/"IRON INGOT WORKS" matches), so the direct blast radius is the two phase-4 tests plus any exit-criterion checks that count imported factories; README does say the suite shares one backend serially, so residual coupling is possible but unproven. Fix is one line: derive the path from the spec location, e.g. `const SAVES = path.resolve(__dirname, "../../fixtures/saves")` (or fileURLToPath(new URL("../../fixtures/saves", import.meta.url)) under ESM).

### M29. Backend command rejections are silently swallowed renderer-wide: dozens of `void dispatch(...)` call sites with no catch, no global unhandledrejection handler, and no error-display surface
`renderer/src/graph/GraphView.tsx:488` · found by *cross-cutting*

dispatch() awaits backend.edit(), which rejects on any DomainError (422 from the dev bridge, Err from the Tauri command). Nearly every mutation call site voids the promise: GraphView.tsx:488 (onConnect add_edge), 505-508 (Delete key), Inspector.tsx (clock/floor/tier edits), RouteDrawer.tsx, SummaryDrawer.tsx, AuditDrawer.tsx, AddPortMenu.tsx, etc. planner-core enforces real invariants only on the backend side — junction port caps (commands.rs:738 'has all N input ports connected'), single-item junctions (commands.rs:759), BuiltImmutable on delete/edit of built entities, port-already-bound, invalid tier. The renderer pre-validates none of these, and there is no toast/banner/status-bar error UI anywhere (only the hydrate-failure screen), nor a window 'unhandledrejection' listener in main.tsx/App.tsx.

**Failure:** User drags a second input belt into a splitter on the graph canvas (or presses Delete with an imported ◆ built group selected): the backend rejects the command with a precise DomainError message, the promise rejection is discarded by `void`, and the UI does absolutely nothing — no edge appears, no message, just an unhandled promise rejection in the devtools console. The user cannot tell a rejected command from a rendering bug.

**Suggested fix:** Catch rejections inside store.dispatch (and undo/redo/acceptProposal) and route the DomainError message to a small status-bar/toast surface; that single choke point fixes every call site without touching the `void dispatch` idiom.

**Verifier:** Confirmed with sharpening: (1) backend check line numbers are commands.rs:826-834 (junction port caps) and 846-852 (single-item junction), not 738/759; (2) the defect is worse than stated on the Delete path — GraphView.tsx:509 calls setSelection(null) unconditionally after the voided dispatch, so a rejected delete of a built entity also clears the selection, making it look like the delete succeeded; (3) no client desync occurs (store only updates on success), so severity stays major (silent no-op UX, not corruption); (4) besides the 44 `void dispatch` sites, a few awaited callers (AddGroupMenu, AddPortMenu, RecipeStrip) also lack catches since dispatch returns Promise<Id[]>. Cleanest fix is a single catch inside store.dispatch that surfaces the DomainError message via a transient error field/toast, rather than patching 44 call sites.


## Minor (30)

### M1. MoveFactoryPin refreshes route endpoint waypoints but leaves priority-switch positions at the stale midpoint, detaching switch pins from their lines
`crates/planner-core/src/commands.rs:363` · found by *core-model*

MoveFactoryPin rewrites path[0]/path[last] of every route anchored on the moved factory so the line tracks the pin (lines 360-386). PrioritySwitch.position is computed once at AddPrioritySwitch time as the midpoint of the line (lines 1206-1220) and is never updated when the underlying route path moves. The entity doc (entities.rs:312) and A2.3 both define the switch as a pin "sitting ON a power line".

**Failure:** Factory A—B power line with a priority switch at its midpoint; drag factory A's pin across the map (or edit its elevation). The route polyline moves but the switch square stays at the old midpoint, now floating in empty space disconnected from any line — persisted that way in the plan file.

**Suggested fix:** In MoveFactoryPin, after updating a route path, recompute the midpoint for every switch whose `route` is the touched route and upsert it into the same transaction (or derive the switch's render position from the route path instead of persisting it).

**Verifier:** Sharpened: the switch is only visually/geometrically detached — it stays logically bound via sw.route, remains clickable, and shedding math (shedsAtMw, circuit derivation) is unaffected since it keys off route+priority, not position. The elevation-edit sub-case (SummaryDrawer z edit) causes no visible x/y drift, only a stale 3D midpoint z. Fix belongs in MoveFactoryPin: after refreshing a power route's path, recompute the midpoint for switches whose sw.route matches the touched route.

### M2. AddEdge validates Junction endpoints but not Group/Port endpoints — dangling or cross-factory EdgeEnd references are accepted
`crates/planner-core/src/commands.rs:719` · found by *core-model*

The AddEdge arm checks the parent factory exists and enforces junction port budgets/item purity for EdgeEnd::Junction ends (lines 719-768), but EdgeEnd::Group and EdgeEnd::Port ids are never checked for existence, nor that they belong to the stated `factory`; from == to self-loops are also accepted. The module header claims commands "validate invariants (§3.1)", and the command layer is also exposed verbatim over the headless dev-bridge HTTP API, so callers other than the well-behaved React Flow drag path exist.

**Failure:** A dev-bridge client (or a renderer race where a group is deleted while a connect-drag is in flight) dispatches add_edge with a just-deleted group id: the command succeeds, creating a BeltEdge whose endpoint references nothing. React Flow silently drops the edge from the canvas but the phantom edge persists in canonical state and the plan file, is counted by the solver's per-item conservation pass, and can never be selected/deleted through the UI.

**Suggested fix:** Mirror the junction checks: for EdgeEnd::Group/EdgeEnd::Port, require the referenced entity to exist and its `factory` field to equal the edge's `factory`; reject from == to.

**Verifier:** Finding is accurate as written. Sharpening: the fix belongs in the AddEdge loop at commands.rs:719 — extend it to look up EdgeEnd::Group in state.groups and EdgeEnd::Port in state.ports (mirroring the Junction NotFound lookup) and verify each end's .factory matches the command's `factory` field; optionally reject from == to. Severity stays minor because the well-behaved renderer path always passes live ids — the trigger requires a dev-bridge client or a delete/connect race — but the consequence (phantom edge persisted in the plan file, invisible and unselectable in React Flow, yet participating in t0 flow-share distribution) is a genuine integrity hole, not stylistic.

### M3. Built-immutability enforcement is inconsistent: RenameFactory, SetEdgeTier, and SetRouteTier skip require_planned (RenameFactory is reachable today on imported Built factories)
`crates/planner-core/src/commands.rs:340` · found by *core-model*

MoveFactoryPin, DeleteFactory, SetGroupRecipe/Count/Clock/Floor, DeleteGroup/Port/Edge/Route/Junction, SetRouteSpec and SetSwitchPriority all call require_planned, but RenameFactory (line 340), SetEdgeTier (line 783), SetRouteTier (line 995), SetPortRate/SetPortCeiling and ReleaseNode do not. SetRouteTier vs SetRouteSpec is directly contradictory: both mutate Route.kind, one is guarded (line 972 "respec") and one is not. Import (crates/app/src/import.rs:212,226) creates Built factories and groups, so the RenameFactory gap is reachable in shipped functionality; the edge/route/port gaps are latent until those entity types can be Built.

**Failure:** Import a save → factory "IRON INGOT WORKS 1" is Status::Built. RenameFactory succeeds and directly mutates the Built layer, contradicting SDD §3.1.1 and the pattern every sibling command enforces. When routes/edges gain Built status in a later import iteration, SetRouteTier and SetEdgeTier will silently mutate built infrastructure while SetRouteSpec refuses.

**Suggested fix:** Add require_planned to SetEdgeTier and SetRouteTier for consistency with SetRouteSpec; decide explicitly whether rename/rate/ceiling are planner-side metadata exempt from §3.1.1 and record that in DECISIONS.md.

**Verifier:** Severity minor is correct: the only reachable violation today (RenameFactory on imported Built factories) has benign functional impact, because re-import matching is positional (nearest Built factory within REMATCH_M, import.rs:279-288), not name-based — so a rename cannot break drift detection; the harm is an invariant/consistency regression that the codebase explicitly promised "can never regress when import lands." Two sharpenings: (a) do not lump MovePortCard/MoveGroupCard into the fix — their unguarded status is documented and intentional (DECISIONS.md graph_pos entry: geometry is planner-owned, Principle 5), which is also a hint the fix may want to treat rename as either a guarded semantic edit (add require_planned(f.status, id, "rename")) or an explicitly documented planner-metadata exception in DECISIONS.md; (b) the SetRouteTier gap is the most defensible latent fix since SetRouteSpec already refuses the identical mutation of Route.kind at commands.rs:972.

### M4. undo()/redo() panic via .expect() when a persisted journal batch fails to apply, crashing the app instead of surfacing an error
`crates/planner-core/src/undo.rs:88` · found by *core-model, cross-cutting*

UndoLog::undo and ::redo call `state.apply_batch(&batch).expect(...)`. apply_batch returns Err for any patch whose collection name is unknown to Entity::from_value (state.rs:140) or whose entity JSON fails deserialization. The undo journal is hydrated from the on-disk SQLite plan file (hydrate/hydrate_with_cursor), so the batch content is external input, not process-local invariant: a plan file whose journal was written by a newer app version with an additional collection or field-shape change, or a partially corrupted file, will deserialize as UndoEntry (forward/inverse are raw PatchOps) yet fail apply_batch.

**Failure:** User opens a plan file last saved by a newer build that added a new entity collection to a journal entry, then presses Cmd+Z past that entry → apply_batch returns Err("unknown collection ...") → expect() panics and the whole app aborts, instead of refusing the undo with an error message.

**Suggested fix:** Return Result<Option<PatchBatch>, String> from undo/redo (restoring the cursor on failure) and surface the error through the session layer; alternatively validate the journal against known collections at hydrate time and truncate/refuse unusable tails.

**Verifier:** Sharpening: (1) the panic is only reachable via Add/Replace ops — inverse Remove ops for unknown collections are silently ignored (state.rs:246), so the trigger is undoing a delete (or redoing a create) of an entity from an unrecognized collection, or an entity JSON that fails deserialization; (2) impact is worse than a single crash in the Tauri app: main.rs guards Session with Mutex + .lock().unwrap(), so the panic poisons the mutex and every subsequent command panics — the app is bricked until restart; (3) fix is low-friction since Session::undo/redo already return Result<_, SessionError>.

### M5. ordered_included silently drops included items whose depends_on form a cycle (or reference an excluded item), and accept still reports full success
`crates/app/src/session.rs:1333` · found by *proposals-transport*

ordered_included loops until no progress and returns only placeable items. An item in a dependency cycle (A depends_on B, B depends_on A, both included) never satisfies `deps_ok` (session.rs:1342-1344) so the loop exits with both dropped; likewise an included item whose dependency is excluded fails `deps_included` (session.rs:1345-1348) and is dropped. accept_proposal (session.rs:392) then materializes the surviving subset and flips the status to Accepted with no error, no warning, and no indication in EditResponse that checked rows were skipped. Current in-repo generators (wizard.rs, import.rs, t2_optimize) emit acyclic deps, but Proposal payloads arrive via the generic CreateProposal command over the dev bridge / IPC, and the code comment itself anticipates invariant-violating states ('the toggle cascade should prevent that state, but accept must never guess') yet guesses silently instead of failing.

**Failure:** A proposal created via the dev bridge (or a future generator bug) carries two mutually-dependent items, both checked. User clicks ACCEPT: the response is Ok, the proposal shows ACCEPTED, but neither item's commands were applied — the plan silently lacks entities the review screen showed as included, with no warning anywhere.

**Suggested fix:** After the placement loop, compare placed count against the included count (excluding items skipped because a dependency is legitimately excluded) and return an error — or at minimum surface skipped item labels in the accept response, mirroring eval_proposal's warnings.

**Verifier:** Finding is accurate; two sharpenings. (1) It understates reach: arbitrary CreateProposal payloads flow through the production Tauri `plan_edit` command (main.rs:23), not just the dev bridge. (2) One softening: eval_proposal (session.rs:466) uses the same ordered_included, so the consequence preview shown before accept is consistent with what accept actually applies (a dropped cyclic pair shows zero delta) — the lie is confined to the CHECKED item rows and the successful ACCEPTED outcome, not the consequence numbers. The excluded-dep skip is documented as intentional in the code comment (1330-1332), but silently succeeding is not; the cycle drop is entirely undocumented emergent behavior. Fix direction: after the loop, if out.len() != included count, return an error (matching the abort-before-commit policy DECISIONS.md line 41 establishes for unresolved aliases), or validate depends_on at CreateProposal time. Severity minor stands: all in-repo generators emit acyclic consistent deps, so this needs a raw command payload or future generator bug to trigger.

### M6. Wizard proposal route row renders belt tier and belt-capacity projection even when pick_transport selected rail or drone
`crates/app/src/wizard.rs:632` · found by *proposals-transport*

The delivery-route ProposalItem builds `detail` as `"{goal_name} {rate}/min · MK.{tier}"` and `impact` as `proj {100 * goal_rate / belt_capacity(tier_for(goal_rate))}%` (wizard.rs:632-641) regardless of `picked`, while the actual AddRoute command correctly uses the rail/drone RouteKind (wizard.rs:642-647). A3.3 (docs/03-addendum-a.md line 68) binds the row format for rail picks to consists + projection + distance ('⟶ RAIL — ... · 2 CONSISTS · proj 62% · 3.4 km'). Since rail is picked precisely when rate >= 480/min or distance >= 800m, the belt-based percentage is computed against the wrong capacity for the transport actually proposed.

**Failure:** Wizard solves a 600/min goal 3 km away: pick_transport returns rail, but the review row reads 'MK.6' with a belt-capacity projection (e.g. 'proj 77%' vs Mk.6's 780/min) instead of the rail consist utilization — the displayed utilization number is silently wrong for the route the accept will create (rail_math capacity is ~5x larger), and the A3.3-mandated row format (transport kind, consists, km) is absent.

**Suggested fix:** Branch on `picked`: for rail compute proj against rail_math(dist, spec, stack).throughput_per_min and render consist count + km; for drone likewise against drone_math; keep the MK.x/belt-capacity form only for belt picks.

**Verifier:** Confirmed, with corrections to the example: tier_for(600) = Mk.5 (780/min per BELT_CAPACITY at entities.rs:113), not Mk.6 — the cited "proj 77%" matches Mk.5. Also the ROUTING log line (wizard.rs:615-626) does print the picked transport kind and km, so the defect is confined to the user-facing ProposalItem row: wrong capacity basis for the projection and missing A3.3-mandated kind/consists/distance fields. Command payload is correct, so accepted plans are unaffected — display-only, severity minor stands.

### M7. T0 weights open (un-ceilinged) input ports at 0 when splitting demand, routing all demand to ceilinged inputs and producing a false hard-stop that T1 contradicts
`crates/solver/src/t0.rs:133` · found by *solver*

In `pull`, an incoming edge from an Input port is weighted by `p.ceiling.unwrap_or(0.0)` (t0.rs:129-134). An open input (ceiling=None, i.e. unlimited per model.rs:82 'None = open') gets weight 0, so when a consumer is fed the same item by one bound/ceilinged port and one open port, 100% of demand is assigned to the ceilinged edge and the open one carries nothing. Verified: group fed ore by port i1 (ceiling 120) and open port i2; target 300 → T0 clamps at 120 (edge from i2 carries 0) while T1 solves the same snapshot unclamped at 300.

**Failure:** Factory with one route-bound input and one open manual input for the same item: during drag the slider hard-stops at the bound route's ceiling (120) with an InputCeiling binding; on release T1 settles at the full requested rate (300) — a visible drag/settle disagreement in the conservative direction, and the projected group counts/clocks during drag are correspondingly wrong.

**Suggested fix:** Give open inputs a non-zero weight — e.g. treat ceiling=None as effectively unbounded (weight = remaining demand, or split equally among open inputs first) — so the T0 distribution can actually use unlimited sources, matching what the T1 LP will do.

**Verifier:** One correction to the failure narrative: the slider's hard-stop and the binding strip use the AUTHORITATIVE T1 ceiling (renderer/src/graph/Inspector.tsx:33 `authoritative?.targetCeiling`), not T0's, so the user is not actually stopped at 120 and can drag/commit 300. What is wrong is everything T0-projected during drag: the italic target readout (Inspector.tsx:113 reads df.ports), group counts/clocks, and edge flows/saturations all reflect the 120-clamped solve while the handle reads 300, then jump on the release settle. Additionally, even below the false ceiling the split itself is wrong (100%/0% vs T1's fill), so drag-time belt saturation on the ceilinged edge is overstated and the open edge shows dead. Root cause is a semantic inversion at t0.rs:133-134: None means "open/unlimited" but is weighted as 0; a large finite weight (or f64::INFINITY handled as "absorb residual") for None inputs fixes it. Minor severity stands: authoritative results and the actual slider stop are correct; only drag-frame projections diverge, in the conservative direction.

### M8. Clamp write-back after editing an In port's rate overwrites it with the solver's intake value, not a clamped target
`crates/app/src/session.rs:957` · found by *session-empire*

solve_trigger converts any SetPortRate — including on an In port — into T0Edit::SetTarget. For the owning single-output factory, trigger_for_factory falls through to the synthesized out-port SetTarget; if that stored out target exceeds the achievable ceiling, result.clamped is true. The write-back block then looks up the ORIGINAL trigger port: for an In port, `result.ports.get(port)` returns the port's *used intake* (t1.rs:294-300), and `p.rate = *rate` overwrites the user's just-typed In-port rate with that intake figure inside the same undo entry.

**Failure:** Factory has one Out port whose stored target already exceeds its supply ceiling (state is clamped). User edits an In port's rate to 100 via SetPortRate: the committed undo entry contains a solver write-back that silently rewrites that In port's rate to e.g. 37.5 (the intake flow), so the value the user entered never sticks and the clamp-only-for-out-targets rule is violated in spirit (the written value is unrelated to any target clamp).

**Suggested fix:** Gate the clamp write-back on the trigger port being an Out port (direction check on self.state.ports.get(port)), or have solve_trigger only emit SetTarget for Out-direction ports.

**Verifier:** Mechanics confirmed, but impact is narrower than the failure text implies: no shipped UI surface issues set_port_rate on an In port (Inspector.tsx:31,72 binds the slider only to the out-direction port; wizard.rs:539,752 target out ports), the solver snapshot ignores In-port rate entirely (session.rs:756-760 uses rate_ceiling for inputs), and the renderer displays the derived intake preferentially anyway (BoundaryPortNode.tsx:24 — stored rate is only a fallback when no derived value exists). So the corruption is reachable only via the raw command API (dev-bridge, tests, programmatic clients) and rewrites a field that is semantically inert to the solver. It remains a genuine command-layer defect — a committed undo entry silently replaces the value the same command batch just set, violating the DECISIONS.md:31 clamp-only-the-edited-port intent in spirit — and the cheap fix is to gate the write-back (or solve_trigger's SetTarget conversion) on the port being direction Out. Minor is the correct severity.

### M9. Multi-item goals: only goal.items[0] gets an out port, output edge, rate and delivery route — machines for the other goal items are proposed with their output wired to nothing
`crates/app/src/wizard.rs:435` · found by *wizard-jobs*

`WizardGoal.items` is a Vec and phase 1/2 expand and build stages for every goal item, but the CREATE item adds a single out port for `goal.items.first()` (wizard.rs:435-456), one output edge (line 524), one SetPortRate (line 536), and the title/best_rate/relaxations all use `.first()` (lines 327-343, 368). A second goal item's stage group is still created and counted in machines/power, but its product has no out edge or port — dead machines. The shipped UI and chat only ever send one item, so this is reachable only via the dev-bridge/Tauri API today, but the UI spec (02-ui-spec.md:150) specifies "+ ADD GOAL" multi-goal input, and nothing in DECISIONS.md records dropping it.

**Failure:** A dev-bridge caller posts goal items [(Rods, 60), (Plates, 40)]: the accepted proposal builds and powers plate constructors whose output is unconnected, the proposal title/goal-check only mention rods, and the plates goal silently reads 0 achieved.

**Suggested fix:** Either reject len > 1 goals explicitly at the API boundary, or loop the out-port/edge/SetPortRate/route block per goal item.

**Verifier:** One correction: "silently reads 0 achieved" is overstated — eval_consequence (session.rs:515-524, 563) checks every goal item, so the review surface would show plates achieved ≈ 0 and goal_met=false. The defect is real regardless: the proposal itself is malformed for items[1..] (dead powered machine groups, node claims feeding them, no out port/edge/rate/route, title and delivery mention only the first item), and nothing blocks accepting it. Severity minor is correct — shipped UI (WizardModal.tsx:77,316,327,339) and chat (chat.rs:292) always send exactly one item, so today only dev-bridge/Tauri API callers can hit it; it is a spec-gap on a not-yet-shipped multi-goal input rather than a shipped-path bug.

### M10. Infeasible relaxations promise "allow N more node claim(s) → rate ✓" even when no eligible nodes remain, and N is computed with a hardcoded 120/min
`crates/app/src/wizard.rs:340` · found by *wizard-jobs*

The first relaxation is always emitted with a ✓ (wizard.rs:340-344), computed as ceil(short/120.0) — 120 is the Mk.2/normal-purity rate; impure or pure nodes make N wrong. Worse, when the binding is "no eligible nodes left" (candidates exhausted rather than budget exhausted), raising the node budget cannot help, yet the relaxation still claims the full goal rate with a checkmark. Mock 5c / UI spec §153 define relaxations as one-tap fixes "with costs" — advertising an impossible relaxation as ✓ breaks that contract.

**Failure:** All matching nodes are already claimed; the wizard returns Infeasible with binding "iron ore extraction short 240/min (no eligible nodes left)" plus relaxation "allow 2 more node claim(s) → 8.0/min ✓"; the user re-solves with node_budget+2 and gets the identical infeasible result.

**Suggested fix:** Only emit the node-claim relaxation when the budget was the binder; size N from the actual purities of the remaining unclaimed candidates.

**Verifier:** Confirmed as described, with one sharpening: the ✓ is unverified even in the budget-exhausted case — the code never checks whether the remaining (unclaimed, floor-passing) candidates can actually supply the shortfall, so the ✓ can overpromise there too, not only when candidates are fully exhausted. Also, with purity_floor=impure, N understates the needed claims (impure nodes give 60/min, half the assumed 120), so following the relaxation exactly can still yield Infeasible even when eligible nodes remain. Minor is the right severity: it is misleading advisory text on an already-infeasible path, and the other relaxations (purity floor, accept best achievable) remain valid escape hatches.

### M11. JobRegistry never evicts finished jobs — logs and outcomes accumulate for the life of the process
`crates/app/src/jobs.rs:59` · found by *wizard-jobs*

`JobRegistry::start` inserts into the HashMap and there is no removal anywhere (no eviction on done, no TTL, no delete endpoint in dev_bridge.rs/main.rs). Every solve retains its full log Vec (hundreds of lines) and serialized outcome (the whole Proposal JSON) until app exit. Cancelled jobs are retained too.

**Failure:** A long planning session with repeated re-solves (the wizard's RE-SOLVE loop is a spec'd flow, 02-ui-spec.md:152) grows memory monotonically; combined with the unbounded log of a runaway solve this is the process's only unbounded collection.

**Suggested fix:** Drop the registry entry once the client has read a done outcome, or cap the registry (LRU of the last few jobs).

**Verifier:** Finding is accurate as written. Sharpened: growth is bounded per job by the solve's log + one Proposal JSON, and jobs are only created by explicit user actions (one per /api/wizard/solve or Tauri wizard_solve invoke), so this is a slow leak requiring many re-solves or a runaway solve's large log to matter — minor is the correct severity. Simplest fix: evict or truncate a job's log once its outcome has been fetched, or cap the registry (e.g. keep only the most recent N/one job, since the UI only ever polls the latest job id).

### M12. Rate parse failure in 'produce X at Y' is misreported as an item-match failure
`crates/app/src/chat.rs:156` · found by *import-advisor-chat*

The success guard is `if let (Some((class, display)), true) = (item, rate > 0.0)`; every other case — including item matched but rate unparseable or zero — falls through to the reply 'I couldn't match "{item}" to an item in the catalog'. Rate parsing rejects locale decimals ("22,5") and trailing words ("produce iron rod at 30/min please" -> token "30/min" because trim_end_matches runs before split_whitespace, so the '/min' suffix isn't stripped when followed by more text).

**Failure:** User types 'produce iron rod at 30/min please' or 'produce iron rod at 22,5/min' -> item matches fine, rate parses to 0 -> chat replies that "iron rod" isn't in the catalog, sending the user hunting for a naming problem that doesn't exist.

**Suggested fix:** Split the failure paths: if the item matched but rate <= 0, reply about the rate format; strip '/min' per-token after split_whitespace (and consider accepting comma decimals).

**Verifier:** Finding is accurate. Sharpened: line 156's single fallback reply conflates three distinct failures (item unmatched, rate unparseable, rate <= 0) and always reports the item-match failure. Impact is bounded to a misleading chat error message in the offline heuristic engine — no state mutation or wrong proposal occurs, and the reply's suggested example ("produce Iron Rod at 30/min") happens to be a working recovery path. Fix: branch the error on item.is_some() vs rate > 0.0, and strip the "/min" suffix per-token (or after split_whitespace) so trailing words don't defeat it.

### M13. Every divergent re-import drafts a new SaveReimport proposal without closing or deduplicating prior open ones, accumulating stale drift proposals and repeat advisor cards
`crates/app/src/session.rs:613` · found by *import-advisor-chat*

import_save's re-import path always creates a fresh Proposal from the diff; an earlier still-open SaveReimport proposal for the same (or older) drift is left in Draft/Reviewing forever. Each open drift proposal independently fires the drift_detected advisor rule (new proposal id = new condition key), and accepting the newest one leaves the older ones stale but open in the review UI, where accepting an outdated one would apply obsolete SyncOps to the Built layer.

**Failure:** User re-imports three times while playing (drift each time) -> three open RE-IMPORT proposals in the review surface and three drift cards; accepting proposal #1 after #3 re-applies old counts on top of the just-synced Built layer.

**Suggested fix:** On re-import, auto-reject (or delete) prior open SaveReimport proposals before creating the new one.

**Verifier:** Finding confirmed as written, with one aggravating detail: the PLAN DRIFT audit tab (renderer/src/audit/AuditDrawer.tsx:31-33) selects the drift proposal via Object.values(...).find(), which returns the OLDEST open SaveReimport proposal, so after repeated re-imports it renders stale rows as current game drift and its REVIEW button routes the user into the obsolete proposal. Mitigations keeping it minor: accept is a single undoable entry, a subsequent re-import produces a corrective diff, each newer proposal is a cumulative superset of the older ones, and the review banner shows STALE. Fix direction: on the re-import path, reject/supersede open SaveReimport proposals before creating the new one (and/or block accept when input_hash mismatches for sync-op proposals).

### M14. gamedata.sqlite cache (db::write/read/build_matches) is dead code — the SDD s7 'normalized gamedata.sqlite keyed by game build' pipeline is never wired up
`crates/gamedata/src/db.rs:25` · found by *persist-gamedata*

No code outside crates/gamedata/src/db.rs calls write(), read(), or build_matches(); the app re-parses Docs.json (or the bundled fixture) on every Session::with_file. SDD s7 specifies 'parse Docs.json at onboarding -> normalized gamedata.sqlite keyed by game build version. Re-parse when install build changes', and DECISIONS.md (buildables catalog entry) claims buildables are 'persisted in gamedata.sqlite' — neither is true in the shipped wiring. The module is tested but unreachable in the product.

**Failure:** No user-visible corruption, but the documented cache/re-parse-on-build-change behavior does not exist: every app start pays a full Docs.json parse, build-change detection via the stored game_build never happens, and DECISIONS.md records a persistence behavior the code does not have — misleading for the next maintainer.

**Suggested fix:** Either wire Session/app startup through db::write + db::read keyed by detected build (with build_matches gating re-parse), or amend DECISIONS.md/SDD to record that gamedata is re-parsed per launch and delete or feature-gate the unused module.

**Verifier:** Finding is accurate and can be sharpened: machine_power (db.rs:120) and manufacturer_for (db.rs:125) are also test-only, so the entire db.rs public surface is unreachable from the product. Compounding the doc drift, DECISIONS.md:30 affirmatively records persistence behavior that does not exist, so this is both dead code and an incorrect decision-log entry, not an accepted deviation.

### M15. No in-flight request serialization: a stale EditResponse can clobber newer state, and rapid repeated edits are lost
`renderer/src/state/store.ts:152` · found by *renderer-state*

dispatch(), undo(), redo(), and acceptProposal() each await the backend and then unconditionally apply the response (patches, derived, planHash, canUndo, advisor) with no sequence number, queue, or in-flight guard. The backend serializes execution (Mutex in main.rs / single-threaded dev_bridge), but nothing orders response *application* in the renderer. Patches are whole-entity Replace ops, so applying response A after response B silently reverts the entity to A's value while Rust canonical state holds B's. Compounding this, Session::edit runs the empire solve plus a SQLite commit synchronously (crates/app/src/session.rs:298-335), so round trips routinely take tens of ms — easily long enough for a second user action to start before the first settles. There is also the stale-read variant: Inspector's floor stepper (renderer/src/graph/Inspector.tsx:201-210) computes `floor: selectedGroup.floor + 1` from the not-yet-settled projection, so two quick clicks both send floor=1.

**Failure:** User double-clicks the floor '+' stepper within one round-trip: both dispatches send floor=1 (one increment lost). Or: user makes edit A then edit B quickly (or hits Cmd+Z while an edit is in flight) over the HTTP dev-bridge on separate connections; B's response resolves first, then A's late response overwrites plan entities, derived rates, planHash, and undo flags with stale values — the renderer permanently disagrees with Rust canonical state until the next successful edit or full rehydrate, with no error shown.

**Suggested fix:** Serialize backend mutations through a promise chain/queue in the store (each dispatch awaits the previous), or attach a monotonically increasing seq to each request and drop any response whose seq is lower than the last applied one.

**Verifier:** Downgrade from major to minor and narrow the claim: the "stale EditResponse clobbers newer state / renderer permanently disagrees with Rust" scenario does not occur, because both transports deliver responses in backend execution order (single-threaded tiny_http loop; Tauri mutex + ordered IPC), and applying execution-ordered responses always converges the projection. The real defect is only the optimistic read-modify-write race in UI steppers (Inspector floor stepper, and similarly the clock input): rapid repeated clicks within one round trip compute the next value from stale projected state, losing increments and creating redundant undo entries. State stays consistent and self-correcting; fix belongs in the widgets (disable while in flight, or send relative/queued commands) rather than a global response sequencer.

### M16. ImportOutcome discriminant mismatch: TS declares "in_sync" but Rust serializes InSync as "inSync"
`renderer/src/state/types.ts:515` · found by *renderer-state*

Rust `ImportOutcome` (crates/app/src/session.rs:157) uses `#[serde(rename_all = "camelCase", tag = "outcome")]`, so the InSync variant serializes as `{"outcome":"inSync"}`. The TS union declares `{ outcome: "in_sync" }`. "imported" and "drift" happen to match, but the third arm never can. ImportModal.tsx:53-64 only works by accident because it checks "imported" and "drift" and treats everything else as in-sync via the trailing else.

**Failure:** Any code that does the natural discriminated-union check `outcome.outcome === "in_sync"` (which the published TS type invites, and which TypeScript will happily narrow) is dead code — e.g. an in-sync-specific message or test assertion silently never fires; conversely exhaustiveness checks on the union are wrong.

**Suggested fix:** Either change the TS literal to "inSync" or add `rename_all = "snake_case"` semantics for the tag on the Rust enum (e.g. `#[serde(tag = "outcome", rename_all = "snake_case", rename_all_fields = "camelCase")]`) so both sides agree.

**Verifier:** Finding is accurate as stated. Sharpened: no current runtime misbehavior exists — ImportModal's trailing else masks the mismatch — so this is a latent wire-contract bug, correctly rated minor. The most damning angle is that TypeScript inverts safety here: the compiler forbids the correct check ("inSync" is not assignable to the union) and blesses the wrong one ("in_sync"), so any future in-sync-specific branch or exhaustive switch will silently never fire. One-line fix: change types.ts:515 to `{ outcome: "inSync" }` (or add `#[serde(rename = "in_sync")]` to the InSync variant in session.rs).

### M17. Parse worker has no onerror handler and is never terminated on modal close — stuck 'PARSING…' dead end and a runaway worker on huge saves
`renderer/src/import/ImportModal.tsx:30` · found by *renderer-state, renderer-ui*

start() creates the worker and installs only onmessage. parseWorker.ts catches exceptions inside its own onmessage, but a worker script/module load failure (bundling, CSP in the packaged Tauri app) or an onmessageerror never produces a message — worker.onerror/onmessageerror are not set, so the modal stays on the 'PARSING …' phase forever, contradicting the module's own 'no dead ends' contract (parse failure is supposed to degrade to SKIP — MANUAL ENTRY). Additionally, if the user clicks the × close button while a large .sav (the SDD cites a 21k-buildable fixture) is parsing, onClose unmounts the modal but nothing terminates the worker: it keeps decompressing and parsing the whole save and holds the transferred ArrayBuffer plus the decompressed body in memory until it finishes.

**Failure:** Worker module fails to load in a production build → user sees 'PARSING mysave.sav…' indefinitely with no error state and no SKIP button (the parsing phase renders no footer). Or: user cancels a 200 MB save mid-parse → CPU and hundreds of MB of memory stay pinned by an orphaned worker.

**Suggested fix:** Set worker.onerror/onmessageerror to transition to the error phase, keep the worker in a ref, and terminate it in a useEffect cleanup / onClose path.

**Verifier:** Three corrections: (1) it is not a literal dead end — the header × close button (ImportModal.tsx:80) renders in every phase including parsing, so the user can always escape to manual entry; what's missing is the error message/SKIP footer, not an exit. (2) The orphaned worker is transient, not a leak: the onmessage closure keeps the worker alive and worker.terminate() (line 32) still runs when the parse completes, so CPU/memory are pinned only for the remaining parse duration. (3) The worker-load-failure trigger is speculative — crates/app/tauri.conf.json:27's CSP (default-src 'self', no worker-src override) permits Vite's same-origin bundled module worker; the realistic uncovered path is a file.arrayBuffer() rejection (unhandled because start() is void'd), and onmessageerror is practically impossible for the plain-JSON payload. Fix: add worker.onerror, catch in start(), and terminate the worker in a useEffect cleanup.

### M18. Port-then-route creation is two separate edit transactions, not the claimed single undo step
`renderer/src/map/RoutePopover.tsx:132` · found by *renderer-state, renderer-ui*

The comment at line 128 says 'two commands, one undo step', but the code issues two sequential dispatch() calls (add_port at 132, add_route at 135). Session::edit commits one undo entry per call, so this produces two undo entries. The Rust command layer explicitly supports multi-command atomic transactions (Vec<Command> per edit, one Transaction), but it can't be used here because add_route needs the created port id — there is no $alias mechanism on the plan.edit path (only in proposals).

**Failure:** User draws a route to a factory lacking a matching IN port, then presses Cmd+Z expecting the route drawing to revert: only the route disappears; a dangling rate-0 IN port remains on the destination factory (visible in the graph view), requiring a second undo the user has no reason to expect.

**Suggested fix:** Support id aliases in plan.edit (as proposals already do) so add_port + add_route can go in one transaction, or add a combined add_route_with_port command; at minimum fix the comment and make undo labels reflect two steps.

**Verifier:** Finding is correct as stated. Sharpening: DECISIONS.md line 19 explicitly documents the analogous claim flow (claim_node + add_port) as "one undo step", so this is a deviation from the project's own recorded convention, not merely a stale comment. The stray port is rate 0 so solver math is unaffected; impact is a misleading comment, a surprising two-step undo, and a dangling IN port visible in the graph view. A proper fix needs either $alias support on the Session::edit path or a merge-with-previous-entry flag; at minimum the comment at RoutePopover.tsx:119 should be corrected.

### M19. Wizard solve/poll chain has no error handling — any backend failure freezes step 2 forever with a blinking cursor and no message
`renderer/src/wizard/WizardModal.tsx:84` · found by *renderer-ui*

`solve` awaits backend.wizardSolve and the recursive `poll` awaits backend.wizardProgress with no try/catch anywhere; both are invoked as `void solve()` / `void poll()`. TauriBackend.wizardProgress explicitly throws 'unknown job', and BridgeBackend.call throws on any non-OK response or network error. A rejection stops the polling chain permanently.

**Failure:** Backend restarts (or the job is evicted) mid-solve -> wizardProgress rejects -> unhandled rejection, polling stops, the wizard sits on step 2 showing the ▉ cursor indefinitely with no error text; the user only escapes by guessing to press CANCEL.

**Suggested fix:** Wrap the poll body in try/catch; on error show an inline failure state (mirroring the infeasible strip) and return to step 1.

**Verifier:** Confirmed as described, with one correction: the user is not trapped by 'guessing' — step 2's footer shows a visible CANCEL button (lines 349-359) and ESC closes the modal, so the escape hatch is obvious even if the failure is silent. The defect is the silent, permanent stall with no error feedback (affects both solve-launch failure and mid-poll failure, and also the un-guarded `dispatch` at line 100). Minor severity is correct.

### M20. OUTPUT TARGET slider commits only on ArrowLeft/ArrowRight keyup — ArrowUp/ArrowDown/Home/End/PageUp changes are projected but never dispatched
`renderer/src/graph/Inspector.tsx:129` · found by *renderer-ui*

onChange sets dragValue and a T0 projection for every value change, but onRelease is wired only to onPointerUp and to keyup of ArrowLeft/ArrowRight. Range inputs also respond to ArrowUp/ArrowDown, Home, End, PageUp/PageDown.

**Failure:** Keyboard user focuses the slider and presses ArrowUp a few times: the readout changes (italic projected), dragValue stays non-null so the component considers itself mid-drag indefinitely, and set_port_rate is never dispatched — the canonical plan silently keeps the old rate while the UI shows the new one until some later pointerup or Left/Right press.

**Suggested fix:** Commit on any relevant keyup (or on blur), e.g. treat Home/End/Up/Down/PageUp/PageDown the same as Left/Right, plus an onBlur fallback release.

**Verifier:** Confirmed as described. Sharpened: the stuck state also keeps the readout in italic "projected" style indefinitely (line 106, dragging true), and the stale dragValue is flushed only by a later pointerup on the slider or a Left/Right keyup — at which point the old buffered value commits, possibly surprising the user. Fix is trivial: commit on any keyup that changed the value (or add onBlur={onRelease}).

### M21. GraphView calls setView (Zustand set + backend saveViewState) during render when the open factory disappears
`renderer/src/graph/GraphView.tsx:524` · found by *renderer-ui*

`if (!factory) { setView({ mode: "map" }); return null; }` executes inside the render body. setView synchronously updates the store (re-rendering App and other subscribers during GraphView's render — React 'Cannot update a component while rendering a different component') and fires a backend.setViewState network call from render.

**Failure:** User creates a factory, opens it, presses Ctrl+Z (undoing the creation) -> plan.factories[factoryId] is gone -> GraphView renders and mutates global state mid-render. Today it yields a React error-level warning and a render-phase side effect; under StrictMode/concurrent re-renders the backend call can fire twice and the update can be dropped/re-scheduled unpredictably.

**Suggested fix:** Move the fallback into a useEffect (`useEffect(() => { if (!factory) setView({mode:"map"}) }, [factory])`) and render null meanwhile.

**Verifier:** Confirmed as described. Sharpening: the trigger is any path that removes the open factory — Ctrl+Z after creating it (App.tsx:36-38), or undo/redo of a factory deletion — since undo()/redo() never reconcile `view` with the patched plan. The UI does self-correct (App re-renders to MapView), so impact is a React 'update during render' error-level warning plus a duplicated backend.setViewState call under StrictMode double-render; minor is the right severity. Fix: hoist the fallback into a useEffect (e.g. `useEffect(() => { if (!factory) setView({mode:"map"}) }, [factory, setView])`) and render null while !factory, or reconcile view inside undo()/redo() in store.ts.

### M22. Right-drag route draft cannot be cancelled with Escape and gets stuck if the mouse is released outside the map container
`renderer/src/map/MapView.tsx:385` · found by *renderer-ui*

The draft is cleared only in onMouseUp, which is attached to the map container and only for e.button === 2. The Escape branch of the key handler clears placing/selection but never routeDraft. If the right button is released outside the window (or over the drawers/top chrome, which sit above the map and swallow the mouseup), the ghost line and the 'RELEASE OVER A FACTORY' hint persist, and the ghost keeps following the cursor on the next mousemove.

**Failure:** User right-drags from a pin, drags off the window edge (or over the summary drawer) and releases -> the blueprint ghost line and hint banner are stuck; Escape does not dismiss them; the only recovery is another right-click-release over the map, which is undiscoverable.

**Suggested fix:** Listen for mouseup on window instead of the container, and clear routeDraft in the Escape branch.

**Verifier:** Finding is accurate. Sharpened: the draft can only ever be cleared by a right-button mouseup delivered to the Leaflet container element itself; releases outside the window, over the top chrome, or over drawers (all siblings of the map container, so no bubbling into it) leave routeDraft set forever, and Escape is a no-op for it. Fix options: attach the mouseup listener to window instead of the container, and/or add routeDraft clearing to the Escape branch at line 410.

### M23. dev-bridge grants Access-Control-Allow-Origin: * to an unauthenticated API that reads and mutates the plan, so any web page can silently rewrite and exfiltrate the developer's world
`crates/app/src/bin/dev_bridge.rs:18` · found by *security-robustness*

Every response carries `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type`, and the OPTIONS arm (lines 61-62) returns 204 with those headers — i.e., the server actively approves cross-origin preflights. There is no token, no Origin/Host check, and all mutating endpoints (/api/edit, /api/import/run, /api/proposal/accept, /api/wizard/solve) plus full-state read (/api/hydrate) are open. Binding to 127.0.0.1 does not protect against the user's own browser: with ACAO:* any site can both send requests and read the responses (DNS rebinding not even required). Mutations are committed to the sqlite plan file (dev-world.ficsit), so the damage persists. DECISIONS.md documents the bridge's existence but not this exposure, and the wildcard is unnecessary: the renderer reaches the bridge through Vite's same-origin /api proxy (renderer/vite.config.ts:12-17), which needs no CORS at all. /api/wizard/solve also spawns an unbounded OS thread + full state clone per request, so a hostile page can DoS the machine.

**Failure:** Developer runs the dev-bridge (the documented headless workflow) and browses any malicious/compromised web page in a normal browser. The page fetches http://127.0.0.1:8791/api/hydrate (reads the entire plan + gamedata), then POSTs /api/edit or /api/import/run — the plan is silently modified and persisted; or it loops POST /api/wizard/solve spawning solver threads until the machine is unusable.

**Suggested fix:** Drop the CORS headers entirely (the Vite proxy makes requests same-origin), or restrict ACAO to http://localhost:5173 and validate the Host header; optionally require a token passed via env to both bridge and renderer.

**Verifier:** All code claims are accurate and the cross-origin scenario genuinely occurs. Downgrading major->minor for real-world impact: dev_bridge is a dev/CI-only binary that is never part of the shipped Tauri bundle, and it operates on a throwaway dev world (dev-world.ficsit) holding a game factory plan rather than sensitive data; the DoS is local-only. The fix is still cheap and correct (drop the wildcard / add an Origin allowlist since the renderer reaches the bridge via Vite's same-origin proxy).

### M24. Malformed Docs.json panics the app at startup, while an unreadable FICSIT_DOCS_JSON path is silently swallowed and the fixture catalog is used instead
`crates/app/src/main.rs:175` · found by *security-robustness, cross-cutting*

Lines 171-173: `std::env::var("FICSIT_DOCS_JSON").ok().and_then(|p| std::fs::read(p).ok())` — a typo'd or unreadable path is silently discarded and the bundled fixture is loaded, so the user believes they are on the real catalog but every import degrades to `solve_error` with no hint why (contradicting the 'honest degradation' posture in DECISIONS.md). Conversely, if the file reads but is not valid Docs.json (truncated download, wrong file), parse_docs errors and line 175 `.expect("session open")` panics inside setup — the window never appears and the user gets no diagnostic. The same silent-swallow exists in dev_bridge.rs:40-42.

**Failure:** User sets FICSIT_DOCS_JSON to a truncated or wrong file: app process dies on launch with a console-only panic ('session open'), no window, no error dialog. User sets it to a mistyped path: app launches on the fixture catalog and real-save imports show unexplained unsolved factories.

**Suggested fix:** Report a read failure (log + surface in onboarding card) instead of .ok(); on parse failure, fall back to the fixture with a visible warning rather than panicking in setup.

**Verifier:** Two sharpenings: (1) the panic is not diagnostic-free — SessionError derives Debug (session.rs:30), so the stderr panic message includes "Docs.json parse failed: {e}"; the real gap is no window/dialog. (2) The silent-swallow half is worse than stated: the onboarding card's CATALOG label comes from FICSIT_GAME_BUILD (main.rs:174), so with both env vars set and a typo'd path the UI actively claims a real game build while running the fixture — and the card never shows on a non-empty plan anyway. dev_bridge.rs:40-42 duplicates the swallow.

### M25. Request bodies are read into memory with no size limit
`crates/app/src/bin/dev_bridge.rs:59` · found by *security-robustness*

`request.as_reader().read_to_string(&mut body)` buffers the entire body with no cap; tiny_http streams whatever Content-Length (or chunked stream) the client declares. Combined with the open CORS/no-auth posture above, any local process or web page can POST an arbitrarily large body.

**Failure:** A client POSTs a multi-gigabyte body to any /api endpoint; the bridge allocates it all, exhausting memory / getting OOM-killed and taking the dev session down.

**Suggested fix:** Reject requests whose Content-Length exceeds a sane cap (e.g. 16 MB — import snapshots are the largest legitimate payload) and read via a .take()-limited reader.

**Verifier:** Confirmed as written, with impact correctly capped at minor: the loopback bind means the only attackers are same-machine processes (which could kill the bridge anyway) or a web page POSTing cross-origin to 127.0.0.1 — and the worst outcome is the dev/CI bridge process OOMing, not a production service. Fix is one line: wrap the reader in .take(MAX) (e.g. a few MiB) or reject requests whose Content-Length exceeds a cap before reading. Note the body is also read for GET and OPTIONS requests, so the cap should apply universally.

### M26. Auto-generated release tags v0.1.<run_number> share a namespace with hand-pushed v0.1.* tags, so a collision publishes a new binary under a tag pointing at a different commit
`.github/workflows/windows.yml:81` · found by *tests-ci*

The workflow header documents two release paths: every push to main auto-tags `v0.1.<run_number>`, and "pushing a v* tag by hand releases under that exact version". These collide: run_number increases monotonically (including runs from claude/** branch pushes and workflow_dispatch that never release), so if a human ever hand-pushes a v0.1.N tag, a later main push whose run_number reaches N makes softprops/action-gh-release find the existing tag and attach the freshly built exe to the OLD commit's tag/release instead of creating a new one — binary and tag commit silently disagree. Relatedly, the release uploads only dist-win/FICSIT-Planner.exe (line 83) while the run artifact also carries README.txt with the WebView2 requirement and FICSIT_DOCS_JSON/FICSIT_AI_KEY docs — Release downloaders (the primary channel per the header comment) never see it.

**Failure:** Maintainer hand-tags v0.1.60 on an old commit for a hotfix re-release; weeks later the windows-build workflow's 60th run fires on a main merge, and the release step attaches the new main-built exe to the existing v0.1.60 tag/release — users downloading "v0.1.60" get a binary built from a commit the tag does not point to, with no error anywhere.

**Suggested fix:** Derive the auto tag from something collision-free (e.g. v0.1.<run_number>+<short-sha>, or read the version from Cargo.toml and fail if the tag exists), or reserve a distinct prefix for auto tags (build-N). Add dist-win/README.txt to the release `files:` list.

**Verifier:** Collision is forward-only: it requires the hand-pushed v0.1.N to have N greater than the workflow run counter at tag-push time (run numbers are monotonic and never reused; pushing a tag that already exists is rejected by git). So it is a latent hazard contingent on a maintainer choosing a version inside the auto-tag namespace — which the header comment invites without warning. Fix is cheap: move auto tags to a distinct namespace (e.g. v0.1.<run>-main or use run_id/date), or pass target_commitish/fail_on_unmatched semantics plus a tag-existence check before releasing. The README.txt-missing-from-release remark bundled into the finding is a separate completeness nit, not part of this defect.

### M27. Top-level fs.rmSync in the config re-executes in every Playwright worker process, unlinking the live plan database out from under the running dev-bridge
`renderer/playwright.config.ts:9` · found by *tests-ci*

The plan-file cleanup (lines 6-13) runs as a module side effect of playwright.config.ts. Playwright evaluates the config file in the main process AND again in each worker process (a documented gotcha). The webServer dev-bridge starts after the main-process evaluation and opens /tmp/ficsit-e2e-world.ficsit; then the first worker spawns, re-evaluates the config, and rmSync unlinks the SQLite file (plus -wal/-shm) while the bridge holds it open. On Linux the bridge keeps writing to the unlinked inode, so tests pass, but the on-disk plan file the suite claims to exercise ("the journal lives in the plan file", exit-criterion.spec.ts line 230) ceases to exist for the entire run.

**Failure:** A test fails mid-suite and you go to inspect /tmp/ficsit-e2e-world.ficsit to see what state the core was in — the file is gone (it was unlinked seconds after the bridge created it). Any future change that reopens the plan path mid-run (bridge restart, a second Session, a globalSetup that seeds the file) silently reads a brand-new empty database instead of the suite's state.

**Suggested fix:** Move the cleanup into a `globalSetup` script (guaranteed to run exactly once, before webServers), or guard the rm with `if (!process.env.TEST_WORKER_INDEX)`.

**Verifier:** Sharpening: with workers:1 the unlink fires once at first-worker spawn AND again on every worker restart (each test failure/retry spawns a fresh worker that re-runs the config side effect), so mid-suite the freshly recreated -wal/-shm can be unlinked repeatedly. The .bak filename also matches: PlanFile::open writes path.with_extension("ficsit.bak") = /tmp/ficsit-e2e-world.ficsit.bak, which the config's `${planFile}.bak` removes. Fix is to move the cleanup into a globalSetup (Playwright's documented home for run-once side effects) or guard it so it only runs in the runner main process.

### M28. CI gates token drift but not WASM-solver drift: a crates/solver change without regenerating renderer/src/wasm/pkg ships divergent T0 math with green CI
`.github/workflows/ci.yml:27` · found by *tests-ci*

The committed renderer/src/wasm/pkg (solver_wasm_bg.wasm etc.) is a build artifact of crates/solver that must be manually regenerated per README ("T0 WASM (after touching crates/solver)"). CI verifies the analogous generated artifact for tokens (`gen-tokens && git diff --exit-code renderer/src/tokens`) but has no check that the committed wasm matches the current solver source. The renderer uses this wasm for live T0 previews; the Rust core solves canonically — a stale wasm means the mid-drag projected numbers silently disagree with the committed result. (Currently in sync: both last touched at commit 61f4936.)

**Failure:** A PR fixes a rate bug in crates/solver/src/t0.rs but forgets the wasm-pack step; cargo tests pass, CI is green, and users see one set of numbers during the drag preview and different numbers after release — precisely the silent-math divergence the tokens check exists to prevent for colors.

**Suggested fix:** Add a CI step that rebuilds solver-wasm (wasm-pack or at minimum `cargo check -p solver-wasm --target wasm32-unknown-unknown`) and diffs the committed pkg, or hash-stamp the pkg with the solver source hash and compare.

**Verifier:** Finding is accurate as stated. Sharpening: divergence is transient (drag preview only — release commits go through plan.edit/T1 authoritatively per t0.ts header), which supports minor severity. Also, the fix is not a straight copy of the tokens pattern: wasm-pack output is not guaranteed byte-reproducible across toolchain versions, so a `wasm-pack build && git diff --exit-code` gate needs a pinned toolchain, or use a source-hash stamp committed alongside the pkg instead of a binary diff.

### M29. Committed WASM solver artifact (renderer/src/wasm/pkg) has no CI sync check, unlike the generated tokens which do — Rust T0 changes can silently desync the drag-projection math from the authoritative solver
`.github/workflows/ci.yml:31` · found by *cross-cutting*

CI has a 'tokens in sync' step (`cargo run ... gen-tokens && git diff --exit-code renderer/src/tokens`) but nothing rebuilds or verifies renderer/src/wasm/pkg/solver_wasm_bg.wasm against crates/solver + crates/solver-wasm. The .wasm/.js/.d.ts are checked-in build outputs consumed by renderer/src/solver/t0.ts; no package.json script or workflow step regenerates them. Today the pkg was last rebuilt in the same commit as the last solver change (61f4936), so it is currently in sync — but only by author discipline.

**Failure:** A future PR fixes a distribution-weight bug in crates/solver/src/t0.rs; cargo tests pass, CI is green, but the renderer keeps executing the old committed wasm — slider-drag projections (T0) disagree with the settled authoritative T1/T0 result, showing users transiently wrong rates with no test or CI signal.

**Suggested fix:** Add a CI step that runs wasm-pack build for solver-wasm and `git diff --exit-code renderer/src/wasm/pkg` (or at least hashes the wasm against a recorded solver-source hash), mirroring the gen-tokens gate.

**Verifier:** Finding is accurate as stated, including its concession that the artifact is currently in sync (latent process gap, minor). Sharpening: the suggested fix should probably not be a byte-diff check (wasm-pack/wasm-bindgen/rustc output is not byte-reproducible across toolchain versions, so `wasm-pack build && git diff --exit-code` would be flaky); a golden parity test — CI-built or committed wasm t0_solve vs the Rust solver crate on the Modular Frame golden case — is the robust guard. Note the blast radius is bounded: t0.ts header confirms wasm runs on drag frames only and release settles through Rust T1, so desync produces transiently wrong projections, not wrong committed plans.

### M30. Hand-mirrored game/domain constants exist in both Rust and TS with no generation or sync check: BELT_CAPACITY, JUNCTION_CAPS, transport spec defaults, wizard constraint defaults, the 800 m belt threshold, the '×1.12 TERRAIN' UI copy, the 50 ms solve budget, and '__PowerMW'
`renderer/src/state/types.ts:481` · found by *cross-cutting*

All values currently match, but each pair can drift independently with zero tooling signal (contrast: design tokens are generated and CI-gated). Pairs found: BELT_CAPACITY [60,120,270,480,780,1200] (types.ts:481 vs planner-core/entities.rs:113); JUNCTION_CAPS (types.ts:72 vs entities.rs port_caps); DEFAULT_RAIL_SPEC/DEFAULT_TRUCK_SPEC/DEFAULT_DRONE_SPEC (types.ts:102-113 vs entities.rs Default impls); wizard constraint defaults (WizardModal.tsx:16-22 vs app/wizard.rs:43-55); the 800 m belt/rail threshold hardcoded three times in RoutePopover.tsx:49,172,173 vs transport.rs BELT_MAX_M; the literal '×1.12 TERRAIN' string in RouteDrawer.tsx:328 vs transport.rs PARAMS.terrain_factor; the 50 ms T1 budget in store.ts solveChip (line 262) vs session.rs T1_BUDGET_MS; '__PowerMW' (types.ts:485 vs gamedata/docs.rs:182).

**Failure:** Someone tunes PARAMS.terrain_factor or a belt tier capacity on the Rust side (both are single-file edits that pass all Rust tests): the T0 snapshot builder feeds the wasm solver a stale capacity, RoutePopover keeps suggesting rail at the old 800 m cutoff, and the Route Inspector prints '×1.12 TERRAIN' while the math uses the new factor — UI numbers and copy silently disagree with the authoritative solver.

**Suggested fix:** Extend gen-tokens (or a sibling generator) to emit a constants.ts from the Rust definitions, or add a dev-bridge/hydrate payload field carrying these values so TS never hardcodes them; at minimum add a test that fetches hydrate gamedata/params and asserts equality with the TS constants.

**Verifier:** All details confirmed; BELT_CAPACITY is at types.ts:482 (not 481). One softening: the stale-capacity effect on T0 is confined to drag-frame previews — release commits re-solve through the authoritative Rust T1 (per t0.ts header), so drift produces transient preview/suggestion/copy mismatches, never corrupted persisted state. That bounds the blast radius and keeps severity minor. The repo's own tokens pipeline (task #2, ci.yml 'tokens in sync') is the ready-made pattern: extend gen-tokens-style codegen or add a single JSON constants file consumed by both sides, CI-gated the same way.


## Refuted findings (kept for the record)

These were reported by a reviewer but did not survive adversarial verification:

- **Rail headway penalty is computed on travel time only, but the binding A3.1 example applies it to travel + dwell** (`crates/planner-core/src/transport.rs:73`) — The finding's arithmetic is right (A3.1's mock is only self-consistent with headway = (travel+dwell)x0.15: 0.15x322=48.3s -> 0:48, RTT 370s -> 6:10, while the code yields 40.8s/362.8s), but its authority claim is wrong. The headway basis IS explicitly specified in the normative doc set: docs/04-sdd.md:120, SDD section 6 "Route Math (shared by inspector, recompute, and global solver)", states `rail: rtt = 2*len*terrain(1.12 planned)/avg_speed + SUM dwell + headway*travel` — headway applied to travel only. transport.rs:73-74 implements that formula verbatim, documents it (transport.rs:56 "applied to travel time"), and both the unit test (transport.rs:196) and the integration test (crates/app/tests/session.rs:1269) encode it. The finding's premise that "DECISIONS.md does not record a deviation, so A3.1 stands as authoritative" fails: DECISIONS.md records only judgment calls "beyond the docs" (DECISIONS.md:3), and following the SDD's explicit formula is not beyond the docs. A3.1 never states the basis in prose — it can only be inferred by reverse-engineering a UI mock that uses approximate values ("~90km/h", "about 4:32"); against that stands an exact formula in the SDD. The SDD precedence clause (docs/04-sdd.md:4: design docs win on *what*, SDD wins on *how*) puts the computation basis of the penalty — never stated as a requirement in the design doc — on the SDD's side. This is at most a doc-vs-doc inconsistency (A3.1's illustrative 0:48/6:10 vs SDD section 6), warranting a docs/DECISIONS cleanup, not a code defect.

- **eval_proposal preview semantics diverge from accept: eval skips failing items (leaving them half-applied in the scratch state) while accept aborts entirely** (`crates/app/src/session.rs:475`) — The failure scenario cannot occur: Command::ClaimNode (crates/planner-core/src/commands.rs:1051-1078) never fails on a double-claimed node — line 1064 comments "conflicting claims are representable, never prevented", per docs/04-sdd.md:73. So evaluating stale proposal #2 after accepting #1 produces no mid-item failure, no warning, and no half-applied item; accept of #2 also succeeds, with the conflict rendered as CRIT. The eval-skips vs accept-aborts asymmetry exists textually (session.rs:493-496 vs 426-433) but each side is a recorded decision (DECISIONS.md:41 "unresolved aliases abort before anything commits"; DECISIONS.md:43 eval = lenient scratch solve feeding the warning strip), and the stale-proposal premise is separately handled by the derived STALE badge + RESOLVE re-solve (DECISIONS.md:44), so the user is warned before trusting the preview.

- **T0 reports output-port 'realized' rate as the target even when the port is starved or disconnected, silently showing production that does not exist** (`crates/solver/src/t0.rs:372`) — t0.rs:372 does report the target for output ports, but the claimed failure doesn't materialize: (1) T0 is consumed only by the renderer's drag-frame preview (renderer/src/solver/t0.ts:1-3, Inspector.tsx:62) — "viewing" a factory renders backend T1 results, and for a broken/unwired snapshot T1 returns an error that session.rs:928-933 surfaces as error_factory, so nothing is silent; (2) the finding's session.rs claim is factually wrong — session.rs:926/1000 propagates ports from solver::t1::solve, where ports[out]=target is genuinely realized because the LP hard-constrains inflow == rate per output (t1.rs:144) and infeasible factories skip supply propagation entirely; (3) the sole real exposure — optimistic mid-drag projection diverging from T1 — is the explicitly documented design: SDD §4 "Optimistic drag ... T1 settles authoritatively ... the flash makes the correction visible — honesty by construction", with SDD §5.1 defining T0's output as ProjectedRates under a fixed-structure machines-scale-to-demand model, and t0.rs:118 deliberately routing starvation to group in_rates deficits. Golden tests (crates/solver/tests/golden.rs:202,295) name ports[out] "target"/"clamped target", confirming intended semantics.

- **No panic isolation on the solve thread: a panic strands the job (done never set) so the UI polls forever, and can poison the shared mutexes** (`crates/app/src/jobs.rs:60`) — The failure requires a panic on the spawned thread, and no panic path exists in the code it runs. crates/app/src/wizard.rs (global_solve, lines 96-806) contains zero unwrap/expect/panic/indexing — grep confirms; it uses .first()/.get()/.unwrap_or throughout, guards the one subtraction (budget check at wizard.rs:295 before line 308), and float casts/divisions saturate or yield inf/NaN rather than panic. The log closure (jobs.rs:69-74) can only fail on allocation, which aborts (no unwind), so the mutex-poisoning branch has no trigger. And serde_json::to_value(&outcome).unwrap() at jobs.rs:77 cannot fail: WizardOutcome/Proposal/Command are derive-serialized structs of strings/numbers/Vecs with no non-string-keyed maps, and non-finite f64s serialize to null under to_value rather than erroring — so the 'non-serializable outcome' claim is factually wrong for these types. The finding's own failure text ('any future panic path') concedes it is hypothetical hardening advice, not an occurring defect.

- **decode() does not strip a UTF-8 BOM (or handle UTF-16BE), so a BOM'd Docs.json fails to parse and the session refuses to open** (`crates/gamedata/src/docs.rs:108`) — The mechanics are correct (decode() at crates/gamedata/src/docs.rs:108-118 only strips FF FE; a UTF-8 BOM would reach serde_json::from_str at docs.rs:195 and fail), but this is the recorded accepted design, not a defect: DECISIONS.md:10 explicitly records "the parser detects UTF-16LE (real installs) vs UTF-8 (fixture) by BOM — SDD §7", and README.md:114 documents only "UTF-16LE handled". The supported inputs are the game-shipped UTF-16LE file and the BOM-less UTF-8 fixture; a BOM'd UTF-8 or UTF-16BE file only arises if the user hand-re-saves the file, outside the documented contract. The cited spec clause is also misattributed: the "on parse failure the import step degrades ... no dead ends" text is docs/04-sdd.md:141, which is SDD §8 Save Import (.sav files), not §7 Docs.json — SDD §7 (docs/04-sdd.md:128-133) specifies no fallback posture for Docs.json parse failure.

- **NaN clock/coordinates from a malformed .sav survive clamp() and are persisted into the plan, silently corrupting solver output** (`crates/app/src/import.rs:204`) — The failure scenario is blocked at the IPC boundary. Both transports JSON-encode the snapshot: renderer/src/state/backend.ts:158 (JSON.stringify to the dev bridge, parsed by serde_json::from_str::<ImportSnapshot> at crates/app/src/bin/dev_bridge.rs:157) and backend.ts:85 (Tauri invoke, whose IPC JSON-serializes args into the typed snapshot param at crates/app/src/main.rs:135). JSON.stringify converts NaN (and Infinity) to null, and serde rejects null for plain f64 fields (crates/app/src/import.rs:23-27 — #[serde(default)] only covers missing keys, not null). So a NaN clock/coordinate never reaches clamp (import.rs:221) or cluster(); the import request fails deserialization (dev_bridge.rs:162 returns 400; Tauri invoke rejects), and ImportModal.tsx:66-67 catches and displays the error. The finding's claims that 'import succeeds', 'no error shown', and 'Infinity is handled' are all factually wrong about this system.

- **Cross-spec state coupling makes one early failure cascade into misleading failures in every later spec file, and makes Playwright retries actively destructive** (`renderer/playwright.config.ts:18`) — The cross-spec coupling is real (phase3-proposals.spec.ts:66, phase4-import.spec.ts:80-86, phase5-advisor.spec.ts:84 all consume earlier specs' state) but it is an explicitly documented, accepted design: README ~lines 176-178 states "phase specs build on each other (the phase-2 empire feeds phase-3's deficits, phase-4's import feeds phase-5's advisor)", and DECISIONS.md:20 records the verification posture of driving the real core through one dev-bridge. The finding itself concedes acceptance. The alleged failure requires a hypothetical future misconfiguration — playwright.config.ts sets no retries (default 0), so the "retries double-apply state" path never executes as shipped. The cited flake trigger is already mitigated in-code: exit-criterion.spec.ts:12-21 wraps the dblclick race in a 4-attempt retry loop and connect() (exit-criterion.spec.ts:30+) retries the drag 3 times — in-test retries are the suite's chosen flake defense in lieu of --retries. Each file also sets mode:"serial" (so a Playwright retry would restart the whole group, contradicting the finding's per-test retry mechanics). What remains is a triage-ergonomics observation about failure-report readability in a deterministic suite, not a wrong outcome produced by the code.
