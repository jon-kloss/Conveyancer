//! Authored clocks survive re-solves (regression: clicking 250% reverted to
//! ~100% on the next solve-inducing edit, because the write-back re-derived
//! count/clock as spread-at-≤100% and discarded the user's clock).

use app::Session;
use planner_core::commands::Command;
use planner_core::entities::*;

fn gp(x: f64, y: f64) -> GraphPos {
    GraphPos { x, y }
}

/// One smelter chain: iron IN port → smelter group → ingot OUT port.
#[cfg(feature = "sqlite")]
fn smelter_factory(s: &mut Session) -> (Id, Id, Id) {
    let r = s
        .edit(vec![Command::CreateFactory {
            name: "CLOCK LAB".into(),
            position: MapPos {
                x: 0.0,
                y: 0.0,
                z: 0.0,
            },
            region: "GRASS FIELDS".into(),
        }])
        .unwrap();
    let fid = r.created[0].clone();

    let r = s
        .edit(vec![Command::AddPort {
            factory: fid.clone(),
            direction: PortDirection::In,
            item: "Desc_OreIron_C".into(),
            rate: 0.0,
            rate_ceiling: Some(120.0),
            graph_pos: gp(0.0, 200.0),
        }])
        .unwrap();
    let in_port = r.created[0].clone();
    let r = s
        .edit(vec![Command::AddPort {
            factory: fid.clone(),
            direction: PortDirection::Out,
            item: "Desc_IronIngot_C".into(),
            rate: 0.0,
            rate_ceiling: None,
            graph_pos: gp(800.0, 200.0),
        }])
        .unwrap();
    let out_port = r.created[0].clone();

    let r = s
        .edit(vec![Command::AddGroup {
            factory: fid.clone(),
            machine: "Build_SmelterMk1_C".into(),
            recipe: "Recipe_IngotIron_C".into(),
            count: 1,
            clock: 1.0,
            graph_pos: gp(400.0, 200.0),
            floor: 0,
        }])
        .unwrap();
    let smelt = r.created[0].clone();

    s.edit(vec![Command::AddEdge {
        factory: fid.clone(),
        from: EdgeEnd::Port(in_port),
        to: EdgeEnd::Group(smelt.clone()),
        item: "Desc_OreIron_C".into(),
        tier: 3,
    }])
    .unwrap();
    s.edit(vec![Command::AddEdge {
        factory: fid.clone(),
        from: EdgeEnd::Group(smelt.clone()),
        to: EdgeEnd::Port(out_port.clone()),
        item: "Desc_IronIngot_C".into(),
        tier: 3,
    }])
    .unwrap();

    (fid, out_port, smelt)
}

#[cfg(feature = "sqlite")]
#[test]
fn authored_clock_survives_resolves() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("world.ficsit");
    let mut s = Session::open(&path, None, "fixture").unwrap();
    let (_fid, out_port, smelt) = smelter_factory(&mut s);

    // 48/min = 1.6 smelter-equivalents at 100%.
    s.edit(vec![Command::SetPortRate {
        id: out_port.clone(),
        rate: 48.0,
    }])
    .unwrap();
    // Untouched group: solver-owned spread at ≤100% (pinned behavior).
    let g = &s.state.groups[&smelt];
    assert_eq!(g.count, 2);
    assert!(
        (g.clock - 0.8).abs() < 1e-6,
        "spread clock, got {}",
        g.clock
    );
    assert_eq!(g.clock_ceiling, None);

    // Click "250": consolidate — 1 machine at 250% covers 1.6 equivalents.
    s.edit(vec![Command::SetGroupClock {
        id: smelt.clone(),
        clock: 2.5,
    }])
    .unwrap();
    let g = &s.state.groups[&smelt];
    assert_eq!(g.count, 1);
    assert!((g.clock - 2.5).abs() < 1e-9, "got {}", g.clock);
    assert_eq!(g.clock_ceiling, Some(2.5));

    // Any later solve-inducing edit used to revert the clock to ~100%.
    s.edit(vec![Command::MoveGroupCard {
        id: smelt.clone(),
        graph_pos: gp(410.0, 200.0),
    }])
    .unwrap();
    let g = &s.state.groups[&smelt];
    assert!(
        (g.clock - 2.5).abs() < 1e-9,
        "authored 250% must survive a re-solve, got {}",
        g.clock
    );
    assert_eq!(g.count, 1);

    // Demand changes still re-derive count, at the authored clock.
    s.edit(vec![Command::SetPortRate {
        id: out_port.clone(),
        rate: 90.0, // 3 equivalents → ceil(3 / 2.5) = 2 machines @ 250%
    }])
    .unwrap();
    let g = &s.state.groups[&smelt];
    assert_eq!(g.count, 2);
    assert!((g.clock - 2.5).abs() < 1e-9, "got {}", g.clock);

    // An authored UNDERclock persists the same way.
    s.edit(vec![Command::SetGroupClock {
        id: smelt.clone(),
        clock: 0.5,
    }])
    .unwrap();
    s.edit(vec![Command::MoveGroupCard {
        id: smelt.clone(),
        graph_pos: gp(420.0, 200.0),
    }])
    .unwrap();
    let g = &s.state.groups[&smelt];
    assert_eq!(g.count, 6, "ceil(3 / 0.5)");
    assert!((g.clock - 0.5).abs() < 1e-9, "got {}", g.clock);

    // Undo unwinds the authored clock (ceiling rides the same undo entry).
    s.undo().unwrap().unwrap(); // move
    s.undo().unwrap().unwrap(); // clock 0.5
    let g = &s.state.groups[&smelt];
    assert!(
        (g.clock - 2.5).abs() < 1e-9,
        "undo back to 250%, got {}",
        g.clock
    );
    assert_eq!(g.clock_ceiling, Some(2.5));
}
