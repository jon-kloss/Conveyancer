//! PR 9 opportunity engine: every family fires ONLY on real derived evidence
//! and stays silent without it (honest silence — never a guessed number);
//! ranking is the documented class-order tuple, capped at 12.

use app::opportunities::{derive_opportunities, Opportunity, OpportunityAction, OpportunityKind};
use app::Session;
use gamedata::docs::Recipe;
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

/// An empty plan yields NOTHING — silence, not filler ideas.
#[test]
fn empty_plan_is_silent() {
    let mut s = Session::in_memory(None).unwrap();
    assert!(next(&mut s).is_empty(), "no evidence → no opportunities");
}

/// power_deficit: a grid drawing more than it generates fires class 0 with
/// the derived MW pair as evidence; a healthy grid stays silent.
#[test]
fn power_deficit_fires_on_overdraw_only() {
    let mut s = Session::in_memory(None).unwrap();
    // 75 MW plant powering a 128 MW load (32 smelters @ 4 MW) → overdrawn.
    let plant = coal_plant(&mut s, "POWER RIDGE", 0.0, 0.0, 75.0);
    let (load, _) = ingot_factory(&mut s, "LOAD BLOCK", 100.0, 0.0, 32, 960.0);
    power_route(&mut s, &plant, &load);

    let opps = next(&mut s);
    let o = opps
        .iter()
        .find(|o| o.kind == OpportunityKind::PowerDeficit)
        .expect("overdrawn grid fires power_deficit");
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

/// deficit_repair: starved targets group by item empire-wide; the action is a
/// wizard prefill at the ceiled missing rate.
#[test]
fn deficit_repair_groups_by_item_and_prefills_wizard() {
    let mut s = Session::in_memory(None).unwrap();
    // Build the chain SATISFIED first (the downstream target must be set while
    // achievable — an unachievable SetPortRate is clamp-written-back), then
    // dip the upstream to 10/min so the 60-rod target honestly starves.
    let (_, ingot_out) = ingot_factory(&mut s, "OPPORTUNITY BAY", 0.0, 0.0, 4, 60.0);
    let rods = mk_factory(&mut s, "FOUNDRY GAP", 500.0, 0.0);
    let ingot_in = add_port(&mut s, &rods, PortDirection::In, "Desc_IronIngot_C", None);
    let rod_out = add_port(&mut s, &rods, PortDirection::Out, "Desc_IronRod_C", None);
    let ctors = add_group(
        &mut s,
        &rods,
        "Build_ConstructorMk1_C",
        "Recipe_IronRod_C",
        4,
    );
    belt(
        &mut s,
        &rods,
        EdgeEnd::Port(ingot_in.clone()),
        EdgeEnd::Group(ctors.clone()),
        "Desc_IronIngot_C",
    );
    belt(
        &mut s,
        &rods,
        EdgeEnd::Group(ctors),
        EdgeEnd::Port(rod_out.clone()),
        "Desc_IronRod_C",
    );
    s.edit(vec![Command::AddRoute {
        kind: RouteKind::Belt { tier: 4 },
        from: ingot_out.clone(),
        to: ingot_in,
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
    .unwrap();
    set_rate(&mut s, &rod_out, 60.0); // satisfiable now
    set_rate(&mut s, &ingot_out, 10.0); // upstream dips → downstream starves

    let opps = next(&mut s);
    let o = opps
        .iter()
        .find(|o| o.kind == OpportunityKind::DeficitRepair)
        .expect("starved chain fires deficit_repair");
    assert!(o.title.contains("Iron Ingot"), "{}", o.title);
    assert!(o.title.contains("empire-wide"), "{}", o.title);
    assert_eq!(o.item.as_deref(), Some("Desc_IronIngot_C"));
    match &o.action {
        OpportunityAction::WizardGoal { item, rate } => {
            assert_eq!(item, "Desc_IronIngot_C");
            assert_eq!(*rate, 50.0, "ceil(60 needed − 10 supplied)");
        }
        other => panic!("expected WizardGoal, got {other:?}"),
    }
    // deterministic id — stable across recomputes
    assert_eq!(o.id, "deficit_repair:Desc_IronIngot_C");
}

/// route_bottleneck_fix: fires ONLY when a FULL route has a deficit routed
/// through it, and the title names the tier bump; a full-but-satisfied route
/// stays silent (the efficiency grammar — 100% meeting demand is optimal).
#[test]
fn route_bottleneck_fires_only_with_deficit_through_it() {
    let mut s = Session::in_memory(None).unwrap();
    // upstream can push 120/min; the Mk.1 route caps at 60; downstream wants 120.
    let (_, ingot_out) = ingot_factory(&mut s, "BIG SMELT", 0.0, 0.0, 4, 120.0);
    let rods = mk_factory(&mut s, "ROD SINK", 500.0, 0.0);
    let ingot_in = add_port(&mut s, &rods, PortDirection::In, "Desc_IronIngot_C", None);
    let rod_out = add_port(&mut s, &rods, PortDirection::Out, "Desc_IronRod_C", None);
    let ctors = add_group(
        &mut s,
        &rods,
        "Build_ConstructorMk1_C",
        "Recipe_IronRod_C",
        8,
    );
    belt(
        &mut s,
        &rods,
        EdgeEnd::Port(ingot_in.clone()),
        EdgeEnd::Group(ctors.clone()),
        "Desc_IronIngot_C",
    );
    belt(
        &mut s,
        &rods,
        EdgeEnd::Group(ctors),
        EdgeEnd::Port(rod_out.clone()),
        "Desc_IronRod_C",
    );
    // Route starts at Mk.4 so the 120-rod target is set while achievable,
    // then drops to Mk.1 (60 cap) — the tier change never rewrites targets,
    // so the route now runs FULL with a 60/min deficit through it.
    let route = s
        .edit(vec![Command::AddRoute {
            kind: RouteKind::Belt { tier: 4 },
            from: ingot_out,
            to: ingot_in,
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
        .clone();
    set_rate(&mut s, &rod_out, 120.0);
    s.edit(vec![Command::SetRouteTier {
        id: route.clone(),
        tier: 1,
    }])
    .unwrap();

    let opps = next(&mut s);
    let o = opps
        .iter()
        .find(|o| o.kind == OpportunityKind::RouteBottleneckFix)
        .expect("full route with deficit through it fires");
    assert!(o.title.contains("caps demand"), "{}", o.title);
    assert!(o.title.contains("Mk.2"), "names the tier bump: {}", o.title);
    assert_eq!(
        o.action,
        OpportunityAction::SelectRoute { id: route.clone() }
    );
    // ...and it ranks AFTER the deficit_repair rows (class 1 < class 2)
    let d = opps
        .iter()
        .position(|o| o.kind == OpportunityKind::DeficitRepair)
        .unwrap();
    let r = opps
        .iter()
        .position(|o| o.kind == OpportunityKind::RouteBottleneckFix)
        .unwrap();
    assert!(d < r, "deficit_repair (class 1) before route fix (class 2)");

    // downstream relaxes to 60/min: the route is FULL but satisfied → silent
    set_rate(&mut s, &rod_out, 60.0);
    assert!(
        !next(&mut s)
            .iter()
            .any(|o| o.kind == OpportunityKind::RouteBottleneckFix),
        "a full route that meets demand is optimal — no candidate"
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
    let o = opps
        .iter()
        .find(|o| o.kind == OpportunityKind::PowerMargin)
        .expect("thin-headroom grid fires power_margin");
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
    let o = opps
        .iter()
        .find(|o| o.kind == OpportunityKind::AltAdopt)
        .expect("unlocked cheaper alt fires alt_adopt");
    assert!(
        o.title
            .contains(&format!("saves {} machines", expected.machines_saved)),
        "advertised savings come from altopt verbatim: {}",
        o.title
    );
    assert_eq!(o.item.as_deref(), Some(expected.product.as_str()));
    assert_eq!(
        o.action,
        OpportunityAction::OpenAudit {
            tab: "optimizer".into()
        }
    );
}

/// under_extracted: a claim below 100% clock fires with the owning factory as
/// the action target; a full-clock claim is silent.
#[test]
fn under_extracted_fires_below_full_clock() {
    let mut s = Session::in_memory(None).unwrap();
    let fid = mk_factory(&mut s, "MINE HEAD", 0.0, 0.0);
    s.edit(vec![Command::ClaimNode {
        factory: fid.clone(),
        node: "bp_resourcenode496".into(),
        extractor: "Build_MinerMk2_C".into(),
        clock: 0.5,
    }])
    .unwrap();

    let opps = next(&mut s);
    let o = opps
        .iter()
        .find(|o| o.kind == OpportunityKind::UnderExtracted)
        .expect("half-clock claim fires under_extracted");
    assert!(o.title.contains("50% clock"), "{}", o.title);
    assert_eq!(
        o.action,
        OpportunityAction::SelectFactory { id: fid.clone() }
    );

    // full clock → silent
    let claim = s.state.node_claims.values().next().unwrap().id.clone();
    s.edit(vec![Command::ReleaseNode { id: claim }]).unwrap();
    s.edit(vec![Command::ClaimNode {
        factory: fid,
        node: "bp_resourcenode496".into(),
        extractor: "Build_MinerMk2_C".into(),
        clock: 1.0,
    }])
    .unwrap();
    assert!(
        !next(&mut s)
            .iter()
            .any(|o| o.kind == OpportunityKind::UnderExtracted),
        "full-clock claims are not opportunities"
    );
}

/// untapped_node: unclaimed pure nodes near a factory surface nearest-first
/// (distance ASC), capped at 3; claiming one removes it from the list; with
/// no factories at all the family is silent (no anchor — honest).
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
    assert!(!untapped.is_empty(), "pure nodes nearby must surface");
    assert!(untapped.len() <= 3, "nearest 3 only");
    for o in &untapped {
        assert!(o.title.starts_with("Pure "), "{}", o.title);
        assert!(o.evidence.contains("m from"), "{}", o.evidence);
    }
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

/// Ranking: class order is broken → savings → growth, and the list caps at 12
/// even when more candidates exist.
#[test]
fn ranking_class_order_and_cap() {
    let mut s = Session::in_memory(None).unwrap();
    // class 1 evidence: a chain built satisfied, then starved by upstream dip
    let (_, ingot_out) = ingot_factory(&mut s, "SHORT SUPPLY", 0.0, 0.0, 4, 60.0);
    let rods = mk_factory(&mut s, "WANTS MORE", 500.0, 0.0);
    let ingot_in = add_port(&mut s, &rods, PortDirection::In, "Desc_IronIngot_C", None);
    let rod_out = add_port(&mut s, &rods, PortDirection::Out, "Desc_IronRod_C", None);
    let ctors = add_group(
        &mut s,
        &rods,
        "Build_ConstructorMk1_C",
        "Recipe_IronRod_C",
        4,
    );
    belt(
        &mut s,
        &rods,
        EdgeEnd::Port(ingot_in.clone()),
        EdgeEnd::Group(ctors.clone()),
        "Desc_IronIngot_C",
    );
    belt(
        &mut s,
        &rods,
        EdgeEnd::Group(ctors),
        EdgeEnd::Port(rod_out.clone()),
        "Desc_IronRod_C",
    );
    s.edit(vec![Command::AddRoute {
        kind: RouteKind::Belt { tier: 4 },
        from: ingot_out.clone(),
        to: ingot_in,
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
    .unwrap();
    set_rate(&mut s, &rod_out, 60.0); // satisfiable now
    set_rate(&mut s, &ingot_out, 10.0); // upstream dips → deficit
                                        // class 6 evidence: a stack of under-clocked claims (13 → forces the cap
                                        // with the deficit + untapped rows also present)
    for i in 0..13u32 {
        let node = format!("bp_resourcenode{}", 100 + i);
        s.edit(vec![Command::ClaimNode {
            factory: rods.clone(),
            node,
            extractor: "Build_MinerMk2_C".into(),
            clock: 0.25 + (i as f64) * 0.05,
        }])
        .unwrap();
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
    // magnitude DESC within the under_extracted class: lowest clock first
    let clocks: Vec<&Opportunity> = opps
        .iter()
        .filter(|o| o.kind == OpportunityKind::UnderExtracted)
        .collect();
    assert!(clocks.len() >= 2, "cap leaves room for several claims");
    assert!(
        clocks[0].title.contains("25% clock"),
        "most under-clocked claim leads its class: {}",
        clocks[0].title
    );
    // deficit (class 1) leads everything else present
    assert_eq!(opps[0].kind, OpportunityKind::DeficitRepair);
}
