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
    apply_model_ranking, config_public, rank_next_moves, set_config, AiConfigUpdate, ModelReply,
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
    assert_eq!(headline.unwrap().chars().count(), 240);
    assert_eq!(ranked[0].note.as_ref().unwrap().chars().count(), 240);
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
fn config_get_never_echoes_the_key() {
    let mut s = Session::in_memory(None).unwrap();
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
    let (base, _) = stub_provider(Box::new(|_| (500, "{\"error\":\"boom\"}".into())));
    set_config(&mut s, cfg(&base, "stub-1", None, None));
    let resp = rank_next_moves(&mut s);
    assert_eq!(resp.engine, "heuristic");
    assert_eq!(
        resp.error.as_deref(),
        Some("model endpoint returned HTTP 500")
    );
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
