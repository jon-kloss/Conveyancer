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
//! CONCURRENCY: ranking is a two-phase split. [`prepare_rank`] runs UNDER the
//! session lock (one acquisition: derive candidates, snapshot config +
//! context into a [`RankJob`]); [`execute_rank`] is pure over that owned job
//! (`Send` by construction), so the blocking provider round-trip runs OFF the
//! lock and a slow or hung endpoint never wedges hydrate/edit/solve.
//! [`rank_next_moves`] is the in-line façade over both halves.
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
/// not essays. Overlong text is cut to at most this many chars INCLUDING the
/// trailing ellipsis, at a whitespace boundary (see [`clamp`]).
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
    /// Build a config from any `key → value` source using the env-var key
    /// names. Split from [`Self::from_env`] so the parsing rules — trim,
    /// blank = unset — are unit-testable without touching (or racing on)
    /// real process env. Tests also use it to pin a session to a KNOWN-empty
    /// config regardless of whatever `FICSIT_AI_*` the host exports.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let get = |k: &str| {
            lookup(k)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        Self {
            base_url: get("FICSIT_AI_BASE_URL").unwrap_or_default(),
            model: get("FICSIT_AI_MODEL").unwrap_or_default(),
            api_key: get("FICSIT_AI_KEY"),
            timeout_secs: DEFAULT_TIMEOUT_SECS,
        }
    }

    pub fn from_env() -> Self {
        Self::from_lookup(|k| std::env::var(k).ok())
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
/// clear it; anything else = replace it. `timeout_secs` absent = keep;
/// present = clamped to 1..=120 (floor keeps the fast-timeout test seam,
/// ceiling keeps a fat-fingered value from wedging a rank worker for hours).
///
/// Deliberately NOT `Debug`: this struct carries the raw key in transit, and
/// key hygiene here is compile-enforced, not convention-enforced.
#[derive(Clone, Deserialize)]
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
        s.ai.timeout_secs = t.clamp(1, 120);
    }
    config_public(s)
}

/// The model's expected reply shape. MISSING fields degrade individually (no
/// order → heuristic order; no notes → no notes), but a field of the WRONG
/// TYPE fails the whole parse — and that is the safe direction: the reply is
/// rejected wholesale and the untouched heuristic list ships with a surfaced
/// error. A reply that parses but carries NONE of the fields is treated as a
/// schema failure by [`execute_rank`] (a `{}` buried in prose must not wear
/// the `engine:"model"` badge).
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

/// Honest prose clamp: at most [`PROSE_CLAMP`] chars INCLUDING the ellipsis.
/// Overlong text keeps its first `PROSE_CLAMP - 1` chars, cut back to the
/// last whitespace so a truncation can never end mid-token — a naive cut
/// like "…margin of 1,500" → "…of 1,5" MANUFACTURES a number the model never
/// said, in text rendered under the AI badge. A single unbroken token has no
/// whitespace to cut at and falls back to the hard cut, still
/// ellipsis-marked. Char-based throughout (never splits a UTF-8 scalar).
fn clamp(text: &str) -> String {
    let t = text.trim();
    if t.chars().count() <= PROSE_CLAMP {
        return t.to_string();
    }
    let head: String = t.chars().take(PROSE_CLAMP - 1).collect();
    let kept = match head.rfind(char::is_whitespace) {
        Some(i) => &head[..i],
        None => head.as_str(),
    };
    let mut out = kept.trim_end().to_string();
    out.push('…');
    out
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
    // Unreachable today (the engine derives ids uniquely), but a duplicate
    // candidate id would silently collapse a card below — catch it in tests.
    debug_assert_eq!(
        known.len(),
        candidates.len(),
        "engine-side candidate ids must be unique"
    );
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

/// Salvage the ONE complete JSON object from model prose: strip a courtesy
/// fence, seek the first '{', then stream-deserialize exactly one value —
/// the stream iterator parses a single complete object and IGNORES anything
/// after it, so "Sure! {…} Let me know!" succeeds where a first-`{`/last-`}`
/// window would not. Prose braces BEFORE the real JSON still fail the parse
/// → heuristic fallback (never worse than the old strict parse).
fn extract_reply(content: &str) -> Option<ModelReply> {
    let t = strip_fences(content);
    let start = t.find('{')?;
    serde_json::Deserializer::from_str(&t[start..])
        .into_iter::<ModelReply>()
        .next()?
        .ok()
}

/// Provider-call failure: a SHORT user-facing message (status-bar chip) plus
/// the HTTP status when there was one, so [`execute_rank`] can decide
/// whether a lean retry makes sense. The key never appears in any message.
struct ProviderError {
    status: Option<u16>,
    message: String,
}

impl ProviderError {
    fn plain(message: impl Into<String>) -> Self {
        Self {
            status: None,
            message: message.into(),
        }
    }
}

/// One blocking OpenAI-compatible chat-completions call. Errors map to SHORT
/// user-facing strings (status-bar chip); the key travels only in the
/// Authorization header and never appears in any error text.
fn call_provider(
    base_url: &str,
    api_key: Option<&str>,
    timeout_secs: u64,
    body: &serde_json::Value,
) -> Result<ModelReply, ProviderError> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(timeout_secs))
        .build();
    let url = format!("{base_url}/chat/completions");
    let mut req = agent.post(&url).set("Content-Type", "application/json");
    if let Some(key) = api_key {
        req = req.set("Authorization", &format!("Bearer {key}"));
    }
    let resp = req.send_string(&body.to_string()).map_err(|e| match e {
        // HTTP-error bodies usually say WHY ("temperature is not supported",
        // "model not found") — surface a sanitized snippet: control chars
        // flattened to spaces, the key defensively stripped BEFORE the cut
        // (a truncation must never leave a partial key), first 160 chars.
        ureq::Error::Status(code, resp) => {
            let raw = resp.into_string().unwrap_or_default();
            let mut clean: String = raw
                .chars()
                .map(|c| if c.is_control() { ' ' } else { c })
                .collect();
            if let Some(key) = api_key {
                clean = clean.replace(key, "<redacted>");
            }
            let snippet: String = clean.trim().chars().take(160).collect();
            let message = if snippet.is_empty() {
                format!("model endpoint returned HTTP {code}")
            } else {
                format!("model endpoint returned HTTP {code}: {snippet}")
            };
            ProviderError {
                status: Some(code),
                message,
            }
        }
        // Transport errors (refused, DNS, timeout) print URL + cause — never
        // headers, so never the key.
        ureq::Error::Transport(t) => {
            let msg: String = t.to_string().chars().take(160).collect();
            ProviderError::plain(format!("model call failed: {msg}"))
        }
    })?;
    let text = resp
        .into_string()
        .map_err(|_| ProviderError::plain("model reply unreadable"))?;
    let envelope: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| ProviderError::plain("model reply was not JSON"))?;
    let content = envelope["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| ProviderError::plain("model reply missing message content"))?;
    extract_reply(content)
        .ok_or_else(|| ProviderError::plain("model reply did not match the rank schema"))
}

/// Everything the OFF-LOCK provider call needs, snapshotted under ONE lock
/// acquisition by [`prepare_rank`]. Owns plain data only, so it is `Send` by
/// construction and the blocking HTTP round-trip can run on any thread while
/// the session lock stays free for edits/hydrate.
///
/// `user` is the fully-serialized USER MESSAGE (empire state + candidate
/// list, one JSON string): [`execute_rank`]'s lean retry rebuilds a request
/// BODY from it without ever re-touching the session.
pub struct RankJob {
    base_url: String,
    model: String,
    api_key: Option<String>,
    timeout_secs: u64,
    candidates: Vec<Opportunity>,
    user: String,
}

/// Outcome of the under-lock half of a rank: either the answer is already
/// known (unconfigured / nothing to rank) or a [`RankJob`] remains to be
/// executed OFF the session lock.
pub enum RankPrep {
    Done(RankResponse),
    Call(RankJob),
}

/// PHASE 1 (under the session lock — the caller's lock scope should end the
/// moment this returns). Candidates come from the SAME derivation as GET
/// /api/next ([`Session::next_moves`] — never a second source of truth);
/// config + context are snapshotted so nothing later needs `&Session`.
pub fn prepare_rank(s: &mut Session) -> RankPrep {
    let candidates = s.next_moves();
    if !s.ai.configured() {
        return RankPrep::Done(heuristic(candidates, None));
    }
    if candidates.is_empty() {
        // Nothing to rank — honest silence needs no model call.
        return RankPrep::Done(heuristic(candidates, None));
    }
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
    RankPrep::Call(RankJob {
        base_url: s.ai.base_url.trim_end_matches('/').to_string(),
        model: s.ai.model.clone(),
        api_key: s.ai.api_key.clone(),
        timeout_secs: s.ai.timeout_secs,
        candidates,
        user,
    })
}

/// Build the chat-completions body from the job. `lean` omits every OPTIONAL
/// param — `temperature`, `response_format`, `max_tokens` — for the one-shot
/// 400/422 retry (strict endpoints reject knobs they don't support).
/// `max_tokens` scales with the candidate count: a flat cap would truncate
/// the reply JSON mid-string at megabase scale and MANUFACTURE the very
/// parse failure it exists to prevent.
fn request_body(job: &RankJob, lean: bool) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": job.model,
        "messages": [
            { "role": "system", "content": RANK_SYSTEM_PROMPT },
            { "role": "user", "content": job.user },
        ],
    });
    if !lean {
        body["temperature"] = serde_json::json!(0.2);
        // Honored by providers that support it, harmlessly ignored elsewhere.
        body["response_format"] = serde_json::json!({ "type": "json_object" });
        body["max_tokens"] = serde_json::json!(256 + 48 * job.candidates.len());
    }
    body
}

/// Ok-arm finish. A FULLY-EMPTY parse (no order, no notes, headline absent
/// or blank) is treated as a schema failure: `{}` buried in prose or a
/// structurally unrelated JSON object would otherwise ship as
/// `engine:"model"` with zero model content — a silent no-op wearing the AI
/// badge. Partial replies still degrade per field (see [`ModelReply`]), and
/// the pure firewall keeps its own empty-tolerance as defense in depth.
fn ranked_response(job: RankJob, reply: &ModelReply) -> RankResponse {
    let headline_blank = reply.headline.as_deref().unwrap_or("").trim().is_empty();
    if reply.order.is_empty() && reply.notes.is_empty() && headline_blank {
        return heuristic(
            job.candidates,
            Some("model reply did not match the rank schema".to_string()),
        );
    }
    let (headline, opportunities) = apply_model_ranking(job.candidates, reply);
    RankResponse {
        engine: "model",
        model: Some(job.model),
        headline,
        error: None,
        opportunities,
    }
}

/// PHASE 2 (OFF the session lock — pure over the job, safe on any thread).
/// One provider call; on HTTP 400/422 exactly one retry with the optional
/// params dropped — those two statuses are how strict endpoints reject a
/// knob they don't support (reasoning tiers reject `temperature`, some
/// servers reject `response_format`/`max_tokens`). NEVER retried: 401/403
/// (auth — the same credentials fail the same way), 404 (wrong base or
/// model — the same request meets the same miss) and 429 (rate limit — an
/// immediate retry only digs the hole deeper). Every failure path answers
/// with the heuristic list plus a surfaced `error`.
pub fn execute_rank(job: RankJob) -> RankResponse {
    let full = request_body(&job, false);
    match call_provider(
        &job.base_url,
        job.api_key.as_deref(),
        job.timeout_secs,
        &full,
    ) {
        Ok(reply) => ranked_response(job, &reply),
        Err(first) if matches!(first.status, Some(400 | 422)) => {
            let lean = request_body(&job, true);
            match call_provider(
                &job.base_url,
                job.api_key.as_deref(),
                job.timeout_secs,
                &lean,
            ) {
                Ok(reply) => ranked_response(job, &reply),
                Err(second) => heuristic(
                    job.candidates,
                    Some(format!(
                        "{} (retried without optional params)",
                        second.message
                    )),
                ),
            }
        }
        Err(first) => heuristic(job.candidates, Some(first.message)),
    }
}

/// POST /api/next/rank, in-line: prepare + execute back to back. Correct for
/// callers that already own the session exclusively (tests, serial tools);
/// the Tauri shell and the dev bridge call the two halves separately so the
/// lock is not held across the provider round-trip.
pub fn rank_next_moves(s: &mut Session) -> RankResponse {
    match prepare_rank(s) {
        RankPrep::Done(resp) => resp,
        RankPrep::Call(job) => execute_rank(job),
    }
}
