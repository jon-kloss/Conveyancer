//! Command-sourced undo (SDD §4). Each committed transaction appends one
//! `(inverse_patch, forward_patch)` entry; undo applies the inverse in reverse
//! order, redo re-applies the forward. Solve-induced writes live inside the
//! same entry as the edit that caused them.

use serde::{Deserialize, Serialize};

use crate::commands::Transaction;
use crate::patch::PatchBatch;
use crate::state::PlanState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoEntry {
    pub label: String,
    pub forward: PatchBatch,
    pub inverse: PatchBatch,
}

#[derive(Debug, Default)]
pub struct UndoLog {
    entries: Vec<UndoEntry>,
    /// Number of entries currently applied (everything past this is redo tail).
    cursor: usize,
}

impl UndoLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Restore from persisted entries (all considered applied).
    pub fn hydrate(entries: Vec<UndoEntry>) -> Self {
        let cursor = entries.len();
        Self { entries, cursor }
    }

    /// Restore from persisted entries with an explicit cursor (persisted state
    /// already reflects the cursor position — entries past it are the redo tail).
    pub fn hydrate_with_cursor(entries: Vec<UndoEntry>, cursor: usize) -> Self {
        let cursor = cursor.min(entries.len());
        Self { entries, cursor }
    }

    pub fn can_undo(&self) -> bool {
        self.cursor > 0
    }

    pub fn can_redo(&self) -> bool {
        self.cursor < self.entries.len()
    }

    pub fn undo_label(&self) -> Option<&str> {
        self.cursor
            .checked_sub(1)
            .map(|i| self.entries[i].label.as_str())
    }

    pub fn entries(&self) -> &[UndoEntry] {
        &self.entries[..self.cursor]
    }

    /// Build the entry a commit WOULD append, without mutating the log.
    /// Inverse ops are stored in reverse application order, ready to apply.
    /// Callers that persist entries durably should stage first, persist, and
    /// only `push` once the entry is safely on disk.
    pub fn stage(tx: Transaction) -> UndoEntry {
        let mut inverse = tx.inverse;
        inverse.reverse();
        UndoEntry {
            label: tx.label,
            forward: tx.forward,
            inverse,
        }
    }

    /// Append a staged entry: truncate the redo tail, push, advance the cursor.
    pub fn push(&mut self, entry: UndoEntry) {
        self.entries.truncate(self.cursor);
        self.entries.push(entry);
        self.cursor = self.entries.len();
    }

    /// Commit an open transaction: truncate the redo tail and append.
    /// Equivalent to `stage` + `push`.
    pub fn commit(&mut self, tx: Transaction) -> UndoEntry {
        let entry = Self::stage(tx);
        self.push(entry.clone());
        entry
    }

    /// Apply the inverse of the newest applied entry. Returns the batch the
    /// renderer needs (already applied to canonical state).
    pub fn undo(&mut self, state: &mut PlanState) -> Option<PatchBatch> {
        if self.cursor == 0 {
            return None;
        }
        self.cursor -= 1;
        let batch = self.entries[self.cursor].inverse.clone();
        state
            .apply_batch(&batch)
            .expect("inverse patch must apply cleanly — undo log corrupt otherwise");
        Some(batch)
    }

    /// Re-apply the next redo entry.
    pub fn redo(&mut self, state: &mut PlanState) -> Option<PatchBatch> {
        if self.cursor >= self.entries.len() {
            return None;
        }
        let batch = self.entries[self.cursor].forward.clone();
        self.cursor += 1;
        state
            .apply_batch(&batch)
            .expect("forward patch must apply cleanly — undo log corrupt otherwise");
        Some(batch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{apply, Command};
    use crate::entities::*;

    fn create_factory(state: &mut PlanState, log: &mut UndoLog) -> Id {
        let tx = apply(
            state,
            &Command::CreateFactory {
                name: "NORTHERN FORGE".into(),
                position: MapPos {
                    x: 100.0,
                    y: 200.0,
                    z: 0.0,
                },
                region: "GRASS FIELDS".into(),
            },
        )
        .unwrap();
        let id = tx.created[0].clone();
        log.commit(tx);
        id
    }

    #[test]
    fn undo_redo_roundtrip() {
        let mut state = PlanState::default();
        let mut log = UndoLog::new();
        let fid = create_factory(&mut state, &mut log);
        assert!(state.factories.contains_key(&fid));

        let tx = apply(
            &mut state,
            &Command::RenameFactory {
                id: fid.clone(),
                name: "IRON WORKS".into(),
            },
        )
        .unwrap();
        log.commit(tx);
        assert_eq!(state.factories[&fid].name, "IRON WORKS");

        log.undo(&mut state).unwrap();
        assert_eq!(state.factories[&fid].name, "NORTHERN FORGE");
        log.undo(&mut state).unwrap();
        assert!(!state.factories.contains_key(&fid));
        assert!(!log.can_undo());

        log.redo(&mut state).unwrap();
        assert!(state.factories.contains_key(&fid));
        log.redo(&mut state).unwrap();
        assert_eq!(state.factories[&fid].name, "IRON WORKS");
        assert!(!log.can_redo());
    }

    #[test]
    fn stage_then_push_equals_commit() {
        // Two logs fed identical transactions: one via commit, one via
        // stage+push. Entries, cursor behavior, and undo/redo must agree.
        let mut state_a = PlanState::default();
        let mut log_a = UndoLog::new();
        let mut log_b = UndoLog::new();
        let cmd = Command::CreateFactory {
            name: "PARITY".into(),
            position: MapPos {
                x: 1.0,
                y: 2.0,
                z: 0.0,
            },
            region: "GRASS FIELDS".into(),
        };
        // One applied transaction feeds both paths (ids are fresh ULIDs, so
        // applying the command twice would never compare equal).
        let tx = apply(&mut state_a, &cmd).unwrap();
        let mut state_b = state_a.clone();
        let entry_a = log_a.commit(tx.clone());
        let entry_b = UndoLog::stage(tx);
        // Staging alone never mutates the log.
        assert!(!log_b.can_undo());
        assert_eq!(log_b.entries().len(), 0);
        log_b.push(entry_b.clone());
        assert_eq!(entry_a.label, entry_b.label);
        assert_eq!(entry_a.forward, entry_b.forward);
        assert_eq!(entry_a.inverse, entry_b.inverse);
        assert_eq!(log_a.entries().len(), log_b.entries().len());
        assert_eq!(log_a.can_undo(), log_b.can_undo());
        assert_eq!(log_a.can_redo(), log_b.can_redo());
        // Push truncates a redo tail exactly like commit does.
        log_a.undo(&mut state_a).unwrap();
        log_b.undo(&mut state_b).unwrap();
        assert!(log_a.can_redo() && log_b.can_redo());
        let cmd2 = Command::CreateFactory {
            name: "TAIL".into(),
            position: MapPos {
                x: 3.0,
                y: 4.0,
                z: 0.0,
            },
            region: "DUNE DESERT".into(),
        };
        let tx_a = apply(&mut state_a, &cmd2).unwrap();
        let tx_b = apply(&mut state_b, &cmd2).unwrap();
        log_a.commit(tx_a);
        log_b.push(UndoLog::stage(tx_b));
        assert!(!log_a.can_redo());
        assert!(!log_b.can_redo());
        assert_eq!(log_a.entries().len(), 1);
        assert_eq!(log_b.entries().len(), 1);
    }

    #[test]
    fn new_commit_truncates_redo_tail() {
        let mut state = PlanState::default();
        let mut log = UndoLog::new();
        let fid = create_factory(&mut state, &mut log);
        let tx = apply(
            &mut state,
            &Command::RenameFactory {
                id: fid.clone(),
                name: "A".into(),
            },
        )
        .unwrap();
        log.commit(tx);
        log.undo(&mut state).unwrap();
        let tx = apply(
            &mut state,
            &Command::RenameFactory {
                id: fid.clone(),
                name: "B".into(),
            },
        )
        .unwrap();
        log.commit(tx);
        assert!(!log.can_redo());
        assert_eq!(state.factories[&fid].name, "B");
    }

    #[test]
    fn cascade_delete_restores_children_on_undo() {
        let mut state = PlanState::default();
        let mut log = UndoLog::new();
        let fid = create_factory(&mut state, &mut log);
        let tx = apply(
            &mut state,
            &Command::AddGroup {
                factory: fid.clone(),
                machine: "Build_ConstructorMk1_C".into(),
                recipe: "Recipe_IronRod_C".into(),
                count: 4,
                clock: 1.0,
                graph_pos: GraphPos { x: 0.0, y: 0.0 },
                floor: 0,
            },
        )
        .unwrap();
        let gid = tx.created[0].clone();
        log.commit(tx);

        let tx = apply(&mut state, &Command::DeleteFactory { id: fid.clone() }).unwrap();
        log.commit(tx);
        assert!(state.factories.is_empty());
        assert!(state.groups.is_empty());

        log.undo(&mut state).unwrap();
        assert!(state.factories.contains_key(&fid));
        assert!(state.groups.contains_key(&gid));
        assert_eq!(state.factories[&fid].groups, vec![gid]);
    }

    fn add_power_with_switch(
        state: &mut PlanState,
        log: &mut UndoLog,
        from: &Id,
        to: &Id,
        priority: u8,
    ) -> (Id, Id) {
        let tx = apply(
            state,
            &Command::AddRoute {
                kind: RouteKind::Power,
                from: from.clone(),
                to: to.clone(),
                path: vec![],
            },
        )
        .unwrap();
        let rid = tx.created[0].clone();
        log.commit(tx);
        let tx = apply(
            state,
            &Command::AddPrioritySwitch {
                route: rid.clone(),
                priority,
            },
        )
        .unwrap();
        let sid = tx.created[0].clone();
        log.commit(tx);
        (rid, sid)
    }

    #[test]
    fn cascade_delete_removes_priority_switches_and_undo_restores_them() {
        let mut state = PlanState::default();
        let mut log = UndoLog::new();
        let a = create_factory(&mut state, &mut log);
        let b = create_factory(&mut state, &mut log);
        let c = create_factory(&mut state, &mut log);
        let (route_ab, switch_ab) = add_power_with_switch(&mut state, &mut log, &a, &b, 3);
        let (route_bc, switch_bc) = add_power_with_switch(&mut state, &mut log, &b, &c, 7);

        let tx = apply(&mut state, &Command::DeleteFactory { id: a.clone() }).unwrap();
        log.commit(tx);
        // A's line goes, and the switch riding it goes with it — no dangling
        // PrioritySwitch.route. The B—C control pair survives untouched.
        assert!(!state.factories.contains_key(&a));
        assert!(!state.routes.contains_key(&route_ab));
        assert!(!state.switches.contains_key(&switch_ab));
        assert!(state.routes.contains_key(&route_bc));
        assert!(state.switches.contains_key(&switch_bc));

        // One undo restores factory, route, and switch with identity intact.
        log.undo(&mut state).unwrap();
        assert!(state.factories.contains_key(&a));
        assert!(state.routes.contains_key(&route_ab));
        let sw = &state.switches[&switch_ab];
        assert_eq!(sw.route, route_ab);
        assert_eq!(sw.priority, 3);

        // Redo removes all three again, still sparing the control pair.
        log.redo(&mut state).unwrap();
        assert!(!state.factories.contains_key(&a));
        assert!(!state.routes.contains_key(&route_ab));
        assert!(!state.switches.contains_key(&switch_ab));
        assert!(state.switches.contains_key(&switch_bc));
    }

    #[test]
    fn built_entities_are_immutable() {
        let mut state = PlanState::default();
        let mut log = UndoLog::new();
        let fid = create_factory(&mut state, &mut log);
        state.factories.get_mut(&fid).unwrap().status = Status::Built;
        let err = apply(
            &mut state,
            &Command::MoveFactoryPin {
                id: fid.clone(),
                position: MapPos {
                    x: 0.0,
                    y: 0.0,
                    z: 0.0,
                },
            },
        );
        assert!(matches!(
            err,
            Err(crate::commands::DomainError::BuiltImmutable { .. })
        ));
        let err = apply(&mut state, &Command::DeleteFactory { id: fid });
        assert!(matches!(
            err,
            Err(crate::commands::DomainError::BuiltImmutable { .. })
        ));
    }

    fn add_built_group(state: &mut PlanState, log: &mut UndoLog, fid: &Id) -> Id {
        let tx = apply(
            state,
            &Command::AddGroup {
                factory: fid.clone(),
                machine: "Build_SmelterMk1_C".into(),
                recipe: "Recipe_IngotIron_C".into(),
                count: 4,
                clock: 1.0,
                graph_pos: GraphPos { x: 0.0, y: 0.0 },
                floor: 0,
            },
        )
        .unwrap();
        let gid = tx.created[0].clone();
        log.commit(tx);
        state.groups.get_mut(&gid).unwrap().status = Status::Built;
        gid
    }

    #[test]
    fn built_group_edits_materialize_planned_delta() {
        let mut state = PlanState::default();
        let mut log = UndoLog::new();
        let fid = create_factory(&mut state, &mut log);
        let gid = add_built_group(&mut state, &mut log, &fid);

        // Count edit lands as a ◇ delta; the ◆ baseline is untouched.
        let tx = apply(
            &mut state,
            &Command::SetGroupCount {
                id: gid.clone(),
                count: 6,
            },
        )
        .unwrap();
        log.commit(tx);
        let g = &state.groups[&gid];
        assert_eq!(g.count, 4, "baseline is game ground truth");
        assert_eq!(
            g.planned_delta,
            Some(GroupDelta {
                count: Some(6),
                clock: None,
            })
        );
        assert_eq!(g.effective_count(), 6);
        assert!((g.effective_clock() - 1.0).abs() < 1e-9);

        // Clock edit merges into the same overlay.
        let tx = apply(
            &mut state,
            &Command::SetGroupClock {
                id: gid.clone(),
                clock: 1.5,
            },
        )
        .unwrap();
        log.commit(tx);
        let g = &state.groups[&gid];
        assert!((g.clock - 1.0).abs() < 1e-9);
        assert_eq!(
            g.planned_delta,
            Some(GroupDelta {
                count: Some(6),
                clock: Some(1.5),
            })
        );

        // Each edit is one undoable step; undoing both restores None.
        log.undo(&mut state).unwrap();
        assert_eq!(
            state.groups[&gid].planned_delta,
            Some(GroupDelta {
                count: Some(6),
                clock: None,
            })
        );
        log.undo(&mut state).unwrap();
        assert_eq!(state.groups[&gid].planned_delta, None);
        assert_eq!(state.groups[&gid].count, 4);
        log.redo(&mut state).unwrap();
        assert_eq!(
            state.groups[&gid].planned_delta,
            Some(GroupDelta {
                count: Some(6),
                clock: None,
            })
        );
    }

    #[test]
    fn setting_built_values_back_clears_the_delta() {
        let mut state = PlanState::default();
        let mut log = UndoLog::new();
        let fid = create_factory(&mut state, &mut log);
        let gid = add_built_group(&mut state, &mut log, &fid);

        for cmd in [
            Command::SetGroupCount {
                id: gid.clone(),
                count: 6,
            },
            Command::SetGroupClock {
                id: gid.clone(),
                clock: 1.5,
            },
            // typing the built values back in abandons the plan
            Command::SetGroupClock {
                id: gid.clone(),
                clock: 1.0,
            },
            Command::SetGroupCount {
                id: gid.clone(),
                count: 4,
            },
        ] {
            let tx = apply(&mut state, &cmd).unwrap();
            log.commit(tx);
        }
        assert_eq!(state.groups[&gid].planned_delta, None, "delta dissolved");
        assert_eq!(state.groups[&gid].count, 4);
        assert!((state.groups[&gid].clock - 1.0).abs() < 1e-9);
    }

    #[test]
    fn recipe_floor_and_delete_still_rejected_on_built_groups() {
        let mut state = PlanState::default();
        let mut log = UndoLog::new();
        let fid = create_factory(&mut state, &mut log);
        let gid = add_built_group(&mut state, &mut log, &fid);

        for cmd in [
            Command::SetGroupRecipe {
                id: gid.clone(),
                machine: "Build_FoundryMk1_C".into(),
                recipe: "Recipe_IngotSteel_C".into(),
            },
            Command::SetGroupFloor {
                id: gid.clone(),
                floor: 1,
            },
            Command::DeleteGroup { id: gid.clone() },
        ] {
            let err = apply(&mut state, &cmd);
            assert!(
                matches!(
                    err,
                    Err(crate::commands::DomainError::BuiltImmutable { .. })
                ),
                "{cmd:?} must stay rejected on ◆"
            );
        }
        assert!(state.groups.contains_key(&gid));
    }

    #[test]
    fn projection_matches_patch_application() {
        // Renderer invariant: hydrate-then-patch equals re-hydrate.
        let mut state = PlanState::default();
        let mut log = UndoLog::new();
        let mut projected = state.project();
        let tx = apply(
            &mut state,
            &Command::CreateFactory {
                name: "X".into(),
                position: MapPos {
                    x: 1.0,
                    y: 2.0,
                    z: 0.0,
                },
                region: "DUNE DESERT".into(),
            },
        )
        .unwrap();
        let entry = log.commit(tx);
        crate::patch::apply(&mut projected, &entry.forward).unwrap();
        assert_eq!(projected, state.project());
        let batch = log.undo(&mut state).unwrap();
        crate::patch::apply(&mut projected, &batch).unwrap();
        assert_eq!(projected, state.project());
    }
}
