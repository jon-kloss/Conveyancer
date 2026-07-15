//! web — the wasm-bindgen wrapper that runs the FICSIT Planner `Session` in a
//! browser (Phase 2 de-risk: PROVE the core compiles AND runs on
//! `wasm32-unknown-unknown`). It mirrors `solver-wasm`'s proven template
//! (cdylib + serde-wasm-bindgen marshaling, `wasm-opt = false`).
//!
//! Scope is deliberately small — enough of the round-trip (`hydrate` / `edit`
//! / `next_moves`) to prove `Session` genuinely runs in wasm over a
//! `MemoryPlanStore`, NOT the full renderer Backend. IndexedDB persistence is
//! Phase 3 and AI-over-`fetch` is Phase 4; here the store is in-memory and the
//! provider call is the heuristic fallback (`native-http` is off in this
//! build).

use app::Session;
use persist::MemoryPlanStore;
use planner_core::commands::Command;
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Serialize any `Serialize` value across the wasm boundary the way the
/// renderer expects: `json_compatible` so `BTreeMap`s become plain objects
/// (matching the TS `Record` types), not ES2015 `Map`s — identical to
/// `solver-wasm`'s convention.
fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// A browser-resident planner session: one canonical `Session` over an
/// in-memory store. The renderer will drive it through a `WasmBackend`
/// (Phase 3); this surface proves the boundary works.
#[wasm_bindgen]
pub struct WebSession {
    inner: Session,
}

#[wasm_bindgen]
impl WebSession {
    /// Build a session. `docs_json` is the raw bytes of an uploaded `Docs.json`
    /// (real game catalog); `None` falls back to the bundled fixture, exactly
    /// like the desktop app's fixture path. Panics are routed to the console
    /// for legible wasm stack traces.
    #[wasm_bindgen(constructor)]
    pub fn new(docs_json: Option<Vec<u8>>) -> Result<WebSession, JsValue> {
        console_error_panic_hook::set_once();
        let inner = Session::with_store(Box::new(MemoryPlanStore::new()), docs_json, "fixture")
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(WebSession { inner })
    }

    /// Full projection for the renderer's initial hydration (plan + derived +
    /// gamedata + world + advisor + undo state).
    pub fn hydrate(&mut self) -> Result<JsValue, JsValue> {
        to_js(&self.inner.hydrate())
    }

    /// Apply one or more commands as a single undoable step. `cmds` is a JS
    /// array of `Command` objects (the same shape the dev bridge accepts);
    /// returns the `EditResponse` (patches + derived + undo/redo state).
    pub fn edit(&mut self, cmds: JsValue) -> Result<JsValue, JsValue> {
        let cmds: Vec<Command> =
            serde_wasm_bindgen::from_value(cmds).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let resp = self
            .inner
            .edit(cmds)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        to_js(&resp)
    }

    /// Read-only ranked next moves (heuristic engine) over a fresh solve.
    pub fn next_moves(&mut self) -> Result<JsValue, JsValue> {
        to_js(&self.inner.next_moves())
    }
}

// The smoke test that PROVES Session runs in wasm (not just compiles): build a
// WebSession over the fixture, hydrate, apply one edit, and assert the derived
// state actually changed. Runs under `wasm-pack test --node` / the
// wasm-bindgen test runner. Guarded to wasm so a native `cargo test` skips it.
#[cfg(all(test, target_arch = "wasm32"))]
mod wasm_smoke {
    use super::*;
    use wasm_bindgen_test::*;

    #[wasm_bindgen_test]
    fn websession_hydrates_edits_and_state_changes() {
        let mut s = WebSession::new(None).expect("construct WebSession over the fixture");

        // Hydrate: the initial plan has no factories.
        let before = s.hydrate().expect("hydrate");
        let before: serde_json::Value =
            serde_wasm_bindgen::from_value(before).expect("hydrate → json");
        let factories_before = before["plan"]["factories"]
            .as_object()
            .map(|m| m.len())
            .unwrap_or(0);
        assert_eq!(factories_before, 0, "fixture plan starts empty");

        // Apply one edit: create a factory (ULID minting exercises getrandom +
        // the wasm clock — the whole point of the proof).
        let cmd = serde_json::json!([{
            "type": "create_factory",
            "name": "WASM WORKS",
            "position": { "x": 1.0, "y": 2.0, "z": 0.0 },
            "region": "GRASS FIELDS"
        }]);
        let cmds = serde_wasm_bindgen::to_value(&cmd).expect("cmd → js");
        let resp = s.edit(cmds).expect("edit applies");
        let resp: serde_json::Value =
            serde_wasm_bindgen::from_value(resp).expect("edit response → json");
        assert_eq!(
            resp["created"].as_array().map(|a| a.len()).unwrap_or(0),
            1,
            "the edit minted one entity (a ULID id)"
        );

        // Re-hydrate: the derived state changed — one factory now exists.
        let after = s.hydrate().expect("re-hydrate");
        let after: serde_json::Value =
            serde_wasm_bindgen::from_value(after).expect("hydrate → json");
        let factories_after = after["plan"]["factories"]
            .as_object()
            .map(|m| m.len())
            .unwrap_or(0);
        assert_eq!(
            factories_after, 1,
            "the plan gained a factory after the edit"
        );
    }
}
