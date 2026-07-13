//! W2b-C node reconciliation: import binds ◆ NodeClaims to real save nodes by
//! stable id; positions reconcile through a plan-local `node_overrides` overlay
//! (snapshot ⊕ override, the bundled asset never mutated) with re-import drift
//! rows that auto-dissolve when the save agrees with the catalog again.

use std::collections::BTreeMap;

use app::import::{resolved_node_pos, ImportMachine, ImportSnapshot};
use app::session::ImportOutcome;
use app::Session;
use planner_core::commands::Command;
use planner_core::entities::{CreatedBy, MapPos, NodeOverride, Status};

fn smelter(x: f64, y: f64) -> ImportMachine {
    ImportMachine {
        class: "Build_SmelterMk1_C".into(),
        recipe: Some("Recipe_IngotIron_C".into()),
        clock: 1.0,
        x,
        y,
        z: 0.0,
        ..Default::default()
    }
}

fn miner(x: f64, y: f64, actor: &str) -> ImportMachine {
    ImportMachine {
        class: "Build_MinerMk2_C".into(),
        recipe: None,
        clock: 1.0,
        x,
        y,
        z: 0.0,
        node_actor_id: Some(actor.into()),
        ..Default::default()
    }
}

/// A miner sitting on a bundled node binds to that snapshot id with the save's
/// stable ref recorded; a miner on no known node mints a `save:<id>` claim.
#[test]
fn claim_binding_snapshot_and_save_local() {
    let mut s = Session::in_memory(None).unwrap();
    let node = s.world.nodes[0].clone();

    let snap = ImportSnapshot {
        save_name: "NODES".into(),
        machines: vec![smelter(node.x, node.y), smelter(100_000.0, 100_000.0)],
        extractors: vec![
            miner(node.x, node.y, "actor-near"),
            miner(100_000.0, 100_000.0, "actor-far"),
        ],
        ..Default::default()
    };
    let outcome = s.import_save(snap).unwrap();
    assert!(matches!(outcome, ImportOutcome::Imported { .. }));

    // import created ◆ claims — the "zero claims" gap is closed.
    assert_eq!(s.state.node_claims.len(), 2, "one claim per miner");
    let near = s
        .state
        .node_claims
        .values()
        .find(|c| c.save_node_id.as_deref() == Some("actor-near"))
        .expect("near miner claim");
    assert_eq!(near.node, node.id, "bound to the bundled snapshot node");
    assert_eq!(near.status, Status::Built);
    assert!(matches!(near.created_by, CreatedBy::Import(_)));
    // within noise of the catalog coordinate → no correction written.
    assert!(!s.state.node_overrides.contains_key(&node.id));

    let far = s
        .state
        .node_claims
        .values()
        .find(|c| c.save_node_id.as_deref() == Some("actor-far"))
        .expect("far miner claim");
    assert_eq!(
        far.node, "save:actor-far",
        "no catalog node → plan-local id"
    );
    // the save-only node's position lives in the overlay alone.
    let ov = s.state.node_overrides.get("save:actor-far").unwrap();
    assert_eq!(ov.pos.unwrap().x, 100_000.0);

    // every claim is wired into its factory's claim list.
    let claimed: usize = s
        .state
        .factories
        .values()
        .map(|f| f.node_claims.len())
        .sum();
    assert_eq!(claimed, 2);
}

/// A node override corrects the resolved position; the bundled asset is unchanged.
#[test]
fn node_override_resolution_never_mutates_bundled() {
    let world = gamedata::worldnodes::bundled();
    let node = world.nodes[0].clone();
    let mut overrides: BTreeMap<String, NodeOverride> = BTreeMap::new();

    // no override → resolved is the catalog coordinate.
    let base = resolved_node_pos(&world, &overrides, &node.id).unwrap();
    assert_eq!((base.x, base.y), (node.x, node.y));

    // override → resolved is the corrected coordinate.
    let corrected = MapPos {
        x: node.x + 500.0,
        y: node.y - 250.0,
        z: 12.0,
    };
    overrides.insert(
        node.id.clone(),
        NodeOverride {
            id: node.id.clone(),
            pos: Some(corrected),
            save_actor: Some("actor".into()),
        },
    );
    let resolved = resolved_node_pos(&world, &overrides, &node.id).unwrap();
    assert_eq!(
        (resolved.x, resolved.y, resolved.z),
        (corrected.x, corrected.y, corrected.z)
    );

    // the ambient catalog is byte-for-byte untouched by resolution.
    assert_eq!(gamedata::worldnodes::bundled(), world);
}

/// First import binds silently; a divergent re-import emits a CorrectNodePosition
/// drift row (never auto-applied); accepting writes the override + lights the
/// derived drift flag; an identical re-import is IN SYNC; and the override
/// auto-dissolves once the save agrees with the snapshot again.
#[test]
fn position_drift_on_reimport_then_auto_dissolve() {
    let mut s = Session::in_memory(None).unwrap();
    let node = s.world.nodes[0].clone();

    // first import: miner exactly on the node → silent bind, no override.
    let base = ImportSnapshot {
        save_name: "DRIFT".into(),
        machines: vec![smelter(node.x, node.y)],
        extractors: vec![miner(node.x, node.y, "actor1")],
        ..Default::default()
    };
    s.import_save(base.clone()).unwrap();
    assert!(
        s.state.node_overrides.is_empty(),
        "silent first-import bind"
    );
    let claim_node = s.state.node_claims.values().next().unwrap().node.clone();

    // re-import with the miner moved 100 m (machine unmoved → factory matches).
    let moved = ImportSnapshot {
        save_name: "DRIFT".into(),
        machines: vec![smelter(node.x, node.y)],
        extractors: vec![miner(node.x + 100.0, node.y, "actor1")],
        ..Default::default()
    };
    let outcome = s.import_save(moved).unwrap();
    let ImportOutcome::Drift { proposal, .. } = outcome else {
        panic!("expected node-position drift");
    };
    let p = &s.state.proposals[&proposal];
    assert!(
        p.items.iter().any(|i| i.label.contains("moved in game")),
        "a CorrectNodePosition drift row: {:?}",
        p.items.iter().map(|i| &i.label).collect::<Vec<_>>()
    );

    // accept → override written, derived drift flag lit, catalog untouched.
    let resp = s.accept_proposal(&proposal).unwrap();
    let ov = s
        .state
        .node_overrides
        .get(&claim_node)
        .expect("override written");
    assert_eq!(ov.pos.unwrap().x, node.x + 100.0);
    assert!(
        resp.derived.nodes[&claim_node].drift,
        "derived node drift set"
    );
    assert!(
        !resp.derived.nodes[&claim_node].conflict,
        "single claim: no conflict"
    );

    // identical re-import (miner still at +100): resolved == save → IN SYNC.
    let same = ImportSnapshot {
        save_name: "DRIFT".into(),
        machines: vec![smelter(node.x, node.y)],
        extractors: vec![miner(node.x + 100.0, node.y, "actor1")],
        ..Default::default()
    };
    assert!(matches!(
        s.import_save(same).unwrap(),
        ImportOutcome::InSync
    ));

    // the save agrees with the snapshot again → drift row → accept dissolves it.
    let back = s.import_save(base).unwrap();
    let ImportOutcome::Drift { proposal, .. } = back else {
        panic!("expected a correction back toward the snapshot");
    };
    s.accept_proposal(&proposal).unwrap();
    assert!(
        !s.state.node_overrides.contains_key(&claim_node),
        "override auto-dissolves once the save agrees with the catalog"
    );
}

/// SetNodeOverride is a single undoable step (plan-local metadata, no guard).
#[test]
fn set_node_override_is_one_undo_entry() {
    let mut s = Session::in_memory(None).unwrap();
    assert!(s.state.node_overrides.is_empty());
    s.edit(vec![Command::SetNodeOverride {
        id: "save:x".into(),
        node_override: Some(NodeOverride {
            id: "save:x".into(),
            pos: Some(MapPos {
                x: 1.0,
                y: 2.0,
                z: 0.0,
            }),
            save_actor: None,
        }),
    }])
    .unwrap();
    assert_eq!(s.state.node_overrides.len(), 1);
    s.undo().unwrap().unwrap();
    assert!(s.state.node_overrides.is_empty(), "one undo removes it");
    s.redo().unwrap().unwrap();
    assert_eq!(s.state.node_overrides.len(), 1, "one redo restores it");
}
