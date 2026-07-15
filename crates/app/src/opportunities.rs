//! Opportunity engine (PR 9, offline core) — "what should I work on next" as a
//! DERIVED projection, same species as buildqueue.rs: pure over
//! `(state, gamedata, derived, world, unlocked)`, no stored entities, no model
//! call. Eight candidate families each carry solver-derived numbers (evidence)
//! and an ACTION that lands on an EXISTING pipe — wizard prefill, map
//! selection, or an audit tab — so acting on a suggestion is always either
//! pure navigation or the already-undoable wizard/review flow.
//!
//! HONEST SILENCE is the contract: a family whose input data is absent emits
//! nothing — never a guessed number. A healthy finished base returns an empty
//! list, and that emptiness is the feature (the advisor's "silence is a
//! feature" doctrine, applied to ambition instead of alarm).
//!
//! Ranking is a documented class-order tuple (broken → milestone → savings →
//! growth), magnitude-descending within a class (distance ASCENDING for
//! untapped nodes), capped at 12. NO cross-unit arithmetic — MW overdraw and
//! machines saved are never summed into one score (house precedent: altopt's
//! lexicographic ordering).

use std::collections::{BTreeMap, BTreeSet};

use gamedata::docs::GameData;
use gamedata::worldnodes::WorldSnapshot;
use planner_core::entities::*;
use planner_core::state::PlanState;
use serde::Serialize;

use crate::session::{circuit_level, Derived};

/// "Running at capacity" within solver float noise — mirrors `FULL` in
/// advisor.rs and `routeBottleneck` in renderer/src/lib/format.ts (the same
/// efficiency-grammar rule, third consumer).
const FULL: f64 = 0.999;

/// How near an unclaimed pure node must sit to an existing factory to count
/// as a growth opportunity, in world meters (`MapPos` is the save coordinate
/// frame in meters; the bundled snapshot spans ~7.5 km × 7.5 km). 2 500 m is
/// "same neighborhood": ~a third of the map's radius, comfortably past the
/// ~800 m belt-vs-rail boundary in `transport::suggest_kind` but short of a
/// cross-map expedition. Distances use the same 2D `hypot` as node-drift
/// detection; cave nodes measure from their ENTRANCE (routes must go via it).
const UNTAPPED_RADIUS_M: f64 = 2500.0;

/// How many nearest untapped nodes to surface (growth ideas, not a catalog).
const UNTAPPED_LIMIT: usize = 3;

/// Ranked list cap — a shortlist, not a report.
const CAP: usize = 12;

/// Candidate family, in ranking-class order (the discriminant IS the class).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpportunityKind {
    /// Class 0 — a grid is overdrawn right now (broken).
    PowerDeficit,
    /// Class 1 — a target somewhere is starved (broken).
    DeficitRepair,
    /// Class 2 — a full route provably caps demand (broken, causal).
    RouteBottleneckFix,
    /// Class 3 — a grid is one spike from a brownout (trending broken).
    PowerMargin,
    /// Class 4 — the next milestone purchase needs an item you under-produce.
    /// HONEST-SILENT today: see [`milestone_gap`].
    MilestoneGap,
    /// Class 5 — an unlocked alternate saves machines empire-wide (savings).
    AltAdopt,
    /// Class 6 — a claimed node runs under 100% clock (untapped throughput).
    UnderExtracted,
    /// Class 7 — an unclaimed pure node near an existing factory (growth).
    UntappedNode,
}

/// A card's call-to-action. Every variant maps onto an EXISTING pipe: the
/// wizard prefill (already undoable end-to-end), a map selection (pure
/// navigation), or an audit-drawer tab. The engine never edits the plan.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum OpportunityAction {
    /// Open the wizard pre-filled (the FIX WITH SOLVER pattern).
    WizardGoal { item: String, rate: f64 },
    /// Select a route on the map (drawer carries the tier control).
    SelectRoute { id: Id },
    /// Select a resource node on the map.
    SelectNode { id: String },
    /// Select a factory on the map (claims live in its drawer).
    SelectFactory { id: Id },
    /// Open an audit-drawer tab (`"power" | "optimizer" | …`).
    OpenAudit { tab: String },
}

/// One ranked next move. `id` is DETERMINISTIC (kind + subject ids, never
/// random) so re-fetches keep stable React keys and tests can address rows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opportunity {
    pub id: String,
    pub kind: OpportunityKind,
    pub title: String,
    /// Provenance: exactly what the engine saw, numbers formatted Rust-side
    /// (advisor `saw` discipline — the renderer never re-derives them).
    pub evidence: String,
    /// Item class for the renderer's ItemIcon chip, when one is on stage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item: Option<String>,
    pub action: OpportunityAction,
}

/// Internal candidate: the ranking tuple stays out of the payload.
struct Candidate {
    /// Ranking class (== kind discriminant order, kept explicit for the sort).
    class: u8,
    /// Within-class urgency, LARGER = FIRST. Only ever compared against the
    /// same class's magnitudes, so units never mix (MW overdraw vs missing/min
    /// vs machines saved; untapped nodes store the NEGATED distance so nearer
    /// ranks first) — mirrors altopt's no-cross-unit-arithmetic ordering.
    magnitude: f64,
    opp: Opportunity,
}

/// Item display name, falling back to the trimmed class (buildqueue's rule).
fn item_name(gd: &GameData, item: &str) -> String {
    gd.items
        .get(item)
        .map(|i| i.display_name.clone())
        .unwrap_or_else(|| {
            item.trim_start_matches("Desc_")
                .trim_end_matches("_C")
                .to_string()
        })
}

/// `A → B` route label from its port (or factory) endpoints.
fn route_endpoints(state: &PlanState, r: &Route) -> String {
    let name = |pid: &Id| {
        state
            .ports
            .get(pid)
            .and_then(|p| state.factories.get(&p.factory))
            .or_else(|| state.factories.get(pid))
            .map(|f| f.name.clone())
    };
    match (name(&r.endpoints.0), name(&r.endpoints.1)) {
        (Some(a), Some(b)) => format!("{a} → {b}"),
        _ => "route".into(),
    }
}

/// Class 0 — `power_deficit`: any circuit with headroom < 0. Evidence is the
/// derived generation/demand MW pair; magnitude is the overdraw in MW.
fn power_deficit(derived: &Derived, out: &mut Vec<Candidate>) {
    for c in &derived.circuits {
        let (headroom, _) = circuit_level(c.generation_mw, c.demand_mw);
        if headroom >= 0.0 {
            continue;
        }
        let overdraw = c.demand_mw - c.generation_mw;
        out.push(Candidate {
            class: 0,
            magnitude: overdraw,
            opp: Opportunity {
                id: format!("power_deficit:{}", c.name),
                kind: OpportunityKind::PowerDeficit,
                title: format!("{} is overdrawn by {:.0} MW", c.name, overdraw),
                evidence: format!(
                    "{:.0} MW demand against {:.0} MW generated",
                    c.demand_mw, c.generation_mw
                ),
                item: None,
                action: OpportunityAction::OpenAudit {
                    tab: "power".into(),
                },
            },
        });
    }
}

/// Class 1 — `deficit_repair`: DeficitRows grouped by item (missing summed
/// across rows — one empire-wide card per item, not one per starved port).
/// Action pre-fills the wizard at the missing rate, ceiled (advisor's
/// `PlanProduction` arithmetic).
fn deficit_repair(gd: &GameData, derived: &Derived, out: &mut Vec<Candidate>) {
    // item → (Σ needed, Σ supplied, row count)
    let mut by_item: BTreeMap<String, (f64, f64, usize)> = BTreeMap::new();
    for d in &derived.deficits {
        let e = by_item.entry(d.item.clone()).or_insert((0.0, 0.0, 0));
        e.0 += d.needed;
        e.1 += d.supplied;
        e.2 += 1;
    }
    for (item, (needed, supplied, rows)) in by_item {
        let missing = needed - supplied;
        if missing <= 0.0 {
            continue;
        }
        out.push(Candidate {
            class: 1,
            magnitude: missing,
            opp: Opportunity {
                id: format!("deficit_repair:{item}"),
                kind: OpportunityKind::DeficitRepair,
                title: format!(
                    "{} is short {:.1}/min empire-wide",
                    item_name(gd, &item),
                    missing
                ),
                evidence: format!(
                    "need {needed:.1}/min, supplied {supplied:.1}/min across {rows} port(s)"
                ),
                item: Some(item.clone()),
                action: OpportunityAction::WizardGoal {
                    item,
                    rate: missing.ceil().max(1.0),
                },
            },
        });
    }
}

/// Class 2 — `route_bottleneck_fix`: a route at FULL capacity with a deficit
/// registered THROUGH it (the exact advisor/renderer bottleneck rule — a full
/// route whose consumers are satisfied is OPTIMAL and stays silent). The
/// title names the tier bump when one exists; magnitude is the missed rate.
fn route_bottleneck_fix(
    state: &PlanState,
    gd: &GameData,
    derived: &Derived,
    out: &mut Vec<Candidate>,
) {
    for (rid, dr) in &derived.routes {
        if dr.saturation < FULL {
            continue;
        }
        let missed: f64 = derived
            .deficits
            .iter()
            .filter(|d| d.route.as_ref() == Some(rid))
            .map(|d| d.needed - d.supplied)
            .sum();
        if missed <= 0.0 {
            continue;
        }
        let Some(route) = state.routes.get(rid) else {
            continue;
        };
        let endpoints = route_endpoints(state, route);
        let fix = match &route.kind {
            RouteKind::Belt { tier } if *tier < 6 => format!("bump it to Mk.{}", tier + 1),
            _ => "add a second route".into(),
        };
        out.push(Candidate {
            class: 2,
            magnitude: missed,
            opp: Opportunity {
                id: format!("route_bottleneck_fix:{rid}"),
                kind: OpportunityKind::RouteBottleneckFix,
                title: format!("{endpoints} caps demand — {fix}"),
                evidence: format!(
                    "{:.1}/{:.1} per min at {:.0}% with {:.1}/min missed through it",
                    dr.flow,
                    dr.capacity,
                    dr.saturation * 100.0,
                    missed
                ),
                item: dr.item.clone().filter(|i| gd.items.contains_key(i)),
                action: OpportunityAction::SelectRoute { id: rid.clone() },
            },
        });
    }
}

/// Class 3 — `power_margin`: 0 ≤ headroom < 0.20 (the `circuit_level` warn
/// band, reused so the threshold lives in ONE place). Magnitude is the
/// NEGATED headroom: thinner margin ranks first within the class.
fn power_margin(derived: &Derived, out: &mut Vec<Candidate>) {
    for c in &derived.circuits {
        let (headroom, level) = circuit_level(c.generation_mw, c.demand_mw);
        if headroom < 0.0 || level == "ok" {
            continue;
        }
        out.push(Candidate {
            class: 3,
            magnitude: -headroom,
            opp: Opportunity {
                id: format!("power_margin:{}", c.name),
                kind: OpportunityKind::PowerMargin,
                title: format!("{} has only {:.0}% headroom", c.name, headroom * 100.0),
                evidence: format!(
                    "{:.0}% headroom ({:.0} of {:.0} MW drawn)",
                    headroom * 100.0,
                    c.demand_mw,
                    c.generation_mw
                ),
                item: None,
                action: OpportunityAction::OpenAudit {
                    tab: "power".into(),
                },
            },
        });
    }
}

/// Class 4 — `milestone_gap`: HONEST-SILENT, deliberately. The family needs
/// two inputs that do not exist at runtime today, and inventing either would
/// violate the never-guess rule:
///
/// 1. gamedata carries NO schematic milestone costs — `GameData.schematics`
///    maps schematic class → unlocked RECIPE classes only (docs.rs parses
///    `mUnlocks`, not `mCost` quantities or tier structure);
/// 2. the session persists NO purchased-schematic set — import resolves
///    `unlocked_schematics × FGSchematic` straight into the unlocked RECIPE
///    set (`Session.unlocked`) and drops the schematic ids.
///
/// When both land (BACKLOG: parse `mCost`/tier, persist purchased ids), the
/// design is: lowest incomplete tier's next unpurchased milestone, diff its
/// item costs against current empire output rates, surface the largest-gap
/// item with a WizardGoal whose target rate clears the remaining quantity in
/// ~60 minutes, rounded UP to a clean number (`(gap / 60).ceil()`).
fn milestone_gap(_gd: &GameData, _unlocked: &BTreeSet<String>, _out: &mut [Candidate]) {
    // No schematic costs in gamedata + no purchased-schematic ids in state
    // ⇒ nothing honest to say. Emit NOTHING (never a guessed number).
}

/// Class 5 — `alt_adopt`: the TOP alternate-recipe opportunity by machines
/// saved. The computation is REUSED from altopt (`empire_optimize` already
/// ranks lexicographically and only surfaces net wins whose savings equal
/// adoptable savings by construction) — this family never re-derives it.
fn alt_adopt(
    state: &PlanState,
    gd: &GameData,
    unlocked: &BTreeSet<String>,
    out: &mut Vec<Candidate>,
) {
    let Some(top) = crate::altopt::empire_optimize(state, gd, unlocked)
        .into_iter()
        .next()
    else {
        return; // nothing unlocked / no net win — honest silence
    };
    let power = if top.power_saved_mw >= 0.0 {
        format!("−{:.0} MW", top.power_saved_mw)
    } else {
        // The alt costs power — an honest trade, surfaced, never hidden.
        format!("+{:.0} MW", -top.power_saved_mw)
    };
    out.push(Candidate {
        class: 5,
        magnitude: top.machines_saved as f64,
        opp: Opportunity {
            id: format!("alt_adopt:{}", top.recipe),
            kind: OpportunityKind::AltAdopt,
            title: format!(
                "Alt {} saves {} machines empire-wide",
                top.recipe_name, top.machines_saved
            ),
            evidence: format!(
                "−{} machines / {} on {}",
                top.machines_saved, power, top.product_name
            ),
            item: Some(top.product),
            action: OpportunityAction::OpenAudit {
                tab: "optimizer".into(),
            },
        },
    });
}

/// Class 6 — `under_extracted`: a claimed node whose claim runs under 100%
/// clock — standing extraction left on the table. Magnitude is the unused
/// clock fraction; the action selects the OWNING factory (the claim lives in
/// its drawer).
fn under_extracted(
    state: &PlanState,
    gd: &GameData,
    world: &WorldSnapshot,
    out: &mut Vec<Candidate>,
) {
    for c in state.node_claims.values() {
        if c.clock >= 1.0 - 1e-9 {
            continue;
        }
        let node_item = world
            .nodes
            .iter()
            .find(|n| n.id == c.node)
            .map(|n| n.item.clone());
        let label = node_item
            .as_ref()
            .map(|i| format!("{} node {}", item_name(gd, i), c.node))
            .unwrap_or_else(|| format!("Node {}", c.node));
        let fname = state
            .factories
            .get(&c.factory)
            .map(|f| f.name.clone())
            .unwrap_or_else(|| c.factory.clone());
        out.push(Candidate {
            class: 6,
            magnitude: 1.0 - c.clock,
            opp: Opportunity {
                id: format!("under_extracted:{}", c.id),
                kind: OpportunityKind::UnderExtracted,
                title: format!("{label} is extracting at {:.0}% clock", c.clock * 100.0),
                evidence: format!("{fname} claims it at {:.0}% clock", c.clock * 100.0),
                item: node_item,
                action: OpportunityAction::SelectFactory {
                    id: c.factory.clone(),
                },
            },
        });
    }
}

/// Class 7 — `untapped_node`: unclaimed PURE nodes within
/// [`UNTAPPED_RADIUS_M`] of any existing factory, nearest
/// [`UNTAPPED_LIMIT`]. Node geometry is `snapshot ⊕ override` (the W2b-C
/// resolution rule); cave nodes measure from their entrance. With no
/// factories there is no anchor — honest silence, never a map-wide dump.
fn untapped_node(
    state: &PlanState,
    gd: &GameData,
    world: &WorldSnapshot,
    out: &mut Vec<Candidate>,
) {
    if state.factories.is_empty() {
        return;
    }
    let claimed: BTreeSet<&str> = state
        .node_claims
        .values()
        .map(|c| c.node.as_str())
        .collect();
    // (distance m, node id, item, nearest factory name)
    let mut near: Vec<(f64, &str, &str, String)> = Vec::new();
    for n in &world.nodes {
        if n.purity != "pure" || claimed.contains(n.id.as_str()) {
            continue;
        }
        // Resolved position: plan-local override wins; cave nodes are reached
        // via their entrance, so that is the honest distance anchor.
        let (nx, ny) = match state.node_overrides.get(&n.id).and_then(|o| o.pos) {
            Some(p) => (p.x, p.y),
            None => match &n.entrance {
                Some(e) => (e.x, e.y),
                None => (n.x, n.y),
            },
        };
        let Some((dist, fname)) = state
            .factories
            .values()
            .map(|f| ((f.position.x - nx).hypot(f.position.y - ny), &f.name))
            .min_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
        else {
            continue;
        };
        if dist <= UNTAPPED_RADIUS_M {
            near.push((dist, &n.id, &n.item, fname.clone()));
        }
    }
    near.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.cmp(b.1))
    });
    for (dist, id, item, fname) in near.into_iter().take(UNTAPPED_LIMIT) {
        out.push(Candidate {
            class: 7,
            // Negated so the shared magnitude-DESC sort reads distance ASC.
            magnitude: -dist,
            opp: Opportunity {
                id: format!("untapped_node:{id}"),
                kind: OpportunityKind::UntappedNode,
                title: format!("Pure {} node near {fname}, unclaimed", item_name(gd, item)),
                evidence: format!("{id} · pure · ~{dist:.0} m from {fname}"),
                item: Some(item.to_string()),
                action: OpportunityAction::SelectNode { id: id.to_string() },
            },
        });
    }
}

/// Derive the ranked next-move list. Pure over its inputs; compute-on-demand
/// (the dev bridge / shell call it behind `solve_all_readonly`, exactly like
/// the advisor feed) — no persistence, nothing undoable.
///
/// Ranking: class ASC (the family order above: broken → milestone → savings
/// → growth), then magnitude DESC within the class (each class's magnitude is
/// a single unit — MW, items/min, machines, negated meters — never mixed),
/// then the deterministic id. Capped at [`CAP`].
pub fn derive_opportunities(
    state: &PlanState,
    gd: &GameData,
    derived: &Derived,
    world: &WorldSnapshot,
    unlocked: &BTreeSet<String>,
) -> Vec<Opportunity> {
    let mut cands: Vec<Candidate> = Vec::new();
    power_deficit(derived, &mut cands);
    deficit_repair(gd, derived, &mut cands);
    route_bottleneck_fix(state, gd, derived, &mut cands);
    power_margin(derived, &mut cands);
    milestone_gap(gd, unlocked, &mut cands);
    alt_adopt(state, gd, unlocked, &mut cands);
    under_extracted(state, gd, world, &mut cands);
    untapped_node(state, gd, world, &mut cands);

    cands.sort_by(|a, b| {
        a.class
            .cmp(&b.class)
            .then_with(|| {
                b.magnitude
                    .partial_cmp(&a.magnitude)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.opp.id.cmp(&b.opp.id))
    });
    cands.truncate(CAP);
    cands.into_iter().map(|c| c.opp).collect()
}
