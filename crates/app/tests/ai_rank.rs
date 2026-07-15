//! PR 10 bring-your-own-model ranking: the validation firewall is pure and
//! unit-tested directly; the provider call is exercised against an in-test
//! localhost stub (std TcpListener — NO real network, ever). Every failure
//! edge answers with the heuristic list plus a surfaced error string, and the
//! key never appears in any serialized view.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use app::ai::{
    apply_model_ranking, config_public, rank_next_moves, set_config, AiConfig, AiConfigUpdate,
    ModelReply, DEFAULT_TIMEOUT_SECS,
};
use app::opportunities::{Opportunity, OpportunityAction, OpportunityKind};
use app::Session;
use planner_core::commands::Command;
use planner_core::entities::*;

// ---------- pure firewall units ----------

fn card(id: &str) -> Opportunity {
    Opportunity {
        id: id.into(),
        kind: OpportunityKind::DeficitRepair,
        title: format!("title of {id}"),
        evidence: format!("evidence of {id}"),
        item: None,
        action: OpportunityAction::OpenAudit {
            tab: "power".into(),
        },
    }
}

fn reply(order: &[&str]) -> ModelReply {
    ModelReply {
        order: order.iter().map(|s| s.to_string()).collect(),
        headline: Some("do the thing".into()),
        notes: Default::default(),
    }
}

#[test]
fn firewall_respects_a_full_reorder_and_attaches_notes() {
    let cands = vec![card("a"), card("b"), card("c")];
    let mut r = reply(&["c", "a", "b"]);
    r.notes.insert("c".into(), "c first".into());
    r.notes.insert("a".into(), "a second".into());
    let (headline, ranked) = apply_model_ranking(cands, &r);
    assert_eq!(headline.as_deref(), Some("do the thing"));
    let ids: Vec<&str> = ranked.iter().map(|o| o.opportunity.id.as_str()).collect();
    assert_eq!(ids, ["c", "a", "b"]);
    assert_eq!(ranked[0].note.as_deref(), Some("c first"));
    assert_eq!(ranked[1].note.as_deref(), Some("a second"));
    assert_eq!(ranked[2].note, None);
    // cards pass through VERBATIM — the model cannot touch title/evidence.
    assert_eq!(ranked[0].opportunity.title, "title of c");
    assert_eq!(ranked[0].opportunity.evidence, "evidence of c");
}

#[test]
fn firewall_drops_unknown_ids_and_appends_missing_in_heuristic_order() {
    let cands = vec![card("a"), card("b"), card("c")];
    let mut r = reply(&["hallucinated", "b"]);
    r.notes
        .insert("hallucinated".into(), "an invented card".into());
    let (_, ranked) = apply_model_ranking(cands, &r);
    let ids: Vec<&str> = ranked.iter().map(|o| o.opportunity.id.as_str()).collect();
    // b (the one valid pick) first, then a and c appended in heuristic order.
    assert_eq!(ids, ["b", "a", "c"]);
    // an unknown-id note has NO card to attach to — it vanishes entirely.
    assert!(ranked.iter().all(|o| o.note.is_none()));
}

#[test]
fn firewall_dedupes_repeated_ids() {
    let cands = vec![card("a"), card("b"), card("c")];
    let (_, ranked) = apply_model_ranking(cands, &reply(&["b", "b", "a", "b"]));
    let ids: Vec<&str> = ranked.iter().map(|o| o.opportunity.id.as_str()).collect();
    assert_eq!(ids, ["b", "a", "c"]);
}

#[test]
fn firewall_clamps_headline_and_notes() {
    let cands = vec![card("a")];
    let mut r = ModelReply {
        order: vec!["a".into()],
        headline: Some("h".repeat(5000)),
        notes: Default::default(),
    };
    r.notes.insert("a".into(), "n".repeat(5000));
    let (headline, ranked) = apply_model_ranking(cands, &r);
    // One unbroken token → the hard-cut branch: 239 kept chars + '…' = 240
    // total, honestly marked as truncated.
    let headline = headline.unwrap();
    assert_eq!(headline.chars().count(), 240);
    assert!(headline.ends_with('…'), "truncation must be marked");
    let note = ranked[0].note.clone().unwrap();
    assert_eq!(note.chars().count(), 240);
    assert!(note.ends_with('…'), "truncation must be marked");
}

#[test]
fn clamp_never_manufactures_a_number() {
    // The naive take(240) once rendered "… margin of 1,500" as "… of 1,5" —
    // a number the model never said, in AI-attributed text. The clamp must
    // cut back to the last whitespace instead.
    let cands = vec![card("a")];
    let mut r = reply(&["a"]);
    let text = format!("{} 1,500 spare megawatts", "z".repeat(233));
    r.headline = Some(text.clone());
    r.notes.insert("a".into(), text);
    let (headline, ranked) = apply_model_ranking(cands, &r);
    let headline = headline.unwrap();
    assert_eq!(headline, format!("{}…", "z".repeat(233)));
    assert!(
        !headline.chars().any(|c| c.is_ascii_digit()),
        "no digit may survive a mid-number cut: {headline}"
    );
    assert_eq!(ranked[0].note.as_deref(), Some(headline.as_str()));
}

#[test]
fn clamp_multibyte_cut_is_boundary_safe_and_number_honest() {
    // Multibyte filler shifts every char boundary off its byte index; the
    // 239-char head then ends mid "1,500". Expect a cut at the whitespace:
    // exactly filler + '…', never a "1,5" fragment.
    let cands = vec![card("a")];
    let filler = "é".repeat(235);
    let text = format!("{filler} 1,500 spare megawatts");
    let mut r = reply(&["a"]);
    r.headline = Some(text.clone());
    r.notes.insert("a".into(), text);
    let (headline, ranked) = apply_model_ranking(cands, &r);
    let headline = headline.unwrap();
    assert_eq!(headline, format!("{filler}…"));
    assert!(!headline.contains("1,5"), "manufactured number: {headline}");
    assert_eq!(
        ranked[0].note.as_deref(),
        Some(headline.as_str()),
        "note and headline take the identical clamp"
    );
}

#[test]
fn firewall_drops_blank_headline_and_notes() {
    let cands = vec![card("a")];
    let mut r = reply(&["a"]);
    r.headline = Some("   ".into());
    r.notes.insert("a".into(), "\n\t ".into());
    let (headline, ranked) = apply_model_ranking(cands, &r);
    assert_eq!(headline, None, "whitespace-only headline must vanish");
    assert_eq!(ranked[0].note, None, "whitespace-only note must vanish");
}

#[test]
fn firewall_tolerates_an_empty_reply() {
    let cands = vec![card("a"), card("b")];
    let (headline, ranked) = apply_model_ranking(cands, &ModelReply::default());
    assert_eq!(headline, None);
    let ids: Vec<&str> = ranked.iter().map(|o| o.opportunity.id.as_str()).collect();
    assert_eq!(ids, ["a", "b"], "no order → heuristic order untouched");
}

// ---------- config hygiene ----------

fn cfg(base_url: &str, model: &str, key: Option<&str>, timeout: Option<u64>) -> AiConfigUpdate {
    AiConfigUpdate {
        base_url: base_url.into(),
        model: model.into(),
        api_key: key.map(String::from),
        timeout_secs: timeout,
    }
}

#[test]
fn from_lookup_reads_trimmed_values_and_optional_key() {
    let c = AiConfig::from_lookup(|k| match k {
        "FICSIT_AI_BASE_URL" => Some("  http://127.0.0.1:9/v1  ".into()),
        "FICSIT_AI_MODEL" => Some("m1".into()),
        "FICSIT_AI_KEY" => Some("sk-x".into()),
        _ => None,
    });
    assert!(c.configured());
    assert_eq!(c.base_url, "http://127.0.0.1:9/v1", "values are trimmed");
    assert_eq!(c.model, "m1");
    assert_eq!(c.api_key.as_deref(), Some("sk-x"));
    assert_eq!(c.timeout_secs, DEFAULT_TIMEOUT_SECS);
}

#[test]
fn from_lookup_treats_missing_and_blank_as_unset() {
    let c = AiConfig::from_lookup(|k| {
        // A blank key is as good as no key — whitespace never configures.
        (k == "FICSIT_AI_KEY").then(|| "   ".to_string())
    });
    assert!(!c.configured());
    assert!(c.base_url.is_empty() && c.model.is_empty());
    assert_eq!(c.api_key, None, "blank env key must not count as a key");
}

#[test]
fn config_get_never_echoes_the_key() {
    let mut s = Session::in_memory(None).unwrap();
    s.ai = AiConfig::from_lookup(|_| None); // de-flake: ignore host FICSIT_AI_*
    let public = set_config(
        &mut s,
        cfg("http://127.0.0.1:1/v1", "m", Some("sk-super-secret"), None),
    );
    assert!(public.configured && public.has_key);
    let json = serde_json::to_string(&public).unwrap();
    assert!(!json.contains("sk-super-secret"), "key echoed: {json}");
    assert!(json.contains("\"hasKey\":true"));
    // hydrate (the full renderer payload) must not carry it either.
    let hydrate = s.hydrate().to_string();
    assert!(!hydrate.contains("sk-super-secret"));
    // absent apiKey on a later update = key unchanged (the "unchanged"
    // password placeholder semantics); empty string = cleared.
    let public = set_config(&mut s, cfg("http://127.0.0.1:1/v1", "m2", None, None));
    assert!(public.has_key);
    let public = set_config(&mut s, cfg("http://127.0.0.1:1/v1", "m2", Some(""), None));
    assert!(!public.has_key);
}

#[test]
fn clearing_base_and_model_deconfigures_but_keeps_the_key() {
    // The w4-finally cleanup gesture: blanking base+model (apiKey absent)
    // must deconfigure WITHOUT discarding the stored key — absent means
    // "unchanged", even through a clear.
    let mut s = Session::in_memory(None).unwrap();
    s.ai = AiConfig::from_lookup(|_| None); // de-flake: ignore host FICSIT_AI_*
    let public = set_config(
        &mut s,
        cfg("http://127.0.0.1:1/v1", "m", Some("sk-keep"), None),
    );
    assert!(public.configured && public.has_key);
    let public = set_config(&mut s, cfg("", "", None, None));
    assert!(!public.configured, "blank base/model must deconfigure");
    assert!(public.has_key, "the key must survive a base/model clear");
    assert!(public.base_url.is_empty() && public.model.is_empty());
}

#[test]
fn timeout_is_clamped_to_one_through_120_seconds() {
    let mut s = Session::in_memory(None).unwrap();
    s.ai = AiConfig::from_lookup(|_| None);
    set_config(&mut s, cfg("http://127.0.0.1:1/v1", "m", None, Some(0)));
    assert_eq!(s.ai.timeout_secs, 1, "floor keeps the fast-timeout seam");
    set_config(
        &mut s,
        cfg("http://127.0.0.1:1/v1", "m", None, Some(999_999_999)),
    );
    assert_eq!(s.ai.timeout_secs, 120, "ceiling caps a wedging timeout");
    set_config(&mut s, cfg("http://127.0.0.1:1/v1", "m", None, Some(45)));
    assert_eq!(s.ai.timeout_secs, 45, "in-range values pass through");
}

// ---------- stub provider plumbing (localhost only) ----------

type Responder = Box<dyn Fn(&str) -> (u16, String) + Send>;

/// One-thread HTTP stub: accepts connections until the test process exits,
/// captures each raw request (headers + body), answers via `respond`.
fn stub_provider(respond: Responder) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let captured: Arc<Mutex<Vec<String>>> = Arc::default();
    let log = captured.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buf: Vec<u8> = Vec::new();
            let mut tmp = [0u8; 4096];
            let request = loop {
                let n = stream.read(&mut tmp).unwrap_or(0);
                if n == 0 {
                    break String::from_utf8_lossy(&buf).to_string();
                }
                buf.extend_from_slice(&tmp[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some(head_end) = text.find("\r\n\r\n") {
                    let content_length = text[..head_end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|v| v.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if text.len() >= head_end + 4 + content_length {
                        break text;
                    }
                }
            };
            log.lock().unwrap().push(request.clone());
            let (status, body) = respond(&request);
            let response = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    (base, captured)
}

/// Wrap a rank-schema `content` string in the chat-completions envelope.
fn completion(content: &str) -> String {
    serde_json::json!({ "choices": [{ "message": { "content": content } }] }).to_string()
}

/// Seed two starved chains (iron + copper ingots) so /api/next has at least
/// two deficit cards to reorder. Same command surface as the e2e seeds.
fn seeded_session() -> Session {
    let mut s = Session::in_memory(None).unwrap();
    // De-flake: engine/error assertions below must not depend on whatever
    // FICSIT_AI_* the host environment happens to export.
    s.ai = AiConfig::from_lookup(|_| None);
    let mut chain = |name: &str, item: &str, recipe: &str, x: f64| -> () {
        let fid = s
            .edit(vec![Command::CreateFactory {
                name: name.into(),
                position: MapPos { x, y: 0.0, z: 0.0 },
                region: "GRASS FIELDS".into(),
            }])
            .unwrap()
            .created[0]
            .clone();
        let ore = if item == "Desc_IronIngot_C" {
            "Desc_OreIron_C"
        } else {
            "Desc_OreCopper_C"
        };
        let ore_in = s
            .edit(vec![Command::AddPort {
                factory: fid.clone(),
                direction: PortDirection::In,
                item: ore.into(),
                rate: 0.0,
                rate_ceiling: Some(480.0),
                graph_pos: GraphPos { x: 0.0, y: 0.0 },
            }])
            .unwrap()
            .created[0]
            .clone();
        let out = s
            .edit(vec![Command::AddPort {
                factory: fid.clone(),
                direction: PortDirection::Out,
                item: item.into(),
                rate: 0.0,
                rate_ceiling: None,
                graph_pos: GraphPos { x: 600.0, y: 0.0 },
            }])
            .unwrap()
            .created[0]
            .clone();
        let bank = s
            .edit(vec![Command::AddGroup {
                factory: fid.clone(),
                machine: "Build_SmelterMk1_C".into(),
                recipe: recipe.into(),
                count: 8,
                clock: 1.0,
                graph_pos: GraphPos { x: 300.0, y: 0.0 },
                floor: 0,
            }])
            .unwrap()
            .created[0]
            .clone();
        for (from, to, edge_item) in [
            (EdgeEnd::Port(ore_in), EdgeEnd::Group(bank.clone()), ore),
            (EdgeEnd::Group(bank), EdgeEnd::Port(out.clone()), item),
        ] {
            s.edit(vec![Command::AddEdge {
                factory: fid.clone(),
                from,
                to,
                item: edge_item.into(),
                tier: 6,
            }])
            .unwrap();
        }
        // Sink demanding more than the producer ships → deficit_repair card.
        let sink = s
            .edit(vec![Command::CreateFactory {
                name: format!("{name} SINK"),
                position: MapPos {
                    x: x + 500.0,
                    y: 0.0,
                    z: 0.0,
                },
                region: "GRASS FIELDS".into(),
            }])
            .unwrap()
            .created[0]
            .clone();
        let sink_in = s
            .edit(vec![Command::AddPort {
                factory: sink.clone(),
                direction: PortDirection::In,
                item: item.into(),
                rate: 0.0,
                rate_ceiling: None,
                graph_pos: GraphPos { x: 0.0, y: 0.0 },
            }])
            .unwrap()
            .created[0]
            .clone();
        let sink_out = s
            .edit(vec![Command::AddPort {
                factory: sink.clone(),
                direction: PortDirection::Out,
                item: item.into(),
                rate: 0.0,
                rate_ceiling: None,
                graph_pos: GraphPos { x: 600.0, y: 0.0 },
            }])
            .unwrap()
            .created[0]
            .clone();
        s.edit(vec![Command::AddEdge {
            factory: sink,
            from: EdgeEnd::Port(sink_in.clone()),
            to: EdgeEnd::Port(sink_out.clone()),
            item: item.into(),
            tier: 6,
        }])
        .unwrap();
        s.edit(vec![Command::AddRoute {
            kind: RouteKind::Belt { tier: 5 },
            from: out.clone(),
            to: sink_in,
            path: vec![
                MapPos { x, y: 0.0, z: 0.0 },
                MapPos {
                    x: x + 500.0,
                    y: 0.0,
                    z: 0.0,
                },
            ],
        }])
        .unwrap();
        // Target set while satisfiable, then the upstream dips → honest gap.
        s.edit(vec![Command::SetPortRate {
            id: out.clone(),
            rate: 240.0,
        }])
        .unwrap();
        s.edit(vec![Command::SetPortRate {
            id: sink_out,
            rate: 240.0,
        }])
        .unwrap();
        s.edit(vec![Command::SetPortRate {
            id: out,
            rate: 10.0,
        }])
        .unwrap();
    };
    chain("IRON BAY", "Desc_IronIngot_C", "Recipe_IngotIron_C", 0.0);
    chain(
        "COPPER BAY",
        "Desc_CopperIngot_C",
        "Recipe_IngotCopper_C",
        2000.0,
    );
    s
}

fn heuristic_ids(s: &mut Session) -> Vec<String> {
    s.next_moves().into_iter().map(|o| o.id).collect()
}

// ---------- end-to-end against the stub ----------

#[test]
fn rank_honors_stub_reorder_and_sends_key_and_candidates() {
    let mut s = seeded_session();
    let ids = heuristic_ids(&mut s);
    assert!(ids.len() >= 2, "seed must yield two candidates: {ids:?}");

    // The stub reverses whatever candidate ids arrive in the user message.
    let (base, captured) = stub_provider(Box::new(|request: &str| {
        let body_at = request.find("\r\n\r\n").map(|i| i + 4).unwrap_or(0);
        let envelope: serde_json::Value = serde_json::from_str(&request[body_at..]).unwrap();
        let user: serde_json::Value =
            serde_json::from_str(envelope["messages"][1]["content"].as_str().unwrap()).unwrap();
        let mut order: Vec<String> = user["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].as_str().unwrap().to_string())
            .collect();
        order.reverse();
        let mut notes = serde_json::Map::new();
        notes.insert(
            order[0].clone(),
            serde_json::json!("The stub ranks this first."),
        );
        let content = serde_json::json!({
            "order": order,
            "headline": "Stub headline: start here.",
            "notes": notes,
        });
        (200, completion(&content.to_string()))
    }));
    set_config(&mut s, cfg(&base, "stub-1", Some("test-key-123"), None));

    let resp = rank_next_moves(&mut s);
    assert_eq!(resp.engine, "model");
    assert_eq!(resp.model.as_deref(), Some("stub-1"));
    assert_eq!(resp.headline.as_deref(), Some("Stub headline: start here."));
    assert_eq!(resp.error, None);
    let got: Vec<String> = resp
        .opportunities
        .iter()
        .map(|o| o.opportunity.id.clone())
        .collect();
    let mut want = ids.clone();
    want.reverse();
    assert_eq!(got, want, "stub reversal must be respected");
    assert_eq!(
        resp.opportunities[0].note.as_deref(),
        Some("The stub ranks this first.")
    );
    assert!(resp.opportunities[1..].iter().all(|o| o.note.is_none()));

    // Captured request: Authorization header carries the key; candidates
    // travel by id; the checked-in system prompt is the one sent.
    let requests = captured.lock().unwrap();
    let req = &requests[0];
    assert!(req.contains("POST /v1/chat/completions"));
    assert!(req.contains("Authorization: Bearer test-key-123"));
    for id in &ids {
        assert!(req.contains(&id.replace('/', "\\/")) || req.contains(id.as_str()));
    }
    assert!(req.contains("You never calculate anything"));
}

#[test]
fn malformed_reply_falls_back_to_heuristic_with_error() {
    let mut s = seeded_session();
    let ids = heuristic_ids(&mut s);
    let (base, _) = stub_provider(Box::new(|_| {
        (200, completion("this is not the rank schema {"))
    }));
    set_config(&mut s, cfg(&base, "stub-1", None, None));
    let resp = rank_next_moves(&mut s);
    assert_eq!(resp.engine, "heuristic");
    assert!(resp.headline.is_none() && resp.model.is_none());
    assert_eq!(
        resp.error.as_deref(),
        Some("model reply did not match the rank schema")
    );
    let got: Vec<String> = resp
        .opportunities
        .iter()
        .map(|o| o.opportunity.id.clone())
        .collect();
    assert_eq!(got, ids, "fallback list is the untouched heuristic order");
    assert!(resp.opportunities.iter().all(|o| o.note.is_none()));
}

#[test]
fn http_500_falls_back_to_heuristic_with_error() {
    let mut s = seeded_session();
    let (base, captured) = stub_provider(Box::new(|_| (500, "{\"error\":\"boom\"}".into())));
    set_config(&mut s, cfg(&base, "stub-1", None, None));
    let resp = rank_next_moves(&mut s);
    assert_eq!(resp.engine, "heuristic");
    let error = resp.error.unwrap();
    // The historical prefix is preserved; the body snippet now rides along.
    assert!(
        error.starts_with("model endpoint returned HTTP 500"),
        "{error}"
    );
    assert!(error.contains("boom"), "5xx body snippet surfaced: {error}");
    assert_eq!(captured.lock().unwrap().len(), 1, "5xx is never retried");
}

#[test]
fn http_400_retries_once_without_optional_params() {
    // A strict endpoint (reasoning tier) rejects `temperature` with 400; the
    // one-shot lean retry — temperature, response_format and max_tokens all
    // dropped — must succeed transparently.
    let mut s = seeded_session();
    let ids = heuristic_ids(&mut s);
    let first = ids.last().unwrap().clone();
    let content = format!("{{\"order\": [\"{first}\"]}}");
    let (base, captured) = stub_provider(Box::new(move |request: &str| {
        if request.contains("\"temperature\"") {
            (
                400,
                "{\"error\":{\"message\":\"temperature is not supported\"}}".into(),
            )
        } else {
            (200, completion(&content))
        }
    }));
    set_config(&mut s, cfg(&base, "stub-1", None, None));
    let resp = rank_next_moves(&mut s);
    assert_eq!(
        resp.engine, "model",
        "lean retry must win: {:?}",
        resp.error
    );
    assert_eq!(resp.error, None);
    assert_eq!(resp.opportunities[0].opportunity.id, first);
    let requests = captured.lock().unwrap();
    assert_eq!(requests.len(), 2, "exactly one retry");
    for param in ["\"temperature\"", "\"response_format\"", "\"max_tokens\""] {
        assert!(
            requests[0].contains(param),
            "full request must carry {param}"
        );
        assert!(!requests[1].contains(param), "lean retry must drop {param}");
    }
}

#[test]
fn persistent_http_400_surfaces_a_sanitized_snippet() {
    let mut s = seeded_session();
    let ids = heuristic_ids(&mut s);
    let (base, captured) = stub_provider(Box::new(|_| {
        // Control char in the body: the snippet must flatten it.
        (400, "{\"error\":\n  \"no params accepted\"}".into())
    }));
    set_config(&mut s, cfg(&base, "stub-1", Some("sk-super-secret"), None));
    let resp = rank_next_moves(&mut s);
    assert_eq!(resp.engine, "heuristic");
    let error = resp.error.unwrap();
    assert!(
        error.starts_with("model endpoint returned HTTP 400:"),
        "{error}"
    );
    assert!(
        error.contains("no params accepted"),
        "snippet lost: {error}"
    );
    assert!(
        error.contains("(retried without optional params)"),
        "the both-failed message must note the retry: {error}"
    );
    assert!(!error.contains('\n'), "control chars flattened: {error}");
    assert!(!error.contains("sk-super-secret"), "key never in errors");
    assert_eq!(captured.lock().unwrap().len(), 2, "one retry, then give up");
    let got: Vec<String> = resp
        .opportunities
        .iter()
        .map(|o| o.opportunity.id.clone())
        .collect();
    assert_eq!(got, ids, "fallback list is the untouched heuristic order");
}

#[test]
fn timeout_falls_back_to_heuristic_with_error() {
    let mut s = seeded_session();
    let (base, _) = stub_provider(Box::new(|_| {
        std::thread::sleep(Duration::from_secs(5));
        (200, completion("{\"order\":[]}"))
    }));
    // 1s client timeout (configurable exactly so this test runs fast).
    set_config(&mut s, cfg(&base, "stub-1", None, Some(1)));
    let started = std::time::Instant::now();
    let resp = rank_next_moves(&mut s);
    assert!(
        started.elapsed() < Duration::from_secs(4),
        "timeout not honored"
    );
    assert_eq!(resp.engine, "heuristic");
    assert!(resp.error.is_some(), "timeout must surface an error");
    assert!(
        !resp.error.unwrap().contains("test-key"),
        "error text must never carry key material"
    );
}

#[test]
fn unconfigured_rank_is_plain_heuristic_without_error() {
    let mut s = seeded_session();
    let ids = heuristic_ids(&mut s);
    let resp = rank_next_moves(&mut s);
    assert_eq!(resp.engine, "heuristic");
    assert_eq!(resp.error, None);
    let got: Vec<String> = resp
        .opportunities
        .iter()
        .map(|o| o.opportunity.id.clone())
        .collect();
    assert_eq!(got, ids);
    let public = config_public(&s);
    assert!(!public.configured && !public.has_key);
}

#[test]
fn fenced_reply_is_unfenced_before_parsing() {
    let mut s = seeded_session();
    let ids = heuristic_ids(&mut s);
    let first = ids.last().unwrap().clone();
    let content = format!("```json\n{{\"order\": [\"{first}\"]}}\n```");
    let (base, _) = stub_provider(Box::new(move |_| (200, completion(&content))));
    set_config(&mut s, cfg(&base, "stub-1", None, None));
    let resp = rank_next_moves(&mut s);
    assert_eq!(resp.engine, "model");
    assert_eq!(resp.opportunities[0].opportunity.id, first);
}

#[test]
fn prose_wrapped_json_is_salvaged_and_reorder_respected() {
    // "Sure! … {valid JSON} … Let me know!" — the chatty-small-model shape.
    let mut s = seeded_session();
    let ids = heuristic_ids(&mut s);
    let first = ids.last().unwrap().clone();
    let content = format!(
        "Sure! Here is my ranking: {{\"order\": [\"{first}\"]}} Let me know if you need more."
    );
    let (base, _) = stub_provider(Box::new(move |_| (200, completion(&content))));
    set_config(&mut s, cfg(&base, "stub-1", None, None));
    let resp = rank_next_moves(&mut s);
    assert_eq!(resp.engine, "model", "salvage must win: {:?}", resp.error);
    assert_eq!(resp.error, None);
    assert_eq!(resp.opportunities[0].opportunity.id, first);
}

#[test]
fn trailing_garbage_after_the_json_is_ignored() {
    // The stream deserializer parses ONE complete value and stops — a
    // first-'{'/last-'}' window would choke on the trailing "bye :}".
    let mut s = seeded_session();
    let ids = heuristic_ids(&mut s);
    let first = ids.last().unwrap().clone();
    let content = format!("{{\"order\": [\"{first}\"]}} bye :}}");
    let (base, _) = stub_provider(Box::new(move |_| (200, completion(&content))));
    set_config(&mut s, cfg(&base, "stub-1", None, None));
    let resp = rank_next_moves(&mut s);
    assert_eq!(resp.engine, "model", "{:?}", resp.error);
    assert_eq!(resp.opportunities[0].opportunity.id, first);
}

#[test]
fn empty_object_in_prose_is_a_schema_failure() {
    // "{}" parses, but carries zero model content — shipping it as
    // engine:"model" would be a silent no-op wearing the AI badge.
    let mut s = seeded_session();
    let ids = heuristic_ids(&mut s);
    let (base, _) = stub_provider(Box::new(|_| {
        (
            200,
            completion("I could not rank these, so here is {} for you."),
        )
    }));
    set_config(&mut s, cfg(&base, "stub-1", None, None));
    let resp = rank_next_moves(&mut s);
    assert_eq!(resp.engine, "heuristic");
    assert_eq!(
        resp.error.as_deref(),
        Some("model reply did not match the rank schema")
    );
    let got: Vec<String> = resp
        .opportunities
        .iter()
        .map(|o| o.opportunity.id.clone())
        .collect();
    assert_eq!(got, ids);
}

#[test]
fn structurally_unrelated_json_is_a_schema_failure() {
    // Valid JSON, none of the rank fields → every field defaults to empty →
    // schema failure, not a fake model ranking.
    let mut s = seeded_session();
    let (base, _) = stub_provider(Box::new(|_| {
        (
            200,
            completion("{\"weather\": \"sunny\", \"advice\": [\"build more\"]}"),
        )
    }));
    set_config(&mut s, cfg(&base, "stub-1", None, None));
    let resp = rank_next_moves(&mut s);
    assert_eq!(resp.engine, "heuristic");
    assert_eq!(
        resp.error.as_deref(),
        Some("model reply did not match the rank schema")
    );
}

#[test]
fn zero_candidates_skip_the_provider_call() {
    // Configured but nothing to rank: honest silence must not spend a call.
    let mut s = Session::in_memory(None).unwrap();
    s.ai = AiConfig::from_lookup(|_| None);
    let (base, captured) = stub_provider(Box::new(|_| (200, completion("{\"order\":[]}"))));
    set_config(&mut s, cfg(&base, "stub-1", None, None));
    assert!(
        s.next_moves().is_empty(),
        "empty plan must have no candidates"
    );
    let resp = rank_next_moves(&mut s);
    assert_eq!(resp.engine, "heuristic");
    assert_eq!(resp.error, None);
    assert!(resp.opportunities.is_empty());
    assert!(
        captured.lock().unwrap().is_empty(),
        "no provider call for zero candidates"
    );
}

#[test]
fn keyless_call_sends_no_authorization_header() {
    // Ollama / LM Studio run keyless: the header must be absent, not blank.
    let mut s = seeded_session();
    let ids = heuristic_ids(&mut s);
    let first = ids.last().unwrap().clone();
    let content = format!("{{\"order\": [\"{first}\"]}}");
    let (base, captured) = stub_provider(Box::new(move |_| (200, completion(&content))));
    set_config(&mut s, cfg(&base, "stub-1", None, None));
    let resp = rank_next_moves(&mut s);
    assert_eq!(resp.engine, "model");
    let requests = captured.lock().unwrap();
    assert!(
        !requests[0].to_ascii_lowercase().contains("authorization:"),
        "keyless config must not send an Authorization header"
    );
}
