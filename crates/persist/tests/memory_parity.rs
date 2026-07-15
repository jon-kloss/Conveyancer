//! `MemoryPlanStore` parity with `SqlitePlanStore` — the Phase-1 de-risk proof.
//!
//! Every test builds ONE canonical command script (ids are ULIDs, so replaying
//! commands twice would mint different ids and diverge) and replays the SAME
//! `UndoEntry`/`PatchBatch` inputs into both stores, asserting identical
//! observable output from `load()` and every KV/list accessor. That is the
//! bar: a non-SQLite `PlanStore` behaves indistinguishably, so `Session` is
//! genuinely decoupled from rusqlite (the wasm precondition).

use persist::{MemoryPlanStore, PlanStore, SqlitePlanStore};
use planner_core::commands::{apply, Command};
use planner_core::entities::{Id, MapPos};
use planner_core::patch::PatchBatch;
use planner_core::state::{PlanMeta, PlanState};
use planner_core::undo::{UndoEntry, UndoLog};

fn cmd_create(name: &str) -> Command {
    Command::CreateFactory {
        name: name.into(),
        position: MapPos {
            x: 1.0,
            y: 2.0,
            z: 0.0,
        },
        region: "GRASS FIELDS".into(),
    }
}

fn cmd_rename(id: &Id, name: &str) -> Command {
    Command::RenameFactory {
        id: id.clone(),
        name: name.into(),
    }
}

/// One durable operation, captured so it can be replayed byte-identically into
/// any store — mirrors exactly what `Session` hands the store.
enum Step {
    Commit {
        entry: UndoEntry,
        meta: PlanMeta,
        applied: usize,
    },
    Checkpoint {
        batch: PatchBatch,
        meta: PlanMeta,
        applied: usize,
    },
}

fn replay(store: &mut dyn PlanStore, steps: &[Step]) {
    for step in steps {
        match step {
            Step::Commit {
                entry,
                meta,
                applied,
            } => store.commit(entry, meta, *applied).unwrap(),
            Step::Checkpoint {
                batch,
                meta,
                applied,
            } => store.checkpoint(batch, meta, *applied).unwrap(),
        }
    }
}

/// The observable result of `load()`: canonical projection + journal labels +
/// cursor. Two stores fed identical steps must produce identical observations.
fn observe(store: &dyn PlanStore) -> (serde_json::Value, Vec<String>, usize) {
    let (state, entries, cursor) = store.load().unwrap();
    (
        state.project(),
        entries.iter().map(|e| e.label.clone()).collect(),
        cursor,
    )
}

/// A script that exercises commit, checkpoint (undo + redo), and — critically —
/// redo-tail truncation: create A → rename B → rename C, undo twice back to A,
/// then commit rename D, which must drop the [B, C] redo tail. Returns the
/// steps plus the factory id for content assertions.
fn truncation_script() -> (Vec<Step>, Id) {
    // Mirror Session::commit_mutation: stage, record with applied = current
    // depth + this entry, then advance the in-memory log.
    fn commit_step(
        state: &mut PlanState,
        log: &mut UndoLog,
        cmd: &Command,
        steps: &mut Vec<Step>,
    ) -> Vec<Id> {
        let tx = apply(state, cmd).unwrap();
        let created = tx.created.clone();
        let entry = UndoLog::stage(tx);
        steps.push(Step::Commit {
            entry: entry.clone(),
            meta: state.meta.clone(),
            applied: log.entries().len() + 1,
        });
        log.push(entry);
        created
    }

    let mut state = PlanState::default();
    let mut log = UndoLog::new();
    let mut steps = Vec::new();

    let fid = commit_step(&mut state, &mut log, &cmd_create("A"), &mut steps)[0].clone();
    commit_step(&mut state, &mut log, &cmd_rename(&fid, "B"), &mut steps);
    commit_step(&mut state, &mut log, &cmd_rename(&fid, "C"), &mut steps);

    // Undo twice: checkpoint with the post-undo applied depth (Session's
    // `applied_count()` == `undo.entries().len()`).
    for _ in 0..2 {
        let batch = log.undo(&mut state).unwrap().unwrap();
        steps.push(Step::Checkpoint {
            batch,
            meta: state.meta.clone(),
            applied: log.entries().len(),
        });
    }

    // Commit a new edit off the rewound cursor — truncates the [B, C] tail.
    commit_step(&mut state, &mut log, &cmd_rename(&fid, "D"), &mut steps);

    (steps, fid)
}

#[test]
fn commit_checkpoint_and_truncation_parity() {
    let (steps, fid) = truncation_script();

    let mut sqlite = SqlitePlanStore::in_memory().unwrap();
    let mut memory = MemoryPlanStore::new();
    replay(&mut sqlite, &steps);
    replay(&mut memory, &steps);

    // The two stores agree on every observable: projection, journal, cursor.
    assert_eq!(
        observe(&sqlite),
        observe(&memory),
        "MemoryPlanStore must be observationally identical to SqlitePlanStore"
    );

    // And the truncation actually happened: journal is [A, D] (len 2), cursor
    // at 2 (no redo tail), and the live name is D.
    let (state, entries, cursor) = memory.load().unwrap();
    assert_eq!(entries.len(), 2, "redo tail [B, C] truncated");
    assert_eq!(cursor, 2, "cursor == depth ⇒ nothing to redo");
    assert_eq!(state.factories[&fid].name, "D");
}

#[test]
fn load_roundtrip_parity_on_fresh_store() {
    // An empty store hydrates to default state, no journal, cursor 0 — same on
    // both impls.
    let sqlite = SqlitePlanStore::in_memory().unwrap();
    let memory = MemoryPlanStore::new();
    assert_eq!(observe(&sqlite), observe(&memory));
    let (_, entries, cursor) = memory.load().unwrap();
    assert!(entries.is_empty());
    assert_eq!(cursor, 0);
}

#[test]
fn kv_accessor_parity() {
    let sqlite = SqlitePlanStore::in_memory().unwrap();
    let memory = MemoryPlanStore::new();
    let stores: [&dyn PlanStore; 2] = [&sqlite, &memory];

    // Absent keys read None on both impls.
    for s in stores {
        assert_eq!(s.view_state(), None);
        assert_eq!(s.last_import(), None);
        assert_eq!(s.unlocked(), None);
        assert_eq!(s.purchased_schematics(), None);
        assert_eq!(s.advisor_gate(), None);
    }

    // Each setter round-trips, and both impls return the same value.
    for s in stores {
        s.set_view_state("{\"zoom\":2}").unwrap();
        s.set_last_import("{\"saveName\":\"world\"}").unwrap();
        s.set_unlocked("[\"Recipe_A_C\"]").unwrap();
        s.set_purchased_schematics("[\"Schematic_3-1_C\"]").unwrap();
        s.save_advisor_gate("{\"armed\":[\"k\"]}").unwrap();
    }
    assert_eq!(sqlite.view_state(), memory.view_state());
    assert_eq!(sqlite.view_state().as_deref(), Some("{\"zoom\":2}"));
    assert_eq!(sqlite.last_import(), memory.last_import());
    assert_eq!(sqlite.unlocked(), memory.unlocked());
    assert_eq!(sqlite.purchased_schematics(), memory.purchased_schematics());
    assert_eq!(sqlite.advisor_gate(), memory.advisor_gate());

    // save_meta writes the plan_meta row that load() reads back into state.meta.
    let mut meta = PlanMeta::default();
    meta.preferences.no_trains = true;
    sqlite.save_meta(&meta).unwrap();
    memory.save_meta(&meta).unwrap();
    assert_eq!(sqlite.load().unwrap().0.meta, memory.load().unwrap().0.meta,);
    assert_eq!(sqlite.load().unwrap().0.meta, meta);
}

#[test]
fn list_accessor_parity() {
    let sqlite = SqlitePlanStore::in_memory().unwrap();
    let memory = MemoryPlanStore::new();
    let stores: [&dyn PlanStore; 2] = [&sqlite, &memory];

    let sorted = |mut v: Vec<String>| {
        v.sort();
        v
    };

    for s in stores {
        assert!(s.load_advisor_cards().unwrap().is_empty());
        assert!(s.load_mutes().unwrap().is_empty());
        s.save_advisor_card("c1", "{\"id\":\"c1\"}").unwrap();
        s.save_advisor_card("c2", "{\"id\":\"c2\"}").unwrap();
        // Upsert on the same id replaces, not appends.
        s.save_advisor_card("c1", "{\"id\":\"c1\",\"v\":2}")
            .unwrap();
        s.add_mute("rule_a", "2026-01-01T00:00:00Z").unwrap();
        s.add_mute("rule_b", "2026-01-02T00:00:00Z").unwrap();
        s.remove_mute("rule_a").unwrap();
    }

    assert_eq!(
        sorted(sqlite.load_advisor_cards().unwrap()),
        sorted(memory.load_advisor_cards().unwrap()),
    );
    assert_eq!(sqlite.load_advisor_cards().unwrap().len(), 2);
    assert_eq!(
        sorted(sqlite.load_mutes().unwrap()),
        sorted(memory.load_mutes().unwrap()),
    );
    assert_eq!(memory.load_mutes().unwrap(), vec!["rule_b".to_string()]);
}

#[test]
fn trait_object_commit_load_cycle() {
    // Pin the dyn-safe surface: drive a `Box<dyn PlanStore>` — the exact type
    // `Session` holds — through commit + load, for BOTH impls.
    let (steps, fid) = truncation_script();
    for mut store in [
        Box::new(SqlitePlanStore::in_memory().unwrap()) as Box<dyn PlanStore>,
        Box::new(MemoryPlanStore::new()) as Box<dyn PlanStore>,
    ] {
        replay(store.as_mut(), &steps);
        let (state, entries, cursor) = store.load().unwrap();
        assert_eq!(state.factories[&fid].name, "D");
        assert_eq!(entries.len(), 2);
        assert_eq!(cursor, 2);
    }
}
