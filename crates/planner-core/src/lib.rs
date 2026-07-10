//! planner-core — domain model, canonical state, command layer, undo log.
//! Rust owns canonical state (SDD §4); the renderer is a projection patched by events.

pub mod entities;
pub mod patch;
pub mod state;
pub mod commands;
pub mod undo;

pub use entities::*;
pub use patch::{PatchBatch, PatchOp};
pub use state::PlanState;
