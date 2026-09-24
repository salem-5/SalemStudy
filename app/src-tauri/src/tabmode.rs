use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, Notify};

pub const HOST: &str = "127.0.0.1";
const FIRST_PORT: u16 = 8790;
const PORT_TRIES: u16 = 12;
const RPC_TIMEOUT: Duration = Duration::from_secs(900);
const POLL_TIMEOUT: Duration = Duration::from_secs(25);
const EVENT_BACKLOG: usize = 512;
const RPC_BODY_LIMIT: usize = 300 * 1024 * 1024;

#[derive(Clone)]
struct Server {
    app: AppHandle,
    token: String,
}

struct Running {
    port: u16,
    token: String,
    shutdown: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
pub struct TabMode {
    running: Mutex<Option<Running>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    feed: Mutex<Feed>,
    arrived: Arc<Notify>,
}

#[derive(Default)]
struct Feed {
    next_seq: u64,
    events: std::collections::VecDeque<(u64, Value)>,
}

impl Feed {
    fn push(&mut self, event: Value) {
        self.next_seq += 1;
        self.events.push_back((self.next_seq, event));
        while self.events.len() > EVENT_BACKLOG {
            self.events.pop_front();
        }
    }

    fn poll(&self, since: u64) -> (Vec<Value>, u64, bool) {
        if since == 0 {
            return (Vec::new(), self.next_seq, false);
        }
        self.since(since)
    }

    fn clear(&mut self) {
        self.events.clear();
    }

    fn since(&self, since: u64) -> (Vec<Value>, u64, bool) {
        let oldest = self.events.front().map(|(seq, _)| *seq).unwrap_or(self.next_seq + 1);
        let missed = since > 0 && since + 1 < oldest;
        let out: Vec<Value> = self.events.iter().filter(|(seq, _)| *seq > since).map(|(_, e)| e.clone()).collect();
        (out, self.next_seq, missed)
    }
}

pub fn notify(app: &AppHandle, event: &str, payload: Value) {
    let _ = app.emit(event, payload.clone());
    let Some(state) = app.try_state::<TabMode>() else { return };
    if state.running.lock().map(|r| r.is_none()).unwrap_or(true) {
        return;
    }
    if let Ok(mut feed) = state.feed.lock() {
        feed.push(json!({ "event": event, "payload": payload }));
    }
    state.arrived.notify_waiters();
}

fn router(server: Server) -> Router {
    Router::new()
        .route("/salem/rpc", post(rpc).layer(DefaultBodyLimit::max(RPC_BODY_LIMIT)))
        .route("/salem/events", get(events))
        .route("/salem/ping", get(ping))
        .fallback(asset)
        .with_state(server)
}

fn from_a_website(headers: &HeaderMap) -> bool {
    headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(|origin| !origin.starts_with("http://127.0.0.1") && !origin.starts_with("http://localhost"))
        .unwrap_or(false)
}

fn authorised(token: &str, headers: &HeaderMap) -> bool {
    if from_a_website(headers) {
        return false;
    }
    let given = headers
        .get("x-salem-token")
        .and_then(|v| v.to_str().ok())
        .or_else(|| {
            headers
                .get(header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
        })
        .unwrap_or("");
    let expected = token.as_bytes();
    let given = given.as_bytes();
    given.len() == expected.len() && given.iter().zip(expected).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

fn denied() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({ "error": "This needs the token from the app." }))).into_response()
}

async fn ping(State(server): State<Server>, headers: HeaderMap) -> Response {
    if !authorised(&server.token, &headers) {
        return denied();
    }
    Json(json!({ "ok": true, "app": "salem" })).into_response()
}

async fn rpc(State(server): State<Server>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    if !authorised(&server.token, &headers) {
        return denied();
    }
    let cmd = body.get("cmd").and_then(Value::as_str).unwrap_or("").to_string();
    if cmd.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "no command given" }))).into_response();
    }
    let args = body.get("args").cloned().unwrap_or_else(|| json!({}));

    let state = server.app.state::<TabMode>();
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(id, tx);

    if server.app.emit("tabmode://rpc", json!({ "id": id, "cmd": cmd, "args": args })).is_err() {
        state.pending.lock().unwrap().remove(&id);
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "the Salem window is not available" }))).into_response();
    }

    match tokio::time::timeout(RPC_TIMEOUT, rx).await {
        Ok(Ok(Ok(value))) => Json(json!({ "ok": true, "data": value })).into_response(),
        Ok(Ok(Err(error))) => Json(json!({ "ok": false, "error": error })).into_response(),
        Ok(Err(_)) => {
            (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "the Salem window stopped answering" }))).into_response()
        }
        Err(_) => {
            server.app.state::<TabMode>().pending.lock().unwrap().remove(&id);
            (StatusCode::GATEWAY_TIMEOUT, Json(json!({ "error": format!("{cmd} took too long") }))).into_response()
        }
    }
}

async fn events(
    State(server): State<Server>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if !authorised(&server.token, &headers) {
        return denied();
    }
    let since: u64 = query.get("since").and_then(|s| s.parse().ok()).unwrap_or(0);
    let state = server.app.state::<TabMode>();
    let arrived = state.arrived.clone();

    let answer = |state: &TabMode| {
        let feed = state.feed.lock().unwrap();
        let (events, seq, missed) = feed.poll(since);
        (events, seq, missed)
    };

    let (mut events, mut seq, missed) = answer(&state);
    if events.is_empty() && !missed && since > 0 {
        let _ = tokio::time::timeout(POLL_TIMEOUT, arrived.notified()).await;
        let fresh = answer(&state);
        events = fresh.0;
        seq = fresh.1;
    }
    Json(json!({ "events": events, "seq": seq, "missed": missed })).into_response()
}

async fn asset(State(server): State<Server>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let wanted = if path.is_empty() { "index.html" } else { path };
    let resolver = server.app.asset_resolver();
    let found = resolver.get(wanted.to_string()).or_else(|| resolver.get("index.html".into()));
    let Some(found) = found else {
        return (StatusCode::NOT_FOUND, "Salem's interface is not bundled in this build.").into_response();
    };
    let mime = found.mime_type.clone();
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(found.bytes))
        .unwrap();
    response.headers_mut().insert("x-salem-tab", "1".parse().unwrap());
    response
}

fn make_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the operating system has no randomness");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[tauri::command]
pub fn tab_mode_status(app: AppHandle) -> Value {
    let state = app.state::<TabMode>();
    let running = state.running.lock().unwrap();
    match running.as_ref() {
        Some(r) => json!({
            "running": true,
            "port": r.port,
            "url": format!("http://{HOST}:{}/?t={}", r.port, r.token),
            "origin": format!("http://{HOST}:{}", r.port),
        }),
        None => json!({ "running": false, "port": Value::Null, "url": Value::Null, "origin": Value::Null }),
    }
}

#[tauri::command]
pub fn tab_mode_start(app: AppHandle) -> Result<Value, String> {
    {
        let state = app.state::<TabMode>();
        if state.running.lock().unwrap().is_some() {
            return Ok(tab_mode_status(app.clone()));
        }
    }
    let token = make_token();
    let mut bound = None;
    let mut last = String::new();
    for port in FIRST_PORT..FIRST_PORT + PORT_TRIES {
        match std::net::TcpListener::bind((HOST, port)) {
            Ok(listener) => {
                bound = Some((listener, port));
                break;
            }
            Err(e) => last = e.to_string(),
        }
    }
    let Some((listener, port)) = bound else {
        return Err(format!("Could not open a port for tab mode ({last})."));
    };
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    let (stop_tx, stop_rx) = oneshot::channel();
    let server = Server { app: app.clone(), token: token.clone() };
    let routes = router(server);
    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => {
                let _ = axum::serve(listener, routes)
                    .with_graceful_shutdown(async { let _ = stop_rx.await; })
                    .await;
            }
            Err(e) => eprintln!("[tab mode] could not start: {e}"),
        }
    });

    {
        let state = app.state::<TabMode>();
        if let Ok(mut feed) = state.feed.lock() { feed.clear(); }
        *state.running.lock().unwrap() = Some(Running { port, token, shutdown: Some(stop_tx) });
    }
    Ok(tab_mode_status(app))
}

#[tauri::command]
pub fn tab_mode_stop(app: AppHandle) -> Value {
    {
        let state = app.state::<TabMode>();
        if let Ok(mut feed) = state.feed.lock() {
            feed.push(json!({ "event": "tabmode://closed", "payload": {} }));
        }
        state.arrived.notify_waiters();
        let taken = state.running.lock().unwrap().take();
        if let Some(mut running) = taken {
            if let Some(stop) = running.shutdown.take() {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(1500)).await;
                    let _ = stop.send(());
                });
            }
        }
    }
    tab_mode_status(app)
}

#[tauri::command]
pub fn tab_mode_reply(app: AppHandle, id: u64, ok: bool, data: Option<Value>, error: Option<String>) {
    let waiting = app.state::<TabMode>().pending.lock().unwrap().remove(&id);
    if let Some(reply) = waiting {
        let _ = reply.send(if ok {
            Ok(data.unwrap_or(Value::Null))
        } else {
            Err(error.unwrap_or_else(|| "the command failed".into()))
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        map
    }

    #[test]
    fn a_token_is_long_and_never_repeats() {
        let a = make_token();
        let b = make_token();
        assert!(a.len() >= 40, "a guessable token is no protection: {a}");
        assert_ne!(a, b);
    }

    #[test]
    fn a_page_on_the_web_is_refused() {
        assert!(from_a_website(&headers(&[("origin", "https://example.com")])));
        assert!(from_a_website(&headers(&[("origin", "http://evil.test")])));
        assert!(!from_a_website(&headers(&[("origin", "http://127.0.0.1:8790")])));
        assert!(!from_a_website(&HeaderMap::new()));
    }

    #[test]
    fn only_the_exact_token_gets_in() {
        let token = "secret-token";
        assert!(authorised(token, &headers(&[("x-salem-token", token)])));
        assert!(authorised(token, &headers(&[("authorization", "Bearer secret-token")])));
        assert!(!authorised(token, &headers(&[("x-salem-token", "secret-toke")])), "a prefix must not pass");
        assert!(!authorised(token, &headers(&[("x-salem-token", "secret-tokenX")])));
        assert!(!authorised(token, &headers(&[("x-salem-token", "")])));
        assert!(!authorised(token, &HeaderMap::new()));
        assert!(!authorised(token, &headers(&[("x-salem-token", token), ("origin", "https://example.com")])));
    }

    #[test]
    fn the_feed_replays_only_what_a_tab_has_not_seen() {
        let mut feed = Feed::default();
        for i in 0..3 {
            feed.push(json!({ "event": "salem://event", "payload": { "n": i } }));
        }
        let (all, seq, missed) = feed.since(0);
        assert_eq!(all.len(), 3);
        assert_eq!(seq, 3);
        assert!(!missed);

        let (rest, _, _) = feed.since(2);
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0]["payload"]["n"], 2);

        assert!(feed.since(3).0.is_empty(), "a tab that is up to date gets nothing");
    }

    #[test]
    fn a_new_session_does_not_hand_its_tabs_the_last_ones_goodbye() {
        let mut feed = Feed::default();
        feed.push(json!({ "event": "ai://stream", "payload": {} }));
        feed.push(json!({ "event": "tabmode://closed", "payload": {} }));
        feed.clear();
        let (first, seq, missed) = feed.poll(0);
        assert!(first.is_empty(), "a new tab must not be told the old session closed");
        assert_eq!(seq, 2, "sequence numbers keep counting up");
        assert!(!missed);
        feed.push(json!({ "event": "prefs://changed", "payload": {} }));
        let (next, _, _) = feed.poll(seq);
        assert_eq!(next.len(), 1);
        assert_eq!(next[0]["event"], "prefs://changed");
    }

    #[test]
    fn a_tab_that_fell_too_far_behind_is_told_so() {
        let mut feed = Feed::default();
        for i in 0..(EVENT_BACKLOG + 10) {
            feed.push(json!({ "n": i }));
        }
        let (_, _, missed) = feed.since(1);
        assert!(missed, "a gap must be reported, not silently skipped");
        let (_, _, fresh) = feed.since(feed.next_seq - 1);
        assert!(!fresh);
    }

    #[test]
    fn the_backlog_does_not_grow_without_bound() {
        let mut feed = Feed::default();
        for i in 0..(EVENT_BACKLOG * 3) {
            feed.push(json!({ "n": i }));
        }
        assert_eq!(feed.events.len(), EVENT_BACKLOG);
    }
}
