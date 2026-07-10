//! The command layer — every mutation flows through here (SDD §4 `plan.edit(op)`).
//! Commands validate invariants (§3.1), mutate canonical state, and record
//! forward/inverse ops into a `Transaction`. Solve-induced writes are recorded
//! into the *same* transaction by the app layer before commit, so ⌘Z undoes the
//! edit and its solve together.

use serde::{Deserialize, Serialize};

use crate::entities::*;
use crate::patch::{PatchBatch, PatchOp};
use crate::state::*;

#[derive(Debug, thiserror::Error, Serialize, Deserialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum DomainError {
    #[error("entity not found: {id}")]
    NotFound { id: Id },
    #[error("built entities are immutable: {id} ({action})")]
    BuiltImmutable { id: Id, action: String },
    #[error("invalid value: {message}")]
    Invalid { message: String },
}

/// An open transaction: ops applied to canonical state but not yet committed
/// to the undo log. The app layer may append solve results before committing.
#[derive(Debug, Clone, Default)]
pub struct Transaction {
    pub label: String,
    pub forward: PatchBatch,
    pub inverse: PatchBatch,
    /// Ids created by this transaction, in creation order (renderer selects them).
    pub created: Vec<Id>,
}

impl Transaction {
    pub fn new(label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            ..Default::default()
        }
    }

    pub fn record(&mut self, (forward, inverse): (PatchOp, PatchOp)) {
        self.forward.push(forward);
        // Inverse ops must apply in reverse order; store reversed at commit time.
        self.inverse.push(inverse);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    CreateFactory {
        name: String,
        position: MapPos,
        region: String,
    },
    RenameFactory {
        id: Id,
        name: String,
    },
    MoveFactoryPin {
        id: Id,
        position: MapPos,
    },
    DeleteFactory {
        id: Id,
    },
    AddGroup {
        factory: Id,
        machine: String,
        recipe: String,
        count: u32,
        clock: f64,
        graph_pos: GraphPos,
        #[serde(default)]
        floor: u32,
    },
    SetGroupRecipe {
        id: Id,
        machine: String,
        recipe: String,
    },
    SetGroupCount {
        id: Id,
        count: u32,
    },
    SetGroupClock {
        id: Id,
        clock: f64,
    },
    SetGroupFloor {
        id: Id,
        floor: u32,
    },
    MoveGroupCard {
        id: Id,
        graph_pos: GraphPos,
    },
    DeleteGroup {
        id: Id,
    },
    AddPort {
        factory: Id,
        direction: PortDirection,
        item: String,
        rate: f64,
        rate_ceiling: Option<f64>,
        graph_pos: GraphPos,
    },
    SetPortRate {
        id: Id,
        rate: f64,
    },
    SetPortCeiling {
        id: Id,
        rate_ceiling: Option<f64>,
    },
    MovePortCard {
        id: Id,
        graph_pos: GraphPos,
    },
    DeletePort {
        id: Id,
    },
    AddEdge {
        factory: Id,
        from: EdgeEnd,
        to: EdgeEnd,
        item: String,
        tier: u8,
    },
    AddJunction {
        factory: Id,
        kind: JunctionKind,
        graph_pos: GraphPos,
        #[serde(default)]
        floor: u32,
    },
    MoveJunctionCard {
        id: Id,
        graph_pos: GraphPos,
    },
    SetJunctionFloor {
        id: Id,
        floor: u32,
    },
    DeleteJunction {
        id: Id,
    },
    /// Bind an Out port of one factory to an In port of another with a map
    /// route. Phase 2 kinds: Belt (items) and Power (endpoints are factories).
    AddRoute {
        kind: RouteKind,
        from: Id,
        to: Id,
        path: Vec<MapPos>,
    },
    SetRouteTier {
        id: Id,
        tier: u8,
    },
    DeleteRoute {
        id: Id,
    },
    SetEdgeTier {
        id: Id,
        tier: u8,
    },
    DeleteEdge {
        id: Id,
    },
    ClaimNode {
        factory: Id,
        node: String,
        extractor: String,
        clock: f64,
    },
    ReleaseNode {
        id: Id,
    },
    RenamePlan {
        name: String,
    },
}

impl Command {
    pub fn label(&self) -> &'static str {
        match self {
            Command::CreateFactory { .. } => "create factory",
            Command::RenameFactory { .. } => "rename factory",
            Command::MoveFactoryPin { .. } => "move factory",
            Command::DeleteFactory { .. } => "delete factory",
            Command::AddGroup { .. } => "add machine group",
            Command::SetGroupRecipe { .. } => "set recipe",
            Command::SetGroupCount { .. } => "set count",
            Command::SetGroupClock { .. } => "set clock",
            Command::SetGroupFloor { .. } => "set floor",
            Command::MoveGroupCard { .. } => "move card",
            Command::DeleteGroup { .. } => "delete group",
            Command::AddPort { .. } => "add port",
            Command::SetPortRate { .. } => "set target rate",
            Command::SetPortCeiling { .. } => "set input ceiling",
            Command::MovePortCard { .. } => "move port",
            Command::DeletePort { .. } => "delete port",
            Command::AddEdge { .. } => "connect belt",
            Command::AddJunction { .. } => "add junction",
            Command::MoveJunctionCard { .. } => "move junction",
            Command::SetJunctionFloor { .. } => "set junction floor",
            Command::DeleteJunction { .. } => "delete junction",
            Command::AddRoute { .. } => "draw route",
            Command::SetRouteTier { .. } => "set route tier",
            Command::DeleteRoute { .. } => "delete route",
            Command::SetEdgeTier { .. } => "set belt tier",
            Command::DeleteEdge { .. } => "delete belt",
            Command::ClaimNode { .. } => "claim node",
            Command::ReleaseNode { .. } => "release node",
            Command::RenamePlan { .. } => "rename plan",
        }
    }
}

fn require_planned(status: Status, id: &Id, action: &str) -> Result<(), DomainError> {
    // Phase 1 creates Planned entities only; Built immutability (§3.1.1) is
    // enforced now so it can never regress when import lands.
    if status == Status::Built {
        return Err(DomainError::BuiltImmutable {
            id: id.clone(),
            action: action.into(),
        });
    }
    Ok(())
}

fn clamp_clock(clock: f64) -> Result<f64, DomainError> {
    if !(0.01..=2.5).contains(&clock) {
        return Err(DomainError::Invalid {
            message: format!("clock {clock} outside 1%–250%"),
        });
    }
    Ok(clock)
}

fn valid_tier(tier: u8) -> Result<u8, DomainError> {
    if !(1..=6).contains(&tier) {
        return Err(DomainError::Invalid {
            message: format!("belt tier {tier} outside Mk.1–Mk.6"),
        });
    }
    Ok(tier)
}

/// Apply a command to canonical state. Returns an open `Transaction`.
pub fn apply(state: &mut PlanState, cmd: &Command) -> Result<Transaction, DomainError> {
    let mut tx = Transaction::new(cmd.label());
    match cmd {
        Command::CreateFactory {
            name,
            position,
            region,
        } => {
            let f = Factory {
                id: new_id(),
                name: name.clone(),
                position: *position,
                region: region.clone(),
                node_claims: vec![],
                groups: vec![],
                ports: vec![],
                style_guide: None,
                status: Status::Planned,
                created_by: CreatedBy::Manual,
            };
            tx.created.push(f.id.clone());
            tx.record(state.upsert(Entity::Factory(f)));
        }
        Command::RenameFactory { id, name } => {
            let mut f = state
                .factories
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            f.name = name.clone();
            tx.record(state.upsert(Entity::Factory(f)));
        }
        Command::MoveFactoryPin { id, position } => {
            let mut f = state
                .factories
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            // Built pins are locked (UI offers "plan a move" — later phase).
            require_planned(f.status, id, "move")?;
            f.position = *position;
            tx.record(state.upsert(Entity::Factory(f)));
            // Route paths store endpoint positions — refresh the waypoint that
            // sits on this factory (belt endpoints are its ports; power lines
            // reference the factory directly) so lines and 3D lengths track
            // pin moves and elevation edits.
            let routes: Vec<Route> = state.routes.values().cloned().collect();
            for mut r in routes {
                let owns = |end: &Id| {
                    end == id
                        || state
                            .ports
                            .get(end)
                            .map(|p| &p.factory == id)
                            .unwrap_or(false)
                };
                let mut touched = false;
                if owns(&r.endpoints.0) && !r.path.is_empty() {
                    r.path[0] = *position;
                    touched = true;
                }
                if owns(&r.endpoints.1) && !r.path.is_empty() {
                    let last = r.path.len() - 1;
                    r.path[last] = *position;
                    touched = true;
                }
                if touched {
                    tx.record(state.upsert(Entity::Route(r)));
                }
            }
        }
        Command::DeleteFactory { id } => {
            let f = state
                .factories
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            require_planned(f.status, id, "delete")?;
            // Cascade: groups, ports, edges, claims belonging to this factory.
            let group_ids: Vec<Id> = state
                .groups
                .values()
                .filter(|g| &g.factory == id)
                .map(|g| g.id.clone())
                .collect();
            let port_ids: Vec<Id> = state
                .ports
                .values()
                .filter(|p| &p.factory == id)
                .map(|p| p.id.clone())
                .collect();
            let edge_ids: Vec<Id> = state
                .edges
                .values()
                .filter(|e| &e.factory == id)
                .map(|e| e.id.clone())
                .collect();
            let claim_ids: Vec<Id> = state
                .node_claims
                .values()
                .filter(|c| &c.factory == id)
                .map(|c| c.id.clone())
                .collect();
            let junction_ids: Vec<Id> = state
                .junctions
                .values()
                .filter(|j| &j.factory == id)
                .map(|j| j.id.clone())
                .collect();
            let port_set: std::collections::BTreeSet<Id> = port_ids.iter().cloned().collect();
            let route_ids: Vec<Id> = state
                .routes
                .values()
                .filter(|r| {
                    port_set.contains(&r.endpoints.0)
                        || port_set.contains(&r.endpoints.1)
                        || r.endpoints.0 == *id
                        || r.endpoints.1 == *id
                })
                .map(|r| r.id.clone())
                .collect();
            for rid in route_ids {
                if let Some(r) = state.routes.get(&rid).cloned() {
                    // unbind the far port so it doesn't dangle
                    for pid in [&r.endpoints.0, &r.endpoints.1] {
                        if let Some(mut p) = state.ports.get(pid).cloned() {
                            if p.bound_route.as_deref() == Some(rid.as_str()) {
                                p.bound_route = None;
                                tx.record(state.upsert(Entity::Port(p)));
                            }
                        }
                    }
                }
                if let Some(ops) = state.remove(COLL_ROUTES, &rid) {
                    tx.record(ops);
                }
            }
            for eid in edge_ids {
                if let Some(ops) = state.remove(COLL_EDGES, &eid) {
                    tx.record(ops);
                }
            }
            for gid in group_ids {
                if let Some(ops) = state.remove(COLL_GROUPS, &gid) {
                    tx.record(ops);
                }
            }
            for pid in port_ids {
                if let Some(ops) = state.remove(COLL_PORTS, &pid) {
                    tx.record(ops);
                }
            }
            for cid in claim_ids {
                if let Some(ops) = state.remove(COLL_NODE_CLAIMS, &cid) {
                    tx.record(ops);
                }
            }
            for jid in junction_ids {
                if let Some(ops) = state.remove(COLL_JUNCTIONS, &jid) {
                    tx.record(ops);
                }
            }
            if let Some(ops) = state.remove(COLL_FACTORIES, id) {
                tx.record(ops);
            }
        }
        Command::AddGroup {
            factory,
            machine,
            recipe,
            count,
            clock,
            graph_pos,
            floor,
        } => {
            let mut f = state
                .factories
                .get(factory)
                .cloned()
                .ok_or(DomainError::NotFound {
                    id: factory.clone(),
                })?;
            let g = MachineGroup {
                id: new_id(),
                factory: factory.clone(),
                machine: machine.clone(),
                recipe: recipe.clone(),
                count: (*count).max(1),
                clock: clamp_clock(*clock)?,
                somersloops: 0,
                planned_delta: None,
                graph_pos: *graph_pos,
                floor: *floor,
                status: Status::Planned,
                created_by: CreatedBy::Manual,
            };
            tx.created.push(g.id.clone());
            f.groups.push(g.id.clone());
            tx.record(state.upsert(Entity::Group(g)));
            tx.record(state.upsert(Entity::Factory(f)));
        }
        Command::SetGroupRecipe {
            id,
            machine,
            recipe,
        } => {
            let mut g = state
                .groups
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            require_planned(g.status, id, "set recipe")?;
            g.machine = machine.clone();
            g.recipe = recipe.clone();
            tx.record(state.upsert(Entity::Group(g)));
        }
        Command::SetGroupCount { id, count } => {
            let mut g = state
                .groups
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            require_planned(g.status, id, "set count")?;
            g.count = (*count).max(1);
            tx.record(state.upsert(Entity::Group(g)));
        }
        Command::SetGroupClock { id, clock } => {
            let mut g = state
                .groups
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            require_planned(g.status, id, "set clock")?;
            g.clock = clamp_clock(*clock)?;
            tx.record(state.upsert(Entity::Group(g)));
        }
        Command::SetGroupFloor { id, floor } => {
            let mut g = state
                .groups
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            require_planned(g.status, id, "set floor")?;
            g.floor = *floor;
            tx.record(state.upsert(Entity::Group(g)));
        }
        Command::MoveGroupCard { id, graph_pos } => {
            let mut g = state
                .groups
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            g.graph_pos = *graph_pos;
            tx.record(state.upsert(Entity::Group(g)));
        }
        Command::DeleteGroup { id } => {
            let g = state
                .groups
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            require_planned(g.status, id, "delete")?;
            let edge_ids: Vec<Id> = state
                .edges
                .values()
                .filter(|e| {
                    e.from == EdgeEnd::Group(id.clone()) || e.to == EdgeEnd::Group(id.clone())
                })
                .map(|e| e.id.clone())
                .collect();
            for eid in edge_ids {
                if let Some(ops) = state.remove(COLL_EDGES, &eid) {
                    tx.record(ops);
                }
            }
            if let Some(mut f) = state.factories.get(&g.factory).cloned() {
                f.groups.retain(|gid| gid != id);
                tx.record(state.upsert(Entity::Factory(f)));
            }
            if let Some(ops) = state.remove(COLL_GROUPS, id) {
                tx.record(ops);
            }
        }
        Command::AddPort {
            factory,
            direction,
            item,
            rate,
            rate_ceiling,
            graph_pos,
        } => {
            let mut f = state
                .factories
                .get(factory)
                .cloned()
                .ok_or(DomainError::NotFound {
                    id: factory.clone(),
                })?;
            let p = Port {
                id: new_id(),
                factory: factory.clone(),
                direction: *direction,
                item: item.clone(),
                rate: rate.max(0.0),
                rate_ceiling: *rate_ceiling,
                bound_route: None,
                graph_pos: *graph_pos,
                status: Status::Planned,
                created_by: CreatedBy::Manual,
            };
            tx.created.push(p.id.clone());
            f.ports.push(p.id.clone());
            tx.record(state.upsert(Entity::Port(p)));
            tx.record(state.upsert(Entity::Factory(f)));
        }
        Command::SetPortRate { id, rate } => {
            let mut p = state
                .ports
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            if *rate < 0.0 {
                return Err(DomainError::Invalid {
                    message: "rate must be ≥ 0".into(),
                });
            }
            p.rate = *rate;
            tx.record(state.upsert(Entity::Port(p)));
        }
        Command::SetPortCeiling { id, rate_ceiling } => {
            let mut p = state
                .ports
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            p.rate_ceiling = *rate_ceiling;
            tx.record(state.upsert(Entity::Port(p)));
        }
        Command::MovePortCard { id, graph_pos } => {
            let mut p = state
                .ports
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            p.graph_pos = *graph_pos;
            tx.record(state.upsert(Entity::Port(p)));
        }
        Command::DeletePort { id } => {
            let p = state
                .ports
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            require_planned(p.status, id, "delete")?;
            if let Some(rid) = p.bound_route.clone() {
                if let Some(r) = state.routes.get(&rid).cloned() {
                    for pid in [&r.endpoints.0, &r.endpoints.1] {
                        if pid != id {
                            if let Some(mut far) = state.ports.get(pid).cloned() {
                                far.bound_route = None;
                                tx.record(state.upsert(Entity::Port(far)));
                            }
                        }
                    }
                }
                if let Some(ops) = state.remove(COLL_ROUTES, &rid) {
                    tx.record(ops);
                }
            }
            let edge_ids: Vec<Id> = state
                .edges
                .values()
                .filter(|e| {
                    e.from == EdgeEnd::Port(id.clone()) || e.to == EdgeEnd::Port(id.clone())
                })
                .map(|e| e.id.clone())
                .collect();
            for eid in edge_ids {
                if let Some(ops) = state.remove(COLL_EDGES, &eid) {
                    tx.record(ops);
                }
            }
            if let Some(mut f) = state.factories.get(&p.factory).cloned() {
                f.ports.retain(|pid| pid != id);
                tx.record(state.upsert(Entity::Factory(f)));
            }
            if let Some(ops) = state.remove(COLL_PORTS, id) {
                tx.record(ops);
            }
        }
        Command::AddEdge {
            factory,
            from,
            to,
            item,
            tier,
        } => {
            state.factories.get(factory).ok_or(DomainError::NotFound {
                id: factory.clone(),
            })?;
            // Junction port budgets are physical game constraints (splitter
            // 1-in/3-out, merger 3-in/1-out, storage 1/1) — refuse overflow.
            for (end, incoming) in [(from, false), (to, true)] {
                if let EdgeEnd::Junction(jid) = end {
                    let j = state
                        .junctions
                        .get(jid)
                        .ok_or(DomainError::NotFound { id: jid.clone() })?;
                    let (in_cap, out_cap) = j.kind.port_caps();
                    let used = state
                        .edges
                        .values()
                        .filter(|e| {
                            if incoming {
                                e.to == EdgeEnd::Junction(jid.clone())
                            } else {
                                e.from == EdgeEnd::Junction(jid.clone())
                            }
                        })
                        .count();
                    let cap = if incoming { in_cap } else { out_cap };
                    if used >= cap {
                        return Err(DomainError::Invalid {
                            message: format!(
                                "{:?} has all {} {} ports connected",
                                j.kind,
                                cap,
                                if incoming { "input" } else { "output" }
                            ),
                        });
                    }
                    // A standard splitter/merger/storage carries one item type;
                    // smart/programmable splitters may filter per output.
                    if !matches!(
                        j.kind,
                        JunctionKind::SmartSplitter | JunctionKind::ProgrammableSplitter
                    ) {
                        if let Some(other) = state.edges.values().find(|e| {
                            e.from == EdgeEnd::Junction(jid.clone())
                                || e.to == EdgeEnd::Junction(jid.clone())
                        }) {
                            if &other.item != item {
                                return Err(DomainError::Invalid {
                                    message: format!(
                                        "{:?} already carries a different item",
                                        j.kind
                                    ),
                                });
                            }
                        }
                    }
                }
            }
            let e = BeltEdge {
                id: new_id(),
                factory: factory.clone(),
                from: from.clone(),
                to: to.clone(),
                item: item.clone(),
                tier: valid_tier(*tier)?,
                status: Status::Planned,
                created_by: CreatedBy::Manual,
            };
            tx.created.push(e.id.clone());
            tx.record(state.upsert(Entity::Edge(e)));
        }
        Command::SetEdgeTier { id, tier } => {
            let mut e = state
                .edges
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            e.tier = valid_tier(*tier)?;
            tx.record(state.upsert(Entity::Edge(e)));
        }
        Command::DeleteEdge { id } => {
            let e = state
                .edges
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            require_planned(e.status, id, "delete")?;
            if let Some(ops) = state.remove(COLL_EDGES, id) {
                tx.record(ops);
            }
        }
        Command::AddJunction {
            factory,
            kind,
            graph_pos,
            floor,
        } => {
            state.factories.get(factory).ok_or(DomainError::NotFound {
                id: factory.clone(),
            })?;
            let j = Junction {
                id: new_id(),
                factory: factory.clone(),
                kind: *kind,
                buildable: kind.buildable_class().to_string(),
                graph_pos: *graph_pos,
                floor: *floor,
                status: Status::Planned,
                created_by: CreatedBy::Manual,
            };
            tx.created.push(j.id.clone());
            tx.record(state.upsert(Entity::Junction(j)));
        }
        Command::MoveJunctionCard { id, graph_pos } => {
            let mut j = state
                .junctions
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            j.graph_pos = *graph_pos;
            tx.record(state.upsert(Entity::Junction(j)));
        }
        Command::SetJunctionFloor { id, floor } => {
            let mut j = state
                .junctions
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            require_planned(j.status, id, "set floor")?;
            j.floor = *floor;
            tx.record(state.upsert(Entity::Junction(j)));
        }
        Command::DeleteJunction { id } => {
            let j = state
                .junctions
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            require_planned(j.status, id, "delete")?;
            let edge_ids: Vec<Id> = state
                .edges
                .values()
                .filter(|e| {
                    e.from == EdgeEnd::Junction(id.clone()) || e.to == EdgeEnd::Junction(id.clone())
                })
                .map(|e| e.id.clone())
                .collect();
            for eid in edge_ids {
                if let Some(ops) = state.remove(COLL_EDGES, &eid) {
                    tx.record(ops);
                }
            }
            if let Some(ops) = state.remove(COLL_JUNCTIONS, id) {
                tx.record(ops);
            }
        }
        Command::AddRoute {
            kind,
            from,
            to,
            path,
        } => {
            match kind {
                RouteKind::Power => {
                    // power lines join factories; endpoints are factory ids
                    for fid in [from, to] {
                        state
                            .factories
                            .get(fid)
                            .ok_or(DomainError::NotFound { id: fid.clone() })?;
                    }
                    if from == to {
                        return Err(DomainError::Invalid {
                            message: "a power line needs two different factories".into(),
                        });
                    }
                    if state.routes.values().any(|r| {
                        matches!(r.kind, RouteKind::Power)
                            && ((r.endpoints.0 == *from && r.endpoints.1 == *to)
                                || (r.endpoints.0 == *to && r.endpoints.1 == *from))
                    }) {
                        return Err(DomainError::Invalid {
                            message: "these factories are already connected".into(),
                        });
                    }
                    let r = Route {
                        id: new_id(),
                        kind: kind.clone(),
                        path: path.clone(),
                        endpoints: (from.clone(), to.clone()),
                        manifest: vec![],
                        status: Status::Planned,
                        created_by: CreatedBy::Manual,
                    };
                    tx.created.push(r.id.clone());
                    tx.record(state.upsert(Entity::Route(r)));
                }
                RouteKind::Belt { tier } => {
                    valid_tier(*tier)?;
                    let src = state
                        .ports
                        .get(from)
                        .cloned()
                        .ok_or(DomainError::NotFound { id: from.clone() })?;
                    let dst = state
                        .ports
                        .get(to)
                        .cloned()
                        .ok_or(DomainError::NotFound { id: to.clone() })?;
                    if src.direction != PortDirection::Out || dst.direction != PortDirection::In {
                        return Err(DomainError::Invalid {
                            message: "belt routes run from an OUT port to an IN port".into(),
                        });
                    }
                    if src.item != dst.item {
                        return Err(DomainError::Invalid {
                            message: "the ports carry different items".into(),
                        });
                    }
                    if src.bound_route.is_some() || dst.bound_route.is_some() {
                        return Err(DomainError::Invalid {
                            message: "a port is already bound to a route".into(),
                        });
                    }
                    let r = Route {
                        id: new_id(),
                        kind: kind.clone(),
                        path: path.clone(),
                        endpoints: (from.clone(), to.clone()),
                        manifest: vec![(src.item.clone(), 0.0)],
                        status: Status::Planned,
                        created_by: CreatedBy::Manual,
                    };
                    tx.created.push(r.id.clone());
                    let mut src = src;
                    let mut dst = dst;
                    src.bound_route = Some(r.id.clone());
                    dst.bound_route = Some(r.id.clone());
                    tx.record(state.upsert(Entity::Route(r)));
                    tx.record(state.upsert(Entity::Port(src)));
                    tx.record(state.upsert(Entity::Port(dst)));
                }
                other => {
                    return Err(DomainError::Invalid {
                        message: format!("{other:?} routes arrive in a later phase"),
                    });
                }
            }
        }
        Command::SetRouteTier { id, tier } => {
            let mut r = state
                .routes
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            match &mut r.kind {
                RouteKind::Belt { tier: t } => *t = valid_tier(*tier)?,
                other => {
                    return Err(DomainError::Invalid {
                        message: format!("{other:?} routes have no belt tier"),
                    });
                }
            }
            tx.record(state.upsert(Entity::Route(r)));
        }
        Command::DeleteRoute { id } => {
            let r = state
                .routes
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            require_planned(r.status, id, "delete")?;
            // unbind ports on belt routes
            if matches!(r.kind, RouteKind::Belt { .. }) {
                for pid in [&r.endpoints.0, &r.endpoints.1] {
                    if let Some(mut p) = state.ports.get(pid).cloned() {
                        if p.bound_route.as_deref() == Some(id.as_str()) {
                            p.bound_route = None;
                            tx.record(state.upsert(Entity::Port(p)));
                        }
                    }
                }
            }
            if let Some(ops) = state.remove(COLL_ROUTES, id) {
                tx.record(ops);
            }
        }
        Command::ClaimNode {
            factory,
            node,
            extractor,
            clock,
        } => {
            let mut f = state
                .factories
                .get(factory)
                .cloned()
                .ok_or(DomainError::NotFound {
                    id: factory.clone(),
                })?;
            // Note §3.1.3: conflicting claims are representable, never prevented.
            let c = NodeClaim {
                id: new_id(),
                node: node.clone(),
                factory: factory.clone(),
                extractor: extractor.clone(),
                clock: clamp_clock(*clock)?,
                status: Status::Planned,
                created_by: CreatedBy::Manual,
            };
            tx.created.push(c.id.clone());
            f.node_claims.push(c.id.clone());
            tx.record(state.upsert(Entity::NodeClaim(c)));
            tx.record(state.upsert(Entity::Factory(f)));
        }
        Command::ReleaseNode { id } => {
            let c = state
                .node_claims
                .get(id)
                .cloned()
                .ok_or(DomainError::NotFound { id: id.clone() })?;
            if let Some(mut f) = state.factories.get(&c.factory).cloned() {
                f.node_claims.retain(|cid| cid != id);
                tx.record(state.upsert(Entity::Factory(f)));
            }
            if let Some(ops) = state.remove(COLL_NODE_CLAIMS, id) {
                tx.record(ops);
            }
        }
        Command::RenamePlan { name } => {
            let old = state.meta.name.clone();
            state.meta.name = name.clone();
            tx.forward.push(PatchOp::Replace {
                path: "/meta/name".into(),
                value: serde_json::json!(name),
            });
            tx.inverse.push(PatchOp::Replace {
                path: "/meta/name".into(),
                value: serde_json::json!(old),
            });
        }
    }
    Ok(tx)
}
