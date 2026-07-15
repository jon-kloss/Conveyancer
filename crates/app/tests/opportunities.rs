//! PR 9 opportunity engine: every family fires ONLY on real derived evidence
//! and stays silent without it (honest silence — never a guessed number);
//! deficits are two-gap decomposed (production vs transport) so every card
//! names the TRUE cause; ranking is the documented class-order tuple, capped
//! at 12.

use app::opportunities::{derive_opportunities, Opportunity, OpportunityAction, OpportunityKind};
use app::Session;
use gamedata::docs::Recipe;
use gamedata::worldnodes::{Entrance, WorldNode};
use planner_core::commands::Command;
use planner_core::entities::*;

fn mk_factory(s: &mut Session, name: &str, x: f64, y: f64) -> Id {
    s.edit(vec![Command::CreateFactory {
        name: name.into(),
        position: MapPos { x, y, z: 0.0 },
        region: "GRASS FIELDS".into(),
    }])
    .unwrap()
    .created[0]
        .clone()
}

fn add_group(s: &mut Session, fid: &Id, machine: &str, recipe: &str, count: u32) -> Id {
    s.edit(vec![Command::AddGroup {
        factory: fid.clone(),
        machine: machine.into(),
        recipe: recipe.into(),
        count,
        clock: 1.0,
        graph_pos: GraphPos { x: 0.0, y: 0.0 },
        floor: 0,
    }])
    .unwrap()
    .created[0]
        .clone()
}

fn add_port(s: &mut Session, fid: &Id, dir: PortDirection, item: &str, ceiling: Option<f64>) -> Id {
    s.edit(vec![Command::AddPort {
        factory: fid.clone(),
        direction: dir,
        item: item.into(),
        rate: 0.0,
        rate_ceiling: ceiling,
        graph_pos: GraphPos { x: 0.0, y: 0.0 },
    }])
    .unwrap()
    .created[0]
        .clone()
}

fn belt(s: &mut Session, fid: &Id, from: EdgeEnd, to: EdgeEnd, item: &str) {
    s.edit(vec![Command::AddEdge {
        factory: fid.clone(),
        from,
        to,
        item: item.into(),
        tier: 6,
    }])
    .unwrap();
}

fn set_rate(s: &mut Session, port: &Id, rate: f64) {
    s.edit(vec![Command::SetPortRate {
        id: port.clone(),
        rate,
    }])
    .unwrap();
}

fn next(s: &mut Session) -> Vec<Opportunity> {
    let derived = s.solve_all_readonly();
    derive_opportunities(&s.state, &s.gamedata, &derived, &s.world, &s.unlocked)
}

/// ore in → smelter bank → ingot out at `rate` (a cleanly-solving producer).
fn ingot_factory(
    s: &mut Session,
    name: &str,
    x: f64,
    y: f64,
    smelters: u32,
    rate: f64,
) -> (Id, Id) {
    let fid = mk_factory(s, name, x, y);
    let ore_in = add_port(s, &fid, PortDirection::In, "Desc_OreIron_C", Some(1200.0));
    let out = add_port(s, &fid, PortDirection::Out, "Desc_IronIngot_C", None);
    let bank = add_group(
        s,
        &fid,
        "Build_SmelterMk1_C",
        "Recipe_IngotIron_C",
        smelters,
    );
    belt(
        s,
        &fid,
        EdgeEnd::Port(ore_in),
        EdgeEnd::Group(bank.clone()),
        "Desc_OreIron_C",
    );
    belt(
        s,
        &fid,
        EdgeEnd::Group(bank),
        EdgeEnd::Port(out.clone()),
        "Desc_IronIngot_C",
    );
    set_rate(s, &out, rate);
    (fid, out)
}

/// ingot in → constructor bank → rod out (targets set by the caller).
fn rod_sink(s: &mut Session, name: &str, x: f64, y: f64, ctors: u32) -> (Id, Id, Id) {
    let fid = mk_factory(s, name, x, y);
    let ingot_in = add_port(s, &fid, PortDirection::In, "Desc_IronIngot_C", None);
    let rod_out = add_port(s, &fid, PortDirection::Out, "Desc_IronRod_C", None);
    let bank = add_group(s, &fid, "Build_ConstructorMk1_C", "Recipe_IronRod_C", ctors);
    belt(
        s,
        &fid,
        EdgeEnd::Port(ingot_in.clone()),
        EdgeEnd::Group(bank.clone()),
        "Desc_IronIngot_C",
    );
    belt(
        s,
        &fid,
        EdgeEnd::Group(bank),
        EdgeEnd::Port(rod_out.clone()),
        "Desc_IronRod_C",
    );
    (fid, ingot_in, rod_out)
}

/// ore in (ceiling) straight to an ore out port — the wizard's extraction-
/// and-ship pass-through shape (group-less, edge-wired; a valid T1 solve).
fn ore_mine(s: &mut Session, name: &str, x: f64, y: f64, rate: f64) -> (Id, Id) {
    let fid = mk_factory(s, name, x, y);
    let ore_in = add_port(s, &fid, PortDirection::In, "Desc_OreIron_C", Some(1200.0));
    let ore_out = add_port(s, &fid, PortDirection::Out, "Desc_OreIron_C", None);
    belt(
        s,
        &fid,
        EdgeEnd::Port(ore_in),
        EdgeEnd::Port(ore_out.clone()),
        "Desc_OreIron_C",
    );
    set_rate(s, &ore_out, rate);
    (fid, ore_out)
}

/// ore in → smelter bank → ingot out, the ore In port UNCEILINGED (a bound
/// route injects its supply as the effective ceiling — the route-binds case).
fn ore_smelter(s: &mut Session, name: &str, x: f64, y: f64, smelters: u32) -> (Id, Id, Id) {
    let fid = mk_factory(s, name, x, y);
    let ore_in = add_port(s, &fid, PortDirection::In, "Desc_OreIron_C", None);
    let out = add_port(s, &fid, PortDirection::Out, "Desc_IronIngot_C", None);
    let bank = add_group(
        s,
        &fid,
        "Build_SmelterMk1_C",
        "Recipe_IngotIron_C",
        smelters,
    );
    belt(
        s,
        &fid,
        EdgeEnd::Port(ore_in.clone()),
        EdgeEnd::Group(bank.clone()),
        "Desc_OreIron_C",
    );
    belt(
        s,
        &fid,
        EdgeEnd::Group(bank),
        EdgeEnd::Port(out.clone()),
        "Desc_IronIngot_C",
    );
    (fid, ore_in, out)
}

fn belt_route(s: &mut Session, from: &Id, to: &Id, tier: u8) -> Id {
    s.edit(vec![Command::AddRoute {
        kind: RouteKind::Belt { tier },
        from: from.clone(),
        to: to.clone(),
        path: vec![
            MapPos {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
            MapPos {
                x: 500.0,
                y: 0.0,
                z: 0.0,
            },
        ],
    }])
    .unwrap()
    .created[0]
        .clone()
}

/// coal in → coal generator → `rate` MW out (grid generation).
fn coal_plant(s: &mut Session, name: &str, x: f64, y: f64, rate: f64) -> Id {
    let fid = mk_factory(s, name, x, y);
    let coal_in = add_port(s, &fid, PortDirection::In, "Desc_Coal_C", Some(480.0));
    let mw_out = add_port(s, &fid, PortDirection::Out, "__PowerMW", None);
    let gens = add_group(
        s,
        &fid,
        "Build_GeneratorCoal_C",
        "Recipe_Power_Build_GeneratorCoal_Desc_Coal_C",
        4,
    );
    belt(
        s,
        &fid,
        EdgeEnd::Port(coal_in),
        EdgeEnd::Group(gens.clone()),
        "Desc_Coal_C",
    );
    belt(
        s,
        &fid,
        EdgeEnd::Group(gens),
        EdgeEnd::Port(mw_out.clone()),
        "__PowerMW",
    );
    set_rate(s, &mw_out, rate);
    fid
}

fn power_route(s: &mut Session, a: &Id, b: &Id) {
    s.edit(vec![Command::AddRoute {
        kind: RouteKind::Power,
        from: a.clone(),
        to: b.clone(),
        path: vec![
            MapPos {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
            MapPos {
                x: 100.0,
                y: 0.0,
                z: 0.0,
            },
        ],
    }])
    .unwrap();
}

/// The H1 test chassis: `smelters` at `up_rate` ingots/min feed `ctors`
/// constructors through a route that starts Mk.4 (so the `rod_rate` target is
/// set while achievable — targets are never rewritten by a tier change), then
/// drops to Mk.1 (60 cap). `dip_to` optionally lowers the upstream target
/// AFTER the drop, steering how the miss decomposes.
fn capped_chain(
    s: &mut Session,
    smelters: u32,
    up_rate: f64,
    ctors: u32,
    rod_rate: f64,
    dip_to: Option<f64>,
) -> Id {
    let (_, ingot_out) = ingot_factory(s, "BIG SMELT", 0.0, 0.0, smelters, up_rate);
    let (_, ingot_in, rod_out) = rod_sink(s, "ROD SINK", 500.0, 0.0, ctors);
    let route = belt_route(s, &ingot_out, &ingot_in, 4);
    set_rate(s, &rod_out, rod_rate);
    s.edit(vec![Command::SetRouteTier {
        id: route.clone(),
        tier: 1,
    }])
    .unwrap();
    if let Some(rate) = dip_to {
        set_rate(s, &ingot_out, rate);
    }
    route
}

fn find_kind(opps: &[Opportunity], kind: OpportunityKind) -> Option<&Opportunity> {
    opps.iter().find(|o| o.kind == kind)
}

fn count_kind(opps: &[Opportunity], kind: OpportunityKind) -> usize {
    opps.iter().filter(|o| o.kind == kind).count()
}

/// An empty plan yields NOTHING — silence, not filler ideas.
#[test]
fn empty_plan_is_silent() {
    let mut s = Session::in_memory(None).unwrap();
    assert!(next(&mut s).is_empty(), "no evidence → no opportunities");
}

/// power_deficit: a grid drawing more than it generates fires class 0 with
/// the derived MW pair as evidence; a healthy grid stays silent. An overdrawn
/// grid is NEVER also a margin warning (S4 — the two bands are exclusive).
#[test]
fn power_deficit_fires_on_overdraw_only() {
    let mut s = Session::in_memory(None).unwrap();
    // 75 MW plant powering a 128 MW load (32 smelters @ 4 MW) → overdrawn.
    let plant = coal_plant(&mut s, "POWER RIDGE", 0.0, 0.0, 75.0);
    let (load, _) = ingot_factory(&mut s, "LOAD BLOCK", 100.0, 0.0, 32, 960.0);
    power_route(&mut s, &plant, &load);

    let opps = next(&mut s);
    let o = find_kind(&opps, OpportunityKind::PowerDeficit).expect("overdrawn grid fires");
    assert!(o.title.contains("overdrawn by"), "{}", o.title);
    assert!(o.evidence.contains("MW"), "{}", o.evidence);
    assert_eq!(
        o.action,
        OpportunityAction::OpenAudit {
            tab: "power".into()
        }
    );
    // and it ranks first — class 0 leads everything else present
    assert_eq!(opps[0].kind, OpportunityKind::PowerDeficit);
    // S4: the overdraw never doubles as a thin-margin warning
    assert!(
        !opps.iter().any(|o| o.kind == OpportunityKind::PowerMargin),
        "an overdrawn grid is a deficit, not a margin"
    );

    // shrink the load to 8 smelters at a matching 240/min target (32 MW of
    // 75 — the rate must drop too, or the solver overclocks the smaller bank
    // and its clock-scaled draw keeps the grid overdrawn) → healthy, silent
    let bank = s
        .state
        .groups
        .values()
        .find(|g| g.factory == load && g.machine == "Build_SmelterMk1_C")
        .unwrap()
        .id
        .clone();
    let out = s
        .state
        .ports
        .values()
        .find(|p| p.factory == load && p.direction == PortDirection::Out)
        .unwrap()
        .id
        .clone();
    s.edit(vec![Command::SetGroupCount { id: bank, count: 8 }])
        .unwrap();
    set_rate(&mut s, &out, 240.0);
    assert!(
        !next(&mut s)
            .iter()
            .any(|o| o.kind == OpportunityKind::PowerDeficit),
        "healthy grid must not fire power_deficit"
    );
}

/// L5: a sub-half-MW overdraw renders with one decimal — an overdrawn grid
/// must never read "overdrawn by 0 MW".
#[test]
fn power_deficit_small_overdraw_keeps_a_decimal() {
    let mut s = Session::in_memory(None).unwrap();
    // 63.6 MW plant vs a 64 MW load (16 smelters @ 4 MW) → 0.4 MW overdraw.
    let plant = coal_plant(&mut s, "POWER RIDGE", 0.0, 0.0, 63.6);
    let (load, _) = ingot_factory(&mut s, "LOAD BLOCK", 100.0, 0.0, 16, 480.0);
    power_route(&mut s, &plant, &load);

    let opps = next(&mut s);
    let o = find_kind(&opps, OpportunityKind::PowerDeficit).expect("0.4 MW overdraw still fires");
    assert!(
        o.title.contains("overdrawn by 0.4 MW"),
        "sub-half-MW overdraw keeps a decimal: {}",
        o.title
    );
}

/// deficit_repair: starved targets group by item empire-wide; the action is a
/// wizard prefill at the ceiled PRODUCTION-gap rate. The tier-4 route here has
/// slack (the upstream dip is a pure production gap), so route_bottleneck_fix
/// must stay silent (S1 — no false transport attribution).
#[test]
fn deficit_repair_groups_by_item_and_prefills_wizard() {
    let mut s = Session::in_memory(None).unwrap();
    // Build the chain SATISFIED first (the downstream target must be set while
    // achievable — an unachievable SetPortRate is clamp-written-back), then
    // dip the upstream to 10/min so the 60-rod target honestly starves.
    let (_, ingot_out) = ingot_factory(&mut s, "OPPORTUNITY BAY", 0.0, 0.0, 4, 60.0);
    let (_, ingot_in, rod_out) = rod_sink(&mut s, "FOUNDRY GAP", 500.0, 0.0, 4);
    belt_route(&mut s, &ingot_out, &ingot_in, 4);
    set_rate(&mut s, &rod_out, 60.0); // satisfiable now
    set_rate(&mut s, &ingot_out, 10.0); // upstream dips → downstream starves

    let opps = next(&mut s);
    let o = find_kind(&opps, OpportunityKind::DeficitRepair).expect("starved chain fires");
    assert!(o.title.contains("Iron Ingot"), "{}", o.title);
    assert!(
        o.title.contains("short 50.0/min empire-wide"),
        "{}",
        o.title
    );
    assert_eq!(o.item.as_deref(), Some("Desc_IronIngot_C"));
    assert_eq!(
        o.evidence, "need 60.0/min, supplied 10.0/min across 1 port(s)",
        "a slack route earns no transport suffix"
    );
    match &o.action {
        OpportunityAction::WizardGoal { item, rate } => {
            assert_eq!(item, "Desc_IronIngot_C");
            assert_eq!(*rate, 50.0, "ceil(60 needed − 10 produced)");
        }
        other => panic!("expected WizardGoal, got {other:?}"),
    }
    // deterministic id — stable across recomputes
    assert_eq!(o.id, "deficit_repair:Desc_IronIngot_C");
    // S1: the route has slack — the starve is production-caused, and no
    // route_bottleneck_fix card may claim otherwise.
    assert!(
        !opps
            .iter()
            .any(|o| o.kind == OpportunityKind::RouteBottleneckFix),
        "slack route must not fire route_bottleneck_fix"
    );
}

/// H1 case A (route-capped only): upstream already produces the full need —
/// the deficit card would plan REDUNDANT machines, so it stays silent and the
/// route card leads with the recoverable rate and the SMALLEST sufficient
/// tier (Mk.1 + 180 recoverable needs 240 → Mk.3, never a blind +1).
#[test]
fn route_capped_deficit_yields_route_card_only() {
    let mut s = Session::in_memory(None).unwrap();
    let route = capped_chain(&mut s, 8, 240.0, 16, 240.0, None);

    let opps = next(&mut s);
    assert!(
        !opps
            .iter()
            .any(|o| o.kind == OpportunityKind::DeficitRepair),
        "production covers the need — no deficit card"
    );
    let o = find_kind(&opps, OpportunityKind::RouteBottleneckFix).expect("route card fires");
    assert!(
        o.title.contains("caps demand — bump it to Mk.3"),
        "60 flow + 180 recoverable needs 240 → Mk.3 (skip Mk.2): {}",
        o.title
    );
    assert!(
        o.evidence.contains("180.0/min recoverable through it"),
        "{}",
        o.evidence
    );
    assert_eq!(o.action, OpportunityAction::SelectRoute { id: route });
    // No class 0/1 present → the route card leads the list.
    assert_eq!(opps[0].kind, OpportunityKind::RouteBottleneckFix);
}

/// H1 case B (mixed): upstream makes 120 of a 240 need over a 60-cap belt —
/// BOTH cards fire, each sized by its OWN gap (deficit 120 production,
/// route 60 recoverable), with the deficit evidence naming the capped share.
#[test]
fn mixed_gap_fires_both_cards_with_own_numbers() {
    let mut s = Session::in_memory(None).unwrap();
    capped_chain(&mut s, 8, 240.0, 16, 240.0, Some(120.0));

    let opps = next(&mut s);
    let d = find_kind(&opps, OpportunityKind::DeficitRepair).expect("production gap fires");
    assert!(
        d.title.contains("short 120.0/min empire-wide"),
        "production gap only (240 needed − 120 produced): {}",
        d.title
    );
    assert!(
        d.evidence
            .contains("; 60.0/min more capped by full route(s)"),
        "the transport share is named, not summed in: {}",
        d.evidence
    );
    match &d.action {
        OpportunityAction::WizardGoal { rate, .. } => assert_eq!(*rate, 120.0),
        other => panic!("expected WizardGoal, got {other:?}"),
    }
    let r = find_kind(&opps, OpportunityKind::RouteBottleneckFix).expect("transport gap fires");
    assert!(
        r.evidence.contains("60.0/min recoverable through it"),
        "{}",
        r.evidence
    );
    assert!(
        r.title.contains("bump it to Mk.2"),
        "60 flow + 60 recoverable = 120 → Mk.2 suffices: {}",
        r.title
    );
    // class 1 before class 2
    let di = opps.iter().position(|o| o.id == d.id).unwrap();
    let ri = opps.iter().position(|o| o.id == r.id).unwrap();
    assert!(
        di < ri,
        "deficit_repair (class 1) before route fix (class 2)"
    );
}

/// H1 case C (starved at the cap): upstream makes EXACTLY the belt cap — the
/// route recovers nothing by itself (upgrading it moves zero extra items), so
/// the route card is silent and the deficit card carries the whole gap, with
/// the full route named as the next wall.
#[test]
fn starved_at_cap_is_deficit_with_route_mention() {
    let mut s = Session::in_memory(None).unwrap();
    capped_chain(&mut s, 8, 240.0, 16, 240.0, Some(60.0));

    let opps = next(&mut s);
    let d = find_kind(&opps, OpportunityKind::DeficitRepair).expect("real production gap fires");
    assert!(
        d.title.contains("short 180.0/min empire-wide"),
        "{}",
        d.title
    );
    assert!(
        d.evidence.contains(
            "; the Mk.1 route is already full — upgrading it is also required once production rises"
        ),
        "the full route is mentioned, not carded: {}",
        d.evidence
    );
    assert!(
        !opps
            .iter()
            .any(|o| o.kind == OpportunityKind::RouteBottleneckFix),
        "zero recoverable → no route card"
    );
}

/// route_bottleneck_fix fires ONLY on a recoverable transport gap; a
/// full-but-satisfied route stays silent (the efficiency grammar — 100%
/// meeting demand is optimal). The exact-fit boundary is kept deliberately:
/// 60 flow + 60 recoverable = 120 lands exactly ON Mk.2's capacity.
#[test]
fn route_bottleneck_fires_only_with_recoverable_gap() {
    let mut s = Session::in_memory(None).unwrap();
    // upstream can push 120/min; the Mk.1 route caps at 60; downstream wants 120.
    let route = capped_chain(&mut s, 4, 120.0, 8, 120.0, None);

    let opps = next(&mut s);
    let o = find_kind(&opps, OpportunityKind::RouteBottleneckFix)
        .expect("full route with recoverable gap fires");
    assert!(o.title.contains("caps demand"), "{}", o.title);
    assert!(
        o.title.contains("Mk.2"),
        "exact fit: 60 + 60 = 120 = Mk.2 capacity: {}",
        o.title
    );
    assert!(
        o.evidence.contains("60.0/min recoverable through it"),
        "{}",
        o.evidence
    );
    assert_eq!(
        o.action,
        OpportunityAction::SelectRoute { id: route.clone() }
    );
    // Pure transport gap: upstream covers the need → deficit ABSENT, and the
    // route card leads the list (nothing outranks class 2 here).
    assert!(
        !opps
            .iter()
            .any(|o| o.kind == OpportunityKind::DeficitRepair),
        "route-capped miss must not fire deficit_repair"
    );
    assert_eq!(opps[0].kind, OpportunityKind::RouteBottleneckFix);

    // downstream relaxes to 60/min: the route is FULL but satisfied → silent
    let rod_out = s
        .state
        .ports
        .values()
        .find(|p| p.item == "Desc_IronRod_C" && p.direction == PortDirection::Out)
        .unwrap()
        .id
        .clone();
    set_rate(&mut s, &rod_out, 60.0);
    assert!(
        !next(&mut s)
            .iter()
            .any(|o| o.kind == OpportunityKind::RouteBottleneckFix),
        "a full route that meets demand is optimal — no candidate"
    );
    let _ = route;
}

/// M2: when even Mk.6 can't carry flow + recoverable, the fix is a parallel
/// belt, not a tier bump into a wall. A full Mk.5 (780) under a 1 360 need:
/// 780 + 580 recoverable = 1 360 > 1 200.
#[test]
fn route_fix_beyond_mk6_names_parallel_belt() {
    let mut s = Session::in_memory(None).unwrap();
    // Upstream: 46 smelters in two banks (one Mk.6 internal edge can't carry
    // 1 360) shipping 1 360 ingots/min — the upstream WITNESS for the need.
    let up = mk_factory(&mut s, "MEGA SMELT", 0.0, 0.0);
    let ore_in = add_port(
        &mut s,
        &up,
        PortDirection::In,
        "Desc_OreIron_C",
        Some(2000.0),
    );
    let ingot_out = add_port(&mut s, &up, PortDirection::Out, "Desc_IronIngot_C", None);
    for _ in 0..2 {
        let bank = add_group(&mut s, &up, "Build_SmelterMk1_C", "Recipe_IngotIron_C", 23);
        belt(
            &mut s,
            &up,
            EdgeEnd::Port(ore_in.clone()),
            EdgeEnd::Group(bank.clone()),
            "Desc_OreIron_C",
        );
        belt(
            &mut s,
            &up,
            EdgeEnd::Group(bank),
            EdgeEnd::Port(ingot_out.clone()),
            "Desc_IronIngot_C",
        );
    }
    set_rate(&mut s, &ingot_out, 1360.0);
    // Downstream: 92 constructors in two banks wanting 1360 rods/min. The
    // target is set BEFORE the route exists (unbound In ports are
    // unconstrained), so it survives the route's cap. The route lands at
    // Mk.5: its 780 intake stays under every internal Mk.6 edge, so the
    // solver's ceiling binding names the route-injected InputCeiling — the
    // signal the deficit row needs — not an internal belt.
    let down = mk_factory(&mut s, "MEGA RODS", 500.0, 0.0);
    let ingot_in = add_port(&mut s, &down, PortDirection::In, "Desc_IronIngot_C", None);
    let rod_out = add_port(&mut s, &down, PortDirection::Out, "Desc_IronRod_C", None);
    for _ in 0..2 {
        let bank = add_group(
            &mut s,
            &down,
            "Build_ConstructorMk1_C",
            "Recipe_IronRod_C",
            46,
        );
        belt(
            &mut s,
            &down,
            EdgeEnd::Port(ingot_in.clone()),
            EdgeEnd::Group(bank.clone()),
            "Desc_IronIngot_C",
        );
        belt(
            &mut s,
            &down,
            EdgeEnd::Group(bank),
            EdgeEnd::Port(rod_out.clone()),
            "Desc_IronRod_C",
        );
    }
    set_rate(&mut s, &rod_out, 1360.0);
    belt_route(&mut s, &ingot_out, &ingot_in, 5);

    let opps = next(&mut s);
    let o = find_kind(&opps, OpportunityKind::RouteBottleneckFix).expect("Mk.5 route caps 580");
    assert!(
        o.title
            .contains("caps demand — beyond Mk.6 — add a parallel belt"),
        "780 flow + 580 recoverable exceeds every tier: {}",
        o.title
    );
    assert!(
        o.evidence.contains("580.0/min recoverable through it"),
        "{}",
        o.evidence
    );
    assert!(
        !opps
            .iter()
            .any(|o| o.kind == OpportunityKind::DeficitRepair),
        "upstream produces the full 1360 — transport-only miss"
    );
}

/// M2: a rail bottleneck's fix is the drawer's own stepper ("+1 consist"),
/// never "a second route".
#[test]
fn route_fix_rail_names_consist() {
    let mut s = Session::in_memory(None).unwrap();
    let (_, ingot_out) = ingot_factory(&mut s, "BIG SMELT", 0.0, 0.0, 8, 240.0);
    let (_, ingot_in, rod_out) = rod_sink(&mut s, "ROD SINK", 80000.0, 0.0, 16);
    // Create as a Mk.4 belt over an 80 km path (the 240-rod target must be
    // set while achievable), then swap the kind to a default 1-consist rail:
    // at this length its throughput lands well under 240/min → FULL.
    let route = s
        .edit(vec![Command::AddRoute {
            kind: RouteKind::Belt { tier: 4 },
            from: ingot_out.clone(),
            to: ingot_in.clone(),
            path: vec![
                MapPos {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
                MapPos {
                    x: 80000.0,
                    y: 0.0,
                    z: 0.0,
                },
            ],
        }])
        .unwrap()
        .created[0]
        .clone();
    set_rate(&mut s, &rod_out, 240.0);
    s.edit(vec![Command::SetRouteSpec {
        id: route.clone(),
        kind: RouteKind::Rail {
            spec: RailSpec::default(),
        },
    }])
    .unwrap();

    let opps = next(&mut s);
    let o = find_kind(&opps, OpportunityKind::RouteBottleneckFix).expect("full rail route fires");
    assert!(
        o.title.contains("caps demand — +1 consist"),
        "rail fix names the consist stepper: {}",
        o.title
    );
}

/// power_margin: 0 ≤ headroom < 20% fires class 3; comfortable headroom is
/// silent. (An overdrawn grid is power_deficit, never both.)
#[test]
fn power_margin_fires_in_warn_band_only() {
    let mut s = Session::in_memory(None).unwrap();
    // 75 MW plant, 64 MW load (16 smelters) → 14.7% headroom: warn band.
    let plant = coal_plant(&mut s, "POWER RIDGE", 0.0, 0.0, 75.0);
    let (load, _) = ingot_factory(&mut s, "LOAD BLOCK", 100.0, 0.0, 16, 480.0);
    power_route(&mut s, &plant, &load);

    let opps = next(&mut s);
    let o = find_kind(&opps, OpportunityKind::PowerMargin).expect("thin-headroom grid fires");
    assert!(o.title.contains("headroom"), "{}", o.title);
    assert!(o.evidence.contains("MW"), "{}", o.evidence);
    assert!(
        !opps.iter().any(|o| o.kind == OpportunityKind::PowerDeficit),
        "warn band is not an overdraw"
    );

    // 32 MW load (8 smelters at a matching 240/min target) → 57% headroom
    let bank = s
        .state
        .groups
        .values()
        .find(|g| g.factory == load && g.machine == "Build_SmelterMk1_C")
        .unwrap()
        .id
        .clone();
    let out = s
        .state
        .ports
        .values()
        .find(|p| p.factory == load && p.direction == PortDirection::Out)
        .unwrap()
        .id
        .clone();
    s.edit(vec![Command::SetGroupCount { id: bank, count: 8 }])
        .unwrap();
    set_rate(&mut s, &out, 240.0);
    assert!(
        !next(&mut s)
            .iter()
            .any(|o| o.kind == OpportunityKind::PowerMargin),
        "comfortable headroom must not nag"
    );
}

/// L5: the headroom percentage FLOORS in title and evidence — 19.5% must
/// read "19%", never round up toward comfort.
#[test]
fn power_margin_floors_the_percentage() {
    let mut s = Session::in_memory(None).unwrap();
    // generation 64/0.805 ≈ 79.5 MW over a 64 MW load → headroom exactly 19.5%.
    let plant = coal_plant(&mut s, "POWER RIDGE", 0.0, 0.0, 64.0 / 0.805);
    let (load, _) = ingot_factory(&mut s, "LOAD BLOCK", 100.0, 0.0, 16, 480.0);
    power_route(&mut s, &plant, &load);
    let _ = load;

    let opps = next(&mut s);
    let o = find_kind(&opps, OpportunityKind::PowerMargin).expect("19.5% is warn band");
    assert!(
        o.title.contains("only 19% headroom"),
        "19.5% floors to 19: {}",
        o.title
    );
    assert!(o.evidence.starts_with("19% headroom ("), "{}", o.evidence);
    let _ = plant;
}

/// M3: with NO power routes drawn (zero circuits) but empire totals proving
/// an overdraw, the class-0 empire fallback fires — pigeonhole-honest: at
/// least one physical grid must be overdrawn.
#[test]
fn empire_power_fallback_fires_on_overdraw_without_routes() {
    let mut s = Session::in_memory(None).unwrap();
    coal_plant(&mut s, "LONE PLANT", 0.0, 0.0, 10.0);
    ingot_factory(&mut s, "BIG LOAD", 2000.0, 2000.0, 32, 960.0);
    // no power_route — a save-imported base draws none

    let opps = next(&mut s);
    let o = find_kind(&opps, OpportunityKind::PowerDeficit).expect("empire overdraw fires");
    assert_eq!(o.id, "power_deficit:empire");
    assert_eq!(
        o.title,
        "Plan-wide power demand exceeds generation by 118 MW"
    );
    assert_eq!(
        o.evidence,
        "128 MW demand vs 10 MW generated — no power routes drawn, per-grid balance unknown"
    );
    assert_eq!(
        o.action,
        OpportunityAction::OpenAudit {
            tab: "power".into()
        }
    );
}

/// M3 asymmetry pin: a thin-but-positive EMPIRE margin proves nothing about
/// any physical grid (one grid can be overdrawn while another idles), so
/// without routes the margin family stays SILENT — deliberately.
#[test]
fn empire_power_fallback_silent_on_thin_margin() {
    let mut s = Session::in_memory(None).unwrap();
    coal_plant(&mut s, "LONE PLANT", 0.0, 0.0, 75.0);
    ingot_factory(&mut s, "LOAD BLOCK", 2000.0, 2000.0, 16, 480.0);
    // 64 of 75 MW → 14.7% empire margin, but no routes → no per-grid facts

    let opps = next(&mut s);
    assert!(
        !opps.iter().any(|o| o.kind == OpportunityKind::PowerDeficit),
        "positive margin is not an overdraw"
    );
    assert!(
        !opps.iter().any(|o| o.kind == OpportunityKind::PowerMargin),
        "empire margin proves nothing per-grid — honest silence"
    );
}

/// M3: any drawn circuit disables the empire fallback — per-grid truth wins.
#[test]
fn empire_power_fallback_silent_when_a_circuit_exists() {
    let mut s = Session::in_memory(None).unwrap();
    let plant = coal_plant(&mut s, "SMALL PLANT", 0.0, 0.0, 10.0);
    let (load, _) = ingot_factory(&mut s, "GRID LOAD", 100.0, 0.0, 4, 120.0);
    power_route(&mut s, &plant, &load);
    // a second, UNROUTED load keeps the empire totals overdrawn
    ingot_factory(&mut s, "DARK LOAD", 3000.0, 3000.0, 32, 960.0);

    let opps = next(&mut s);
    assert!(
        opps.iter().any(|o| o.id.starts_with("power_deficit:GRID")),
        "the drawn grid reports itself"
    );
    assert!(
        !opps.iter().any(|o| o.id == "power_deficit:empire"),
        "circuits exist → the empire fallback stands down"
    );
}

/// M3: zero generation is a mid-planning base (machines drawn, no generators
/// yet), not a power emergency — the fallback carves it out.
#[test]
fn empire_power_fallback_silent_at_zero_generation() {
    let mut s = Session::in_memory(None).unwrap();
    ingot_factory(&mut s, "EARLY DRAFT", 0.0, 0.0, 32, 960.0);

    assert!(
        !next(&mut s)
            .iter()
            .any(|o| o.kind == OpportunityKind::PowerDeficit),
        "no generators yet → not an overdraw nag"
    );
}

/// milestone_gap is HONEST-SILENT: gamedata carries no schematic milestone
/// costs (schematics map to recipe unlocks only) and the session persists no
/// purchased-schematic set — so the family emits NOTHING, even on a busy plan
/// with starved targets and unlocked recipes.
#[test]
fn milestone_gap_is_honest_silent_without_costs() {
    let mut s = Session::in_memory(None).unwrap();
    ingot_factory(&mut s, "BUSY", 0.0, 0.0, 4, 120.0);
    s.unlocked.insert("Recipe_IngotIron_C".into());
    assert!(
        s.gamedata.schematics.is_empty(),
        "fixture precondition: no schematic data"
    );
    assert!(
        !next(&mut s)
            .iter()
            .any(|o| o.kind == OpportunityKind::MilestoneGap),
        "no schematic costs anywhere → milestone_gap never guesses"
    );
}

/// alt_adopt: surfaces the TOP altopt opportunity (computation reused, not
/// re-derived) once an alternate is unlocked; silent with nothing unlocked.
/// The evidence carries the whole trade with verbs ("saves N MW").
#[test]
fn alt_adopt_reuses_altopt_top_row() {
    let mut s = Session::in_memory(None).unwrap();
    // a planned 4-smelter ingot line on the standard recipe
    ingot_factory(&mut s, "INGOTS", 0.0, 0.0, 4, 120.0);
    assert!(
        !next(&mut s)
            .iter()
            .any(|o| o.kind == OpportunityKind::AltAdopt),
        "nothing unlocked → silent (fixture reality)"
    );

    // inject a strictly-cheaper unlocked alternate (altopt test pattern)
    let std = s
        .gamedata
        .recipes
        .get("Recipe_IngotIron_C")
        .unwrap()
        .clone();
    let doubled = std
        .products
        .iter()
        .map(|(i, n)| (i.clone(), n * 2.0))
        .collect();
    s.gamedata.recipes.insert(
        "Recipe_Alt_IngotIron_C".into(),
        Recipe {
            class_name: "Recipe_Alt_IngotIron_C".into(),
            display_name: "Pure Iron Ingot".into(),
            products: doubled,
            alternate: true,
            ..std
        },
    );
    s.unlocked.insert("Recipe_Alt_IngotIron_C".into());

    let expected = app::altopt::empire_optimize(&s.state, &s.gamedata, &s.unlocked)
        .into_iter()
        .next()
        .expect("altopt sees the win");
    let opps = next(&mut s);
    let o = find_kind(&opps, OpportunityKind::AltAdopt).expect("unlocked cheaper alt fires");
    assert!(
        o.title
            .contains(&format!("saves {} machines", expected.machines_saved)),
        "advertised savings come from altopt verbatim: {}",
        o.title
    );
    assert_eq!(
        o.evidence, "−2 machines · saves 8 MW · on Iron Ingot",
        "the trade line: machines, a power VERB, the product"
    );
    assert_eq!(o.item.as_deref(), Some(expected.product.as_str()));
    assert_eq!(
        o.action,
        OpportunityAction::OpenAudit {
            tab: "optimizer".into()
        }
    );
}

/// M4: a power-costing alternate says "costs N MW" (never an ambiguous "+"),
/// a built line prices its retool hours, and an ingredient the empire neither
/// makes nor imports is named as a NEW chain with its rate. The "Alternate: "
/// display prefix strips in the card only (the chip carries ALT).
#[test]
fn alt_adopt_shows_costs_retool_and_new_chain() {
    let mut s = Session::in_memory(None).unwrap();
    let (fid, _) = ingot_factory(&mut s, "OLD INGOTS", 0.0, 0.0, 4, 120.0);
    // Flip the smelter bank to ◆ Built directly (import is the only command
    // path to Built; state surgery is the established test shortcut). Built
    // groups adopt via plan_replacement, so sourceability doesn't gate them.
    let bank = s
        .state
        .groups
        .values()
        .find(|g| g.factory == fid)
        .unwrap()
        .id
        .clone();
    s.state.groups.get_mut(&bank).unwrap().status = Status::Built;

    let std = s
        .gamedata
        .recipes
        .get("Recipe_IngotIron_C")
        .unwrap()
        .clone();
    let doubled: Vec<(String, f64)> = std
        .products
        .iter()
        .map(|(i, n)| (i.clone(), n * 2.0))
        .collect();
    let mut ingredients = std.ingredients.clone();
    ingredients.push(("Desc_Coal_C".into(), 1.0)); // nobody makes or imports coal here
    s.gamedata.recipes.insert(
        "Recipe_Alt_CokedIron_C".into(),
        Recipe {
            class_name: "Recipe_Alt_CokedIron_C".into(),
            display_name: "Alternate: Coked Iron Ingot".into(),
            products: doubled,
            ingredients,
            alternate: true,
            variable_power_mw: Some(100.0), // 2 × 100 MW vs 4 × 4 MW → costs
            ..std
        },
    );
    s.unlocked.insert("Recipe_Alt_CokedIron_C".into());

    let opps = next(&mut s);
    let o = find_kind(&opps, OpportunityKind::AltAdopt).expect("net machine win fires");
    assert!(
        o.title.starts_with("Alt Coked Iron Ingot saves 2 machines"),
        "display prefix stripped, no 'Alt Alternate:': {}",
        o.title
    );
    assert_eq!(
        o.evidence,
        "−2 machines · costs 184 MW · ~0.3 h retool · needs new Coal chain (60.0/min) · on Iron Ingot",
        "the honest trade: cost verb, retool hours, new input chain"
    );
}

/// M1: an under-clocked claim on an item NOBODY is short of is deliberate
/// ratio-matching, not an opportunity — silence.
#[test]
fn under_extracted_silent_without_demand() {
    let mut s = Session::in_memory(None).unwrap();
    let fid = mk_factory(&mut s, "MINE HEAD", 0.0, 0.0);
    s.edit(vec![Command::ClaimNode {
        factory: fid,
        node: "bp_resourcenode496".into(),
        extractor: "Build_MinerMk2_C".into(),
        clock: 0.5,
    }])
    .unwrap();

    assert!(
        !next(&mut s)
            .iter()
            .any(|o| o.kind == OpportunityKind::UnderExtracted),
        "no demand for iron ore anywhere → the half-clock claim is a choice, not a gap"
    );
}

/// M1: a claim fires when its item carries an empire-wide PRODUCTION gap; at
/// most one card per item (the largest gain wins); save-only claims (no
/// catalog node → no item, no purity) stay silent even under demand. Also
/// pins the L2 wording: purity+item title, id trailing in the evidence, the
/// lost rate quantified, no duplicated "% clock".
#[test]
fn under_extracted_fires_on_demand_one_card_per_item() {
    let mut s = Session::in_memory(None).unwrap();
    // Ore chain starved by production: the mine ships 30 of the 120 ore the
    // smelter's target needs through a slack Mk.4 route → 90/min production gap.
    let (mine, ore_out) = ore_mine(&mut s, "IRON MINE", -1100.0, -500.0, 120.0);
    let (_, ore_in, ingot_out) = ore_smelter(&mut s, "SMELT ROW", -600.0, -500.0, 4);
    belt_route(&mut s, &ore_out, &ore_in, 4);
    set_rate(&mut s, &ingot_out, 120.0); // satisfiable now
    set_rate(&mut s, &ore_out, 30.0); // the dip → ore production gap 90

    for (node, clock) in [
        ("bp_resourcenode114", 0.5),  // pure iron, gain 120 — the winner
        ("bp_resourcenode115", 0.75), // pure iron, gain 60 — deduped away
        ("save:Persistent_Level:PersistentLevel.Miner_1", 0.25), // save-only
    ] {
        s.edit(vec![Command::ClaimNode {
            factory: mine.clone(),
            node: node.into(),
            extractor: "Build_MinerMk2_C".into(),
            clock,
        }])
        .unwrap();
    }

    let opps = next(&mut s);
    assert_eq!(
        count_kind(&opps, OpportunityKind::UnderExtracted),
        1,
        "one card per item, save-only claims silent"
    );
    let o = find_kind(&opps, OpportunityKind::UnderExtracted).unwrap();
    assert_eq!(o.title, "Pure Iron Ore node is extracting at 50% clock");
    assert_eq!(
        o.evidence,
        "bp_resourcenode114 · claimed by IRON MINE · +120.0/min available at 100%"
    );
    assert_eq!(o.item.as_deref(), Some("Desc_OreIron_C"));
    assert_eq!(o.action, OpportunityAction::SelectFactory { id: mine });
}

/// M1: the other demand channel — the owning factory genuinely BOUND by the
/// claim's own ceiling (output running AT an InputCeiling whose reported
/// figure equals the port's stored ceiling). No empire deficit needed.
#[test]
fn under_extracted_fires_when_claim_ceiling_binds() {
    let mut s = Session::in_memory(None).unwrap();
    let fid = mk_factory(&mut s, "BOUND WORKS", 0.0, 0.0);
    s.edit(vec![Command::ClaimNode {
        factory: fid.clone(),
        node: "bp_resourcenode114".into(), // pure iron
        extractor: "Build_MinerMk2_C".into(),
        clock: 0.5, // 120/min of a possible 240
    }])
    .unwrap();
    // Wizard convention: the In port's ceiling IS the claimed extraction rate.
    let ore_in = add_port(
        &mut s,
        &fid,
        PortDirection::In,
        "Desc_OreIron_C",
        Some(120.0),
    );
    let out = add_port(&mut s, &fid, PortDirection::Out, "Desc_IronIngot_C", None);
    let bank = add_group(&mut s, &fid, "Build_SmelterMk1_C", "Recipe_IngotIron_C", 4);
    belt(
        &mut s,
        &fid,
        EdgeEnd::Port(ore_in),
        EdgeEnd::Group(bank.clone()),
        "Desc_OreIron_C",
    );
    belt(
        &mut s,
        &fid,
        EdgeEnd::Group(bank),
        EdgeEnd::Port(out.clone()),
        "Desc_IronIngot_C",
    );
    set_rate(&mut s, &out, 120.0); // runs exactly AT the claim ceiling

    let opps = next(&mut s);
    let o = find_kind(&opps, OpportunityKind::UnderExtracted)
        .expect("ceiling-bound factory demands the lost extraction");
    assert!(
        o.evidence.contains("+120.0/min available at 100%"),
        "{}",
        o.evidence
    );
}

/// M1 boundary: an InputCeiling whose reported figure is the ROUTE's injected
/// supply (not the port's stored ceiling) is a transport limit — raising the
/// claim's clock moves nothing, so the family stays silent.
#[test]
fn under_extracted_silent_when_route_supply_binds() {
    let mut s = Session::in_memory(None).unwrap();
    let (_, ore_out) = ore_mine(&mut s, "FAR MINE", 0.0, 0.0, 240.0);
    let (smelt, ore_in, ingot_out) = ore_smelter(&mut s, "HUNGRY SMELT", 500.0, 0.0, 16);
    let route = belt_route(&mut s, &ore_out, &ore_in, 4);
    set_rate(&mut s, &ingot_out, 240.0); // satisfiable over Mk.4
    s.edit(vec![Command::SetRouteTier {
        id: route,
        tier: 1, // now the BELT caps ore at 60 — pure transport gap
    }])
    .unwrap();
    s.edit(vec![Command::ClaimNode {
        factory: smelt,
        node: "bp_resourcenode114".into(),
        extractor: "Build_MinerMk2_C".into(),
        clock: 0.5,
    }])
    .unwrap();

    let opps = next(&mut s);
    assert!(
        opps.iter()
            .any(|o| o.kind == OpportunityKind::RouteBottleneckFix),
        "the belt is the story"
    );
    assert!(
        !opps
            .iter()
            .any(|o| o.kind == OpportunityKind::UnderExtracted),
        "route-injected ceiling is not the claim's — clocking up moves nothing"
    );
}

/// untapped_node: unclaimed pure nodes near a factory surface nearest-first
/// (distance ASC), DEDUPED to one card per item (L1 — three coal pins in one
/// seam are one idea), capped at 3; claiming one removes it; with no
/// factories at all the family is silent (no anchor — honest).
#[test]
fn untapped_node_nearest_pure_unclaimed() {
    let mut s = Session::in_memory(None).unwrap();
    assert!(
        next(&mut s).is_empty(),
        "no factories → no untapped candidates"
    );

    // park a factory on a known pure-node cluster (coal around −1100, −500)
    let fid = mk_factory(&mut s, "PROSPECT CAMP", -1100.0, -500.0);
    let opps = next(&mut s);
    let untapped: Vec<&Opportunity> = opps
        .iter()
        .filter(|o| o.kind == OpportunityKind::UntappedNode)
        .collect();
    assert_eq!(untapped.len(), 3, "nearest 3 items");
    for o in &untapped {
        assert!(o.title.starts_with("Pure "), "{}", o.title);
        assert!(o.evidence.contains("m from"), "{}", o.evidence);
        // the raw id trails the evidence, never leads it (L2)
        let node = o.id.strip_prefix("untapped_node:").unwrap();
        assert!(o.evidence.ends_with(node), "{}", o.evidence);
    }
    // L1: one card per item — the coal seam's three pins collapse to one
    let items: std::collections::BTreeSet<&str> =
        untapped.iter().filter_map(|o| o.item.as_deref()).collect();
    assert_eq!(items.len(), untapped.len(), "items must be distinct");
    // distance ASC: evidence distances are non-decreasing
    let dist = |o: &Opportunity| -> f64 {
        o.evidence
            .split('~')
            .nth(1)
            .and_then(|t| t.split(' ').next())
            .and_then(|n| n.parse().ok())
            .unwrap()
    };
    for w in untapped.windows(2) {
        assert!(dist(w[0]) <= dist(w[1]), "nearest first");
    }

    // claim the nearest → it drops off the list
    let first_node = untapped[0]
        .id
        .strip_prefix("untapped_node:")
        .unwrap()
        .to_string();
    s.edit(vec![Command::ClaimNode {
        factory: fid,
        node: first_node.clone(),
        extractor: "Build_MinerMk2_C".into(),
        clock: 1.0,
    }])
    .unwrap();
    assert!(
        !next(&mut s)
            .iter()
            .any(|o| o.id == format!("untapped_node:{first_node}")),
        "claimed nodes are no longer untapped"
    );
}

/// L3: a cave node's ENTRANCE always anchors its distance — a plan-local
/// position override corrects the node marker, not the way in. If the
/// override won here (9 500 m) the node would vanish from the radius
/// entirely; the entrance keeps it at ~2 000 m.
#[test]
fn untapped_node_entrance_wins_over_override() {
    let mut s = Session::in_memory(None).unwrap();
    // an empty corner of the coordinate space — no catalog nodes in range
    mk_factory(&mut s, "DEEP CAMP", 50000.0, 50000.0);
    s.world.nodes.push(WorldNode {
        id: "test_cave_iron".into(),
        item: "Desc_OreIron_C".into(),
        purity: "pure".into(),
        x: 59000.0,
        y: 50000.0,
        z: 0.0,
        zone: "cave".into(),
        entrance: Some(Entrance {
            x: 52000.0,
            y: 50000.0,
            z: 0.0,
        }),
        region: "grass-fields".into(),
    });
    s.edit(vec![Command::SetNodeOverride {
        id: "test_cave_iron".into(),
        node_override: Some(NodeOverride {
            id: "test_cave_iron".into(),
            pos: Some(MapPos {
                x: 59500.0,
                y: 50000.0,
                z: 0.0,
            }),
            save_actor: None,
        }),
    }])
    .unwrap();

    let opps = next(&mut s);
    let o = opps
        .iter()
        .find(|o| o.id == "untapped_node:test_cave_iron")
        .expect("entrance at 2 km keeps the cave node in range");
    assert!(
        o.evidence.starts_with("~2000 m from DEEP CAMP"),
        "entrance anchors the distance: {}",
        o.evidence
    );
}

/// Ranking: class order is broken → savings → growth, and the list caps at 12
/// even when more candidates exist.
#[test]
fn ranking_class_order_and_cap() {
    let mut s = Session::in_memory(None).unwrap();
    // class 1 evidence: an ore chain starved by production (slack route), on
    // a DEMANDED item so the class-6 claim below survives the M1 gate
    let (mine, ore_out) = ore_mine(&mut s, "SHORT SUPPLY", -1100.0, -500.0, 120.0);
    let (_, ore_in, ingot_out) = ore_smelter(&mut s, "WANTS MORE", -600.0, -500.0, 4);
    belt_route(&mut s, &ore_out, &ore_in, 4);
    set_rate(&mut s, &ingot_out, 120.0); // satisfiable now
    set_rate(&mut s, &ore_out, 30.0); // upstream dips → ore deficit
                                      // class 6 evidence: an under-clocked claim on the demanded ore
    s.edit(vec![Command::ClaimNode {
        factory: mine,
        node: "bp_resourcenode114".into(),
        extractor: "Build_MinerMk2_C".into(),
        clock: 0.5,
    }])
    .unwrap();
    // class 0 pressure: nine separate overdrawn grids (10 MW plants under
    // 16 MW loads), parked far from every catalog node
    for i in 0..9 {
        let x = 40000.0 + (i as f64) * 2000.0;
        let plant = coal_plant(&mut s, &format!("PLANT {i}"), x, 40000.0, 10.0);
        let (load, _) = ingot_factory(&mut s, &format!("LOAD {i}"), x, 41000.0, 4, 120.0);
        power_route(&mut s, &plant, &load);
    }

    let opps = next(&mut s);
    assert_eq!(opps.len(), 12, "capped at 12");
    // classes never regress along the list
    let class = |k: OpportunityKind| -> u8 {
        match k {
            OpportunityKind::PowerDeficit => 0,
            OpportunityKind::DeficitRepair => 1,
            OpportunityKind::RouteBottleneckFix => 2,
            OpportunityKind::PowerMargin => 3,
            OpportunityKind::MilestoneGap => 4,
            OpportunityKind::AltAdopt => 5,
            OpportunityKind::UnderExtracted => 6,
            OpportunityKind::UntappedNode => 7,
        }
    };
    for w in opps.windows(2) {
        assert!(
            class(w[0].kind) <= class(w[1].kind),
            "class order must be monotone: {:?} then {:?}",
            w[0].kind,
            w[1].kind
        );
    }
    // broken leads: the overdrawn grids (class 0) head the list
    assert_eq!(opps[0].kind, OpportunityKind::PowerDeficit);
    assert_eq!(count_kind(&opps, OpportunityKind::PowerDeficit), 9);
    // the demanded-item claim survives the gate and the cap
    let clock_card = find_kind(&opps, OpportunityKind::UnderExtracted)
        .expect("demanded under-clocked claim in the top 12");
    assert!(
        clock_card.title.contains("50% clock"),
        "{}",
        clock_card.title
    );
}
