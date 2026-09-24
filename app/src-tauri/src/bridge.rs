use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::sync::oneshot;

pub const HOST: &str = "127.0.0.1";
pub const PORT: u16 = 8787;

const POLL_HOLD: Duration = Duration::from_secs(25);
const JOB_TIMEOUT: Duration = Duration::from_secs(90);
const CONNECT_GRACE: Duration = Duration::from_secs(40);
const LOG_LINES: usize = 200;

static SEQ: AtomicU64 = AtomicU64::new(0);

fn new_id(prefix: &str) -> String {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{prefix}{t:x}{n:x}")
}

struct Pending {
    tx: oneshot::Sender<Value>,
}

struct Poller {
    id: u64,
    tx: oneshot::Sender<Value>,
}

#[derive(Default)]
struct Inner {
    queue: VecDeque<Value>,
    pending: HashMap<String, Pending>,
    pollers: Vec<Poller>,
    last_poll: Option<Instant>,
    last_page: Option<String>,
    script_version: Option<String>,
    log: VecDeque<String>,
    error: Option<String>,
}

#[derive(Clone, Default)]
pub struct Bridge {
    inner: Arc<Mutex<Inner>>,
}

impl Bridge {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn log(&self, line: impl Into<String>) {
        let mut i = self.inner.lock().unwrap();
        if i.log.len() >= LOG_LINES {
            i.log.pop_front();
        }
        i.log.push_back(line.into());
    }

    pub fn set_error(&self, e: impl Into<String>) {
        self.inner.lock().unwrap().error = Some(e.into());
    }

    pub fn error(&self) -> Option<String> {
        self.inner.lock().unwrap().error.clone()
    }

    pub fn log_lines(&self) -> Vec<String> {
        self.inner.lock().unwrap().log.iter().cloned().collect()
    }

    fn is_connected(inner: &Inner) -> bool {
        inner.last_poll.map(|t| t.elapsed() < CONNECT_GRACE).unwrap_or(false)
    }

    pub fn connected(&self) -> bool {
        Self::is_connected(&self.inner.lock().unwrap())
    }

    fn status(&self) -> Value {
        let i = self.inner.lock().unwrap();
        let connected = Self::is_connected(&i);
        json!({
            "connected": connected,
            "lastPollAgoMs": i.last_poll.map(|t| t.elapsed().as_millis() as u64),
            "page": i.last_page,
            "userscriptVersion": if connected { i.script_version.clone() } else { None },
            "queued": i.queue.len(),
            "inFlight": i.pending.len(),
        })
    }

    fn hand_out(inner: &mut Inner, job: Value) {
        while let Some(p) = inner.pollers.pop() {
            if p.tx.send(job.clone()).is_ok() {
                return;
            }
        }
        inner.queue.push_back(job);
    }

    pub async fn run_job(&self, action: &str, params: Value) -> Result<Value, (u16, String)> {
        if !self.connected() {
            return Err((
                503,
                "No WebAssign tab connected. Open webassign.net (logged in) with the userscript enabled.".into(),
            ));
        }
        let id = new_id("job");
        let (tx, rx) = oneshot::channel();
        {
            let mut i = self.inner.lock().unwrap();
            i.pending.insert(id.clone(), Pending { tx });
            Self::hand_out(&mut i, json!({ "id": id, "action": action, "params": params }));
        }
        match tokio::time::timeout(JOB_TIMEOUT, rx).await {
            Ok(Ok(v)) => {
                if v.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                    Ok(v.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    let status = v.get("status").and_then(Value::as_u64).unwrap_or(500) as u16;
                    let error = v
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("The browser reported an error.")
                        .to_string();
                    Err((status, error))
                }
            }
            _ => {
                let mut i = self.inner.lock().unwrap();
                i.pending.remove(&id);
                i.queue.retain(|j| j.get("id").and_then(Value::as_str) != Some(id.as_str()));
                Err((504, "The browser did not answer in time.".into()))
            }
        }
    }

    pub async fn handle_api(
        &self,
        method: &str,
        path: &str,
        query: &HashMap<String, String>,
        body: Value,
    ) -> Result<Value, (u16, String)> {
        let segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        let flag = |k: &str| query.get(k).map(|v| v == "1" || v == "true").unwrap_or(false);
        let answers = || body.get("answers").cloned().unwrap_or(Value::Null);
        match (method, segs.as_slice()) {
            ("GET", ["api", "status"]) => Ok(self.status()),
            ("GET", ["api", "courses"]) => self.run_job("courses", json!({})).await,
            ("GET", ["api", "assignments"]) => {
                self.run_job(
                    "assignments",
                    json!({ "section": query.get("section"), "course": query.get("course") }),
                )
                .await
            }
            ("GET", ["api", "assignments", dep]) => {
                self.run_job("assignment", json!({ "dep": dep, "html": flag("html") })).await
            }
            ("GET", ["api", "assignments", dep, "styles"]) => {
                self.run_job("styles", json!({ "dep": dep })).await
            }
            ("GET", ["api", "assignments", dep, "questions", n]) => {
                self.run_job("question", json!({ "dep": dep, "n": n, "html": flag("html") })).await
            }
            ("POST", ["api", "assignments", dep, "questions", n, "save"]) => {
                self.run_job("save", json!({ "dep": dep, "n": n, "answers": answers() })).await
            }
            ("POST", ["api", "assignments", dep, "questions", n, "submit"]) => {
                let dry = flag("dryRun") || body.get("dryRun").and_then(Value::as_bool).unwrap_or(false);
                self.run_job(
                    "submit",
                    json!({ "dep": dep, "n": n, "answers": answers(), "dryRun": dry }),
                )
                .await
            }
            ("POST", ["api", "mathml"]) => {
                let expr = body.get("expr").cloned().unwrap_or(Value::Null);
                if !expr.is_string() {
                    return Err((400, "Body must be {\"expr\": \"...\"}".into()));
                }
                self.run_job("mathml", json!({ "expr": expr })).await
            }
            _ => Err((404, format!("No route {method} {path}"))),
        }
    }
}

pub fn router(bridge: Bridge) -> Router {
    Router::new()
        .route("/_bridge/poll", get(poll))
        .route("/_bridge/result", post(result))
        .fallback(dispatch)
        .with_state(bridge)
}

fn forbidden(headers: &HeaderMap) -> bool {
    headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(|o| o.starts_with("http://") || o.starts_with("https://"))
        .unwrap_or(false)
}

fn refuse() -> Response {
    (StatusCode::FORBIDDEN, Json(json!({ "error": "Browser pages may not use this bridge." }))).into_response()
}

async fn poll(
    State(bridge): State<Bridge>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if forbidden(&headers) {
        return refuse();
    }
    enum Decision {
        Job(Value),
        Park(oneshot::Receiver<Value>, u64),
    }
    let decision = {
        let mut i = bridge.inner.lock().unwrap();
        i.last_poll = Some(Instant::now());
        if let Some(p) = q.get("page") {
            i.last_page = Some(p.clone());
        }
        i.script_version = q.get("v").cloned();
        if let Some(job) = i.queue.pop_front() {
            Decision::Job(job)
        } else {
            let id = SEQ.fetch_add(1, Ordering::Relaxed);
            let (tx, rx) = oneshot::channel();
            i.pollers.push(Poller { id, tx });
            Decision::Park(rx, id)
        }
    };
    match decision {
        Decision::Job(job) => Json(job).into_response(),
        Decision::Park(rx, id) => match tokio::time::timeout(POLL_HOLD, rx).await {
            Ok(Ok(job)) => Json(job).into_response(),
            _ => {
                bridge.inner.lock().unwrap().pollers.retain(|p| p.id != id);
                StatusCode::NO_CONTENT.into_response()
            }
        },
    }
}

async fn result(State(bridge): State<Bridge>, headers: HeaderMap, body: Bytes) -> Response {
    if forbidden(&headers) {
        return refuse();
    }
    if let Ok(v) = serde_json::from_slice::<Value>(&body) {
        if let Some(id) = v.get("id").and_then(Value::as_str) {
            let mut i = bridge.inner.lock().unwrap();
            i.last_poll = Some(Instant::now());
            if let Some(p) = i.pending.remove(id) {
                let _ = p.tx.send(v);
            }
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn dispatch(
    State(bridge): State<Bridge>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if forbidden(&headers) {
        return refuse();
    }
    let path = uri.path().to_string();
    let query = parse_query(uri.query().unwrap_or(""));
    let body: Value = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&body).unwrap_or(Value::Null)
    };
    match bridge.handle_api(method.as_str(), &path, &query, body).await {
        Ok(v) => Json(v).into_response(),
        Err((status, error)) => (
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(json!({ "error": error })),
        )
            .into_response(),
    }
}

pub fn parse_query(q: &str) -> HashMap<String, String> {
    q.split('&')
        .filter(|s| !s.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (urldecode(k), urldecode(v))
        })
        .collect()
}

fn hexval(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match (hexval(bytes[i + 1]), hexval(bytes[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 3;
                }
                _ => {
                    out.push(bytes[i]);
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn spawn_logger(bridge: Bridge) {
    std::thread::spawn(move || {
        let mut was = false;
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let now = bridge.connected();
            if now != was {
                bridge.log(if now { "browser connected".to_string() } else { "browser disconnected".to_string() });
                was = now;
            }
        }
    });
}
