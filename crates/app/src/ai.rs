//! Bring-your-own-model ranking layer (PR 10, AI-next 2 of 3). The MODEL
//! NEVER CALCULATES: the opportunity engine (opportunities.rs) derives every
//! candidate and every number; a configured OpenAI-compatible endpoint only
//! RANKS and NARRATES that fixed list. One chat-completions call covers
//! OpenAI / Anthropic-compat / OpenRouter / Groq / Ollama / LM Studio.
//!
//! The honesty firewall is [`apply_model_ranking`]: a PURE function from
//! `(candidates, model reply)` to a ranked list. Reply ids that aren't
//! candidates are dropped, duplicates are dropped, candidates the model
//! omitted are appended in heuristic order, notes attach only to known ids,
//! and notes/headline are length-clamped. Cards come ONLY from `candidates` —
//! there is no code path by which model output creates a card, changes an
//! action, or rewrites a title/evidence line.
//!
//! Failure is quiet + surfaced: any provider fault (HTTP error, bad JSON,
//! timeout) returns the untouched heuristic list with a short `error` string
//! for the status-bar chip. The endpoint always answers.
//!
//! KEY HYGIENE: [`AiConfig`] deliberately derives neither `Serialize` nor
//! `Debug`. The key leaves the process only as the Authorization header of
//! the provider call — never echoed by GET /api/ai/config, never in hydrate,
//! never logged, never persisted (v1; the Tauri shell owns keychain
//! persistence later — see DECISIONS.md).

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::opportunities::Opportunity;
use crate::session::Session;

/// Default provider-call timeout. Configurable per session (POST
/// /api/ai/config `timeoutSecs`) so tests can run the timeout path fast.
pub const DEFAULT_TIMEOUT_SECS: u64 = 20;

/// Length clamp for model prose (headline and per-card notes) — commentary,
/// not essays; anything longer is cut at a char boundary.
const PROSE_CLAMP: usize = 240;

/// The system prompt, checked in as reviewable source. The contract it states
/// is the same one [`apply_model_ranking`] enforces mechanically.
pub const RANK_SYSTEM_PROMPT: &str = "\
You are a Satisfactory factory advisor inside FICSIT Planner.
You receive the planner's derived empire state and a FIXED list of candidate next moves.
The planner already did all the math. You never calculate anything.
Your only job: RANK the candidates by what the player should do first, and say why, briefly.
Rules:
- Reference only candidate ids from the given list. Never invent a candidate or an action.
- Every number you mention must appear verbatim in the provided evidence. Never derive new numbers.
- Broken things (overdrawn grids, starved factories) usually outrank growth ideas; use judgment on ties.
- Keep the headline to one sentence naming the single best next move and why it is first.
- Keep each note to one short sentence about that candidate's rank.
Reply with STRICT JSON only — no markdown, no code fences — exactly this shape:
{\"order\": [\"<candidate id>\", ...], \"headline\": \"<one sentence>\", \"notes\": {\"<candidate id>\": \"<one sentence>\"}}
\"order\" must list every candidate id exactly once; \"notes\" entries are optional.";

/// In-memory model endpoint config (Session-held). Defaults from env:
/// `FICSIT_AI_BASE_URL`, `FICSIT_AI_MODEL`, `FICSIT_AI_KEY`.
///
/// Deliberately NOT `Serialize`/`Debug`: the only serializable projection is
/// [`AiConfigPublic`], which carries `has_key`, never the key.
pub struct AiConfig {
    /// OpenAI-compatible base, e.g. `https://api.openai.com/v1` — the call
    /// goes to `{base_url}/chat/completions`.
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
    pub timeout_secs: u64,
}

impl AiConfig {
    pub fn from_env() -> Self {
        let env = |k: &str| {
            std::env::var(k)
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        Self {
            base_url: env("FICSIT_AI_BASE_URL").unwrap_or_default(),
            model: env("FICSIT_AI_MODEL").unwrap_or_default(),
            api_key: env("FICSIT_AI_KEY"),
            timeout_secs: DEFAULT_TIMEOUT_SECS,
        }
    }

    /// Usable for a model call: base URL + model both present. A key is NOT
    /// required (Ollama / LM Studio run keyless).
    pub fn configured(&self) -> bool {
        !self.base_url.is_empty() && !self.model.is_empty()
    }
}

/// What GET /api/ai/config returns — the ONLY serialized view of the config.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigPublic {
    pub configured: bool,
    pub base_url: String,
    pub model: String,
    /// The key round-trips as a boolean, never as text.
    pub has_key: bool,
}

/// POST /api/ai/config body. `api_key` absent/null = keep the current key
/// (the UI's password field placeholder reads "unchanged"); empty string =
/// clear it; anything else = replace it. `timeout_secs` absent = keep.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigUpdate {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

pub fn config_public(s: &Session) -> AiConfigPublic {
    AiConfigPublic {
        configured: s.ai.configured(),
        base_url: s.ai.base_url.clone(),
        model: s.ai.model.clone(),
        has_key: s.ai.api_key.is_some(),
    }
}

/// Apply a config update in memory. Nothing here touches disk: v1 does not
/// persist the key (or base/model) anywhere — env + this setter are the two
/// sources, and a restart honestly forgets what was typed.
pub fn set_config(s: &mut Session, update: AiConfigUpdate) -> AiConfigPublic {
    s.ai.base_url = update.base_url.trim().trim_end_matches('/').to_string();
    s.ai.model = update.model.trim().to_string();
    match update.api_key {
        None => {}
        Some(k) if k.trim().is_empty() => s.ai.api_key = None,
        Some(k) => s.ai.api_key = Some(k.trim().to_string()),
    }
    if let Some(t) = update.timeout_secs {
        s.ai.timeout_secs = t.max(1);
    }
    config_public(s)
}

/// The model's expected reply shape. Every field is optional-tolerant: a
/// reply that parses but misses fields degrades field-by-field (no order →
/// heuristic order; no notes → no notes), never wedges.
#[derive(Debug, Default, Deserialize)]
pub struct ModelReply {
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub headline: Option<String>,
    #[serde(default)]
    pub notes: BTreeMap<String, String>,
}

/// One ranked move: the untouched engine card plus (at most) an attached
/// model note. `note` is the ONLY model-writable field.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankedOpportunity {
    #[serde(flatten)]
    pub opportunity: Opportunity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// POST /api/next/rank response. `engine: "heuristic"` is byte-identical in
/// card content to GET /api/next (same derivation function); `error` carries
/// the short status-bar string when a model call was attempted and failed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RankResponse {
    pub engine: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub opportunities: Vec<RankedOpportunity>,
}

fn heuristic(candidates: Vec<Opportunity>, error: Option<String>) -> RankResponse {
    RankResponse {
        engine: "heuristic",
        model: None,
        headline: None,
        error,
        opportunities: candidates
            .into_iter()
            .map(|opportunity| RankedOpportunity {
                opportunity,
                note: None,
            })
            .collect(),
    }
}

/// Char-boundary-safe prose clamp (never splits a UTF-8 scalar).
fn clamp(text: &str) -> String {
    text.trim().chars().take(PROSE_CLAMP).collect()
}

/// THE VALIDATION FIREWALL — pure, unit-tested directly. Maps the model reply
/// onto the fixed candidate list:
///
/// - unknown ids in `order` are DROPPED;
/// - duplicate ids are DROPPED (first occurrence wins);
/// - candidates missing from `order` are APPENDED in heuristic order;
/// - notes attach only to ids that survived (unknown-id notes vanish);
/// - notes and headline are length-clamped.
///
/// Every `Opportunity` in the output is moved verbatim from `candidates`:
/// model output cannot create a card, change an action, or alter a title or
/// evidence line, by construction.
pub fn apply_model_ranking(
    candidates: Vec<Opportunity>,
    reply: &ModelReply,
) -> (Option<String>, Vec<RankedOpportunity>) {
    let known: BTreeSet<&str> = candidates.iter().map(|c| c.id.as_str()).collect();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut order: Vec<&str> = Vec::new();
    for id in &reply.order {
        if known.contains(id.as_str()) && seen.insert(id.as_str()) {
            order.push(id.as_str());
        }
    }
    for c in &candidates {
        if seen.insert(c.id.as_str()) {
            order.push(c.id.as_str());
        }
    }
    let order: Vec<String> = order.into_iter().map(String::from).collect();
    let mut by_id: BTreeMap<String, Opportunity> =
        candidates.into_iter().map(|c| (c.id.clone(), c)).collect();
    let ranked = order
        .iter()
        .map(|id| RankedOpportunity {
            note: reply
                .notes
                .get(id)
                .map(|n| clamp(n))
                .filter(|n| !n.is_empty()),
            opportunity: by_id.remove(id).expect("order contains only known ids"),
        })
        .collect();
    let headline = reply
        .headline
        .as_deref()
        .map(clamp)
        .filter(|h| !h.is_empty());
    (headline, ranked)
}

/// Strip a courtesy markdown fence (```json … ```): some small models fence
/// despite instructions, and unfencing is lossless — the inner text still has
/// to parse as the strict schema or we fall back.
fn strip_fences(content: &str) -> &str {
    let t = content.trim();
    let Some(rest) = t.strip_prefix("```") else {
        return t;
    };
    let rest = rest.strip_prefix("json").unwrap_or(rest);
    rest.trim().strip_suffix("```").unwrap_or(rest).trim()
}

/// One blocking OpenAI-compatible chat-completions call. Errors map to SHORT
/// user-facing strings (status-bar chip); the key travels only in the
/// Authorization header and never appears in any error text.
fn call_provider(
    base_url: &str,
    api_key: Option<&str>,
    timeout_secs: u64,
    body: &serde_json::Value,
) -> Result<ModelReply, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(timeout_secs))
        .build();
    let url = format!("{base_url}/chat/completions");
    let mut req = agent.post(&url).set("Content-Type", "application/json");
    if let Some(key) = api_key {
        req = req.set("Authorization", &format!("Bearer {key}"));
    }
    let resp = req.send_string(&body.to_string()).map_err(|e| match e {
        ureq::Error::Status(code, _) => format!("model endpoint returned HTTP {code}"),
        // Transport errors (refused, DNS, timeout) print URL + cause — never
        // headers, so never the key.
        ureq::Error::Transport(t) => {
            let msg: String = t.to_string().chars().take(160).collect();
            format!("model call failed: {msg}")
        }
    })?;
    let text = resp
        .into_string()
        .map_err(|_| "model reply unreadable".to_string())?;
    let envelope: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "model reply was not JSON".to_string())?;
    let content = envelope["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| "model reply missing message content".to_string())?;
    serde_json::from_str::<ModelReply>(strip_fences(content))
        .map_err(|_| "model reply did not match the rank schema".to_string())
}

/// POST /api/next/rank. Candidates come from the SAME derivation as GET
/// /api/next ([`Session::next_moves`] — never a second source of truth); the
/// model call is attempted only when configured, and every failure path
/// answers with the heuristic list plus a surfaced `error`.
pub fn rank_next_moves(s: &mut Session) -> RankResponse {
    let candidates = s.next_moves();
    if !s.ai.configured() {
        return heuristic(candidates, None);
    }
    if candidates.is_empty() {
        // Nothing to rank — honest silence needs no model call.
        return heuristic(candidates, None);
    }
    let base_url = s.ai.base_url.trim_end_matches('/').to_string();
    let model = s.ai.model.clone();
    let api_key = s.ai.api_key.clone();
    let timeout_secs = s.ai.timeout_secs;
    // Context = the SAME empire snapshot the chat surface shows the user
    // (chat::compact_state) — dense, aggregated, nothing the UI can't show.
    let ctx = crate::chat::compact_state(s, &crate::chat::ContextScope::Empire);
    let cand_view: Vec<serde_json::Value> = candidates
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id,
                "kind": c.kind,
                "title": c.title,
                "evidence": c.evidence,
            })
        })
        .collect();
    let user = serde_json::json!({ "state": ctx.payload, "candidates": cand_view }).to_string();
    let body = serde_json::json!({
        "model": model,
        "temperature": 0.2,
        // Honored by providers that support it, harmlessly ignored elsewhere.
        "response_format": { "type": "json_object" },
        "messages": [
            { "role": "system", "content": RANK_SYSTEM_PROMPT },
            { "role": "user", "content": user },
        ],
    });
    match call_provider(&base_url, api_key.as_deref(), timeout_secs, &body) {
        Ok(reply) => {
            let (headline, opportunities) = apply_model_ranking(candidates, &reply);
            RankResponse {
                engine: "model",
                model: Some(model),
                headline,
                error: None,
                opportunities,
            }
        }
        Err(error) => heuristic(candidates, Some(error)),
    }
}
