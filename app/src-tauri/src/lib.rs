//! WebAssign Desk backend.
//!
//! The WebAssign bridge runs in-process (see `bridge.rs`); there is no Node
//! child process. `/api/*` calls from the webview are dispatched straight to
//! the bridge, while the userscript still talks to it over HTTP on 127.0.0.1.

mod bridge;
mod data;
mod python;
mod salem;
mod study;
mod prefs;
mod providers;
mod tabmode;
mod tray;
mod web;

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use bridge::Bridge;

/// The typesetter, shipped with the binary and written into each job's
/// folder so an export never depends on anything outside the app.
const PDF_RENDERER: &str = include_str!("../python/salem_pdf.py");

pub(crate) const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
const DEFAULT_FLASH_MODEL: &str = "deepseek-flash";
const DEFAULT_PRO_MODEL: &str = "deepseek-v4-pro";

/// AI settings, kept in a JSON file under the app config dir so the key never
/// has to live in the webview or the repo.
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Config {
    pub(crate) api_key: String,
    pub(crate) flash_model: String,
    pro_model: String,
    base_url: String,
    max_attempts: u32,
    pause_after: u32,
    /// How hard the model reasons before it answers: "low", "high" or "max".
    /// The API's own default is "high", which buys little on the short
    /// tool-choosing steps an agent spends most of its time on and costs real
    /// seconds on every one of them.
    effort: String,
    /// Let the solver call the sandboxed `run_python` tool (see python.rs).
    pub python_enabled: bool,
    /// Always reach for Python on a question that involves calculation.
    python_auto: bool,
    /// Interpreter override; empty means the app's managed virtualenv.
    pub python_path: String,
    /// Seconds a single snippet may run before it is stopped.
    pub python_timeout: u32,
    pub python_memory_mb: u32,
    /// Snippets the model may run per solve attempt.
    python_max_calls: u32,
    /// Closing the window hides it to the tray instead of quitting, so tab
    /// mode (and anything running) carries on.
    pub(crate) close_to_tray: bool,
    /// Which provider answers (a models.dev id, or "ollama"). DeepSeek by
    /// default, which is what the app spoke before there were others.
    pub(crate) provider: String,
    /// An API key per provider, so switching back and forth keeps them.
    pub(crate) keys: std::collections::HashMap<String, String>,
    /// Price and limits of the chosen models, from the catalogue.
    pub(crate) models_info: std::collections::HashMap<String, providers::ModelInfo>,
    /// How much context Ollama gives a local model (tokens).
    pub(crate) ollama_ctx: u32,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            api_key: String::new(),
            flash_model: DEFAULT_FLASH_MODEL.into(),
            pro_model: DEFAULT_PRO_MODEL.into(),
            base_url: DEFAULT_BASE_URL.into(),
            max_attempts: 4,
            pause_after: 2,
            effort: "low".into(),
            python_enabled: true,
            python_auto: true,
            python_path: String::new(),
            python_timeout: 25,
            python_memory_mb: 4096,
            python_max_calls: 6,
            close_to_tray: true,
            provider: providers::DEEPSEEK.into(),
            keys: Default::default(),
            models_info: Default::default(),
            ollama_ctx: providers::OLLAMA_CTX,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigPatch {
    api_key: Option<String>,
    flash_model: Option<String>,
    pro_model: Option<String>,
    base_url: Option<String>,
    max_attempts: Option<u32>,
    pause_after: Option<u32>,
    effort: Option<String>,
    python_enabled: Option<bool>,
    python_auto: Option<bool>,
    python_path: Option<String>,
    python_timeout: Option<u32>,
    python_memory_mb: Option<u32>,
    python_max_calls: Option<u32>,
    close_to_tray: Option<bool>,
    provider: Option<String>,
    /// Which provider `api_key` is for; the current one when left out.
    key_provider: Option<String>,
    models_info: Option<std::collections::HashMap<String, providers::ModelInfo>>,
    ollama_ctx: Option<u32>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create config dir: {e}"))?;
    Ok(dir.join("config.json"))
}

pub fn read_config(app: &AppHandle) -> Config {
    let Ok(path) = config_path(app) else { return Config::default() };
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub(crate) fn write_config(app: &AppHandle, cfg: &Config) -> Result<(), String> {
    let path = config_path(app)?;
    let body = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, body).map_err(|e| format!("cannot write config: {e}"))
}

pub(crate) struct AppState {
    bridge: Bridge,
    http: reqwest::Client,
    /// Separate client: thinking-model replies can take several minutes.
    deepseek: reqwest::Client,
    /// Controls for in-flight LaTeX exports. Several run at once, and they
    /// share the pause/cancel switches: the dialog's buttons stop the batch.
    export_pause: Arc<AtomicBool>,
    export_cancel: Arc<AtomicBool>,
    /// Exports currently running, so only the first one of a batch clears the
    /// switches that a later Cancel sets.
    export_active: Arc<AtomicUsize>,
    /// Stream ids the user stopped; `deepseek_stream` checks between chunks.
    cancelled_streams: std::sync::Mutex<std::collections::HashSet<String>>,
}

/// `/api/*` for the webview. Dispatches straight to the in-process bridge, so
/// no loopback HTTP round-trip is needed.
#[tauri::command]
async fn api(
    state: State<'_, AppState>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, Value> {
    if !(path == "/api" || path.starts_with("/api/")) {
        return Err(json!({"status": 400, "error": "Only /api/* paths are allowed"}));
    }
    let (path_only, query_str) = path.split_once('?').unwrap_or((path.as_str(), ""));
    let query = bridge::parse_query(query_str);
    match state
        .bridge
        .handle_api(&method, path_only, &query, body.unwrap_or_else(|| json!({})))
        .await
    {
        Ok(v) => Ok(v),
        Err((status, error)) => Err(json!({"status": status, "error": error})),
    }
}

/// Fetch a WebAssign image and return it as a data URL. WebAssign sends no CORS
/// headers, so the webview can't read image pixels itself; with a data URL the
/// UI can check whether a figure has a light background and needs dark-mode
/// treatment. Only https webassign.net URLs are allowed.
#[tauri::command]
async fn fetch_image(state: State<'_, AppState>, url: String) -> Result<String, String> {
    const MAX_BYTES: usize = 8 * 1024 * 1024;
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("bad url: {e}"))?;
    let allowed = parsed.scheme() == "https"
        && matches!(parsed.host_str(), Some(h) if h == "webassign.net" || h.ends_with(".webassign.net"));
    if !allowed {
        return Err("only https://*.webassign.net images can be fetched".into());
    }
    let resp = state.http.get(parsed).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .split(';')
        .next()
        .unwrap_or("image/png")
        .trim()
        .to_string();
    if !mime.starts_with("image/") {
        return Err(format!("not an image ({mime})"));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("image too large".into());
    }
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

#[tauri::command]
fn get_config(app: AppHandle) -> Value {
    let c = read_config(&app);
    let provider = providers::provider_of(&c);
    let key = providers::key_for(&c, &provider);
    let chars: Vec<char> = key.chars().collect();
    let hint = if chars.len() > 10 {
        let head: String = chars[..6].iter().collect();
        let tail: String = chars[chars.len() - 4..].iter().collect();
        format!("{head}…{tail}")
    } else if chars.is_empty() {
        String::new()
    } else {
        "set".into()
    };
    json!({
        "provider": provider,
        "hasKey": !key.is_empty() || provider == providers::OLLAMA,
        "keyed": c.keys.iter().filter(|(_, v)| !v.is_empty()).map(|(k, _)| k.clone())
            .chain((!c.api_key.is_empty()).then(|| providers::DEEPSEEK.to_string()))
            .collect::<std::collections::BTreeSet<_>>(),
        "keyHint": hint,
        "flashModel": c.flash_model,
        "proModel": c.pro_model,
        "baseUrl": c.base_url,
        "maxAttempts": c.max_attempts,
        "pauseAfter": c.pause_after,
        "effort": c.effort,
        "pythonEnabled": c.python_enabled,
        "pythonAuto": c.python_auto,
        "pythonPath": c.python_path,
        "pythonTimeout": c.python_timeout,
        "pythonMemoryMb": c.python_memory_mb,
        "pythonMaxCalls": c.python_max_calls,
        "closeToTray": c.close_to_tray,
        "ollamaCtx": c.ollama_ctx,
    })
}

#[tauri::command]
fn set_config(app: AppHandle, patch: ConfigPatch) -> Result<Value, String> {
    let mut c = read_config(&app);
    if let Some(v) = patch.provider {
        let v = v.trim().to_string();
        if !v.is_empty() && v != providers::provider_of(&c) {
            c.provider = v;
            // A new provider brings its own endpoint unless one is given.
            if patch.base_url.is_none() { c.base_url = String::new(); }
        }
    }
    if let Some(v) = patch.api_key {
        let for_provider = patch.key_provider.filter(|p| !p.trim().is_empty()).unwrap_or_else(|| providers::provider_of(&c));
        let v = v.trim().to_string();
        if for_provider == providers::DEEPSEEK { c.api_key = v.clone(); }
        if v.is_empty() { c.keys.remove(&for_provider); } else { c.keys.insert(for_provider, v); }
    }
    if let Some(m) = patch.models_info { c.models_info.extend(m); }
    if let Some(n) = patch.ollama_ctx { c.ollama_ctx = n.clamp(2048, 262_144); }
    // Empty clears it: a provider with nothing to pick yet (Ollama with no
    // models pulled) must not keep the last provider's model.
    if let Some(v) = patch.flash_model { c.flash_model = v.trim().to_string(); }
    if let Some(v) = patch.pro_model { c.pro_model = v.trim().to_string(); }
    // Empty means "the provider's own endpoint".
    if let Some(v) = patch.base_url { c.base_url = v.trim().to_string(); }
    if let Some(v) = patch.max_attempts { c.max_attempts = v.clamp(1, 10); }
    if let Some(v) = patch.pause_after { c.pause_after = v.min(10); }
    if let Some(v) = patch.effort {
        let v = v.trim().to_lowercase();
        if ["low", "high", "max"].contains(&v.as_str()) { c.effort = v; }
    }
    if let Some(v) = patch.python_enabled { c.python_enabled = v; }
    if let Some(v) = patch.python_auto { c.python_auto = v; }
    if let Some(v) = patch.python_path { c.python_path = v.trim().to_string(); }
    if let Some(v) = patch.python_timeout { c.python_timeout = v.clamp(1, 180); }
    if let Some(v) = patch.python_memory_mb { c.python_memory_mb = v.clamp(256, 16384); }
    if let Some(v) = patch.python_max_calls { c.python_max_calls = v.clamp(1, 20); }
    if let Some(v) = patch.close_to_tray { c.close_to_tray = v; }
    write_config(&app, &c)?;
    Ok(get_config(app))
}

/// Chat completion against DeepSeek. Images are allowed only for the Flash
/// model, and only inside user messages (DeepSeek's rule). Returns the message
/// content plus any chain-of-thought reasoning.
#[tauri::command]
async fn deepseek_chat(
    state: State<'_, AppState>,
    db: State<'_, study::StudyDb>,
    app: AppHandle,
    feature: Option<String>,
    model: String,
    messages: Value,
    thinking: Option<bool>,
    effort: Option<String>,
    json: Option<bool>,
    tools: Option<Value>,
    choice: Option<Value>,
    id: Option<String>,
) -> Result<Value, String> {
    let c = read_config(&app);
    let ep = providers::endpoint(&c)?;
    let model = providers::resolve_model(&c, &model)?;
    if ep.is_local() {
        providers::ensure_ollama(&app).await?;
        providers::check_ollama_model(&model).await?;
    }
    let url = ep.url("chat/completions");

    let mut body = json!({ "model": model, "messages": messages, "stream": false, "max_tokens": 16384 });
    if let Some(t) = thinking {
        body["thinking"] = json!({ "type": if t { "enabled" } else { "disabled" } });
    }
    if let Some(e) = effort {
        if !e.trim().is_empty() { body["reasoning_effort"] = json!(e.trim()); }
    }
    if json == Some(true) {
        body["response_format"] = json!({ "type": "json_object" });
    }
    if let Some(t) = tools {
        if !t.is_null() { body["tools"] = t; }
    }
    if let Some(ch) = choice {
        if !ch.is_null() { body["tool_choice"] = ch; }
    }
    providers::shape(&ep, &c, &mut body);

    // Everything from here is one piece of work that a Stop can cut short:
    // a deck being stopped must not keep paying for the passes in flight.
    let work = async {
        if ep.is_local() {
            let mut reply = providers::ollama_chat(&state.deepseek, &c, &body, |_, _| {}, || false).await?;
            let used = reply["model"].as_str().unwrap_or(&model).to_string();
            let cost = record_usage(&app, &db, &used, feature.as_deref(), reply.get("usage"));
            reply["cost"] = json!(cost);
            return Ok(reply);
        }

        let resp = providers::send(|| ep.authorise(state.deepseek.post(&url)).json(&body))
            .await
            .map_err(|e| format!("The {} request failed: {e}", ep.provider))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("{} HTTP {}: {}", ep.provider, status.as_u16(), providers::error_text(&text)));
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|_| format!("{} returned HTTP {status}: {}", ep.provider, text.chars().take(600).collect::<String>()))?;

        let cost = record_usage(&app, &db, value.get("model").and_then(Value::as_str).unwrap_or(&model), feature.as_deref(), value.get("usage"));
        let message = value.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("message")).cloned().unwrap_or(Value::Null);
        Ok::<Value, String>(json!({
            "content": message.get("content").and_then(Value::as_str).unwrap_or(""),
            "reasoning": message.get("reasoning_content").and_then(Value::as_str).unwrap_or(""),
            "model": value.get("model").and_then(Value::as_str).unwrap_or(""),
            "usage": value.get("usage").cloned().unwrap_or(Value::Null),
            "tool_calls": message.get("tool_calls").cloned().unwrap_or(Value::Null),
            "cost": cost,
        }))
    };
    match id.filter(|i| !i.is_empty()) {
        Some(id) => tokio::select! {
            r = work => r,
            _ = cancelled(&state, &id) => Err("stopped".into()),
        },
        None => work.await,
    }
}

/// Streamed chat completion: the same request as `deepseek_chat` with
/// `stream: true`. Every text delta is emitted as an `ai://stream` event
/// tagged with `id`, so the chat can show tokens as they arrive; tool calls are
/// reassembled from their fragments. Returns the whole message at the end, in
/// the same shape as `deepseek_chat`. `ai_cancel(id)` stops it mid-stream.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn deepseek_stream(
    state: State<'_, AppState>,
    db: State<'_, study::StudyDb>,
    app: AppHandle,
    feature: Option<String>,
    id: String,
    model: String,
    messages: Value,
    thinking: Option<bool>,
    effort: Option<String>,
    tools: Option<Value>,
    choice: Option<Value>,
) -> Result<Value, String> {
    let c = read_config(&app);
    let ep = providers::endpoint(&c)?;
    let model = providers::resolve_model(&c, &model)?;
    if ep.is_local() {
        providers::ensure_ollama(&app).await?;
        providers::check_ollama_model(&model).await?;
    }
    let url = ep.url("chat/completions");
    let mut body = json!({
        "model": model, "messages": messages, "stream": true, "max_tokens": 16384,
        "stream_options": { "include_usage": true },
    });
    if let Some(t) = thinking {
        body["thinking"] = json!({ "type": if t { "enabled" } else { "disabled" } });
    }
    if let Some(e) = effort {
        if !e.trim().is_empty() { body["reasoning_effort"] = json!(e.trim()); }
    }
    if let Some(t) = tools {
        if !t.is_null() { body["tools"] = t; }
    }
    if let Some(ch) = choice {
        if !ch.is_null() { body["tool_choice"] = ch; }
    }
    providers::shape(&ep, &c, &mut body);

    if ep.is_local() {
        let emit = |content: &str, reasoning: &str| {
            tabmode::notify(&app, "ai://stream", json!({ "id": id, "content": content, "reasoning": reasoning }));
        };
        let stop = || state.cancelled_streams.lock().map(|mut s| s.remove(&id)).unwrap_or(false);
        let mut reply = providers::ollama_chat(&state.deepseek, &c, &body, emit, stop).await?;
        let used = reply["model"].as_str().unwrap_or(&model).to_string();
        let cost = record_usage(&app, &db, &used, feature.as_deref(), reply.get("usage"));
        reply["cost"] = json!(cost);
        return Ok(reply);
    }

    let mut resp = providers::send(|| ep.authorise(state.deepseek.post(&url)).json(&body))
        .await
        .map_err(|e| format!("The {} request failed: {e}", ep.provider))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("{} HTTP {}: {}", ep.provider, status.as_u16(), providers::error_text(&text)));
    }

    let mut acc = StreamAcc::default();
    let mut buf = String::new();
    'read: loop {
        if state.cancelled_streams.lock().map(|mut s| s.remove(&id)).unwrap_or(false) {
            acc.cancelled = true;
            break;
        }
        let chunk = match resp.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => return Err(format!("DeepSeek stream broke off: {e}")),
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim_end_matches('\r').to_string();
            buf.drain(..=nl);
            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                break 'read;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            let (content, reasoning) = acc.absorb(&v);
            if !content.is_empty() || !reasoning.is_empty() {
                // Through tab mode too: a chat in a browser tab reads its reply from
                // these, and without them it got the price and no words.
                tabmode::notify(&app, "ai://stream", json!({ "id": id, "content": content, "reasoning": reasoning }));
            }
        }
    }
    let model_used = if acc.model.is_empty() { model.clone() } else { acc.model.clone() };
    let cost = record_usage(&app, &db, &model_used, feature.as_deref(), Some(&acc.usage));
    let mut reply = acc.finish();
    reply["cost"] = json!(cost);
    Ok(reply)
}

/// Resolves once `ai_cancel` has been called for `id`.
async fn cancelled(state: &AppState, id: &str) {
    loop {
        tokio::time::sleep(Duration::from_millis(150)).await;
        if state.cancelled_streams.lock().map(|mut s| s.remove(id)).unwrap_or(false) {
            return;
        }
    }
}

/// Log a completion's tokens and cost, and return the cost (USD) so the
/// caller can show what that piece of work cost. Usage is bookkeeping: a
/// failure here must never fail the request.
pub(crate) fn record_usage(app: &AppHandle, db: &study::StudyDb, model: &str, feature: Option<&str>, usage: Option<&Value>) -> f64 {
    let Some(u) = usage.filter(|u| u.is_object()) else { return 0.0 };
    let price = providers::price(&read_config(app), model);
    let _ = study::with_db(app, db, |c| study::usage::record(c, model, feature.unwrap_or("other"), u, price));
    study::usage::cost_of(model, u, study::now_ms(), price)
}

/// Stop a streamed completion; the next chunk boundary ends it.
#[tauri::command]
fn ai_cancel(state: State<'_, AppState>, id: String) {
    if let Ok(mut s) = state.cancelled_streams.lock() {
        s.insert(id);
    }
}

/// Pieces of a streamed reply, put back together.
#[derive(Default)]
pub(crate) struct StreamAcc {
    content: String,
    reasoning: String,
    model: String,
    usage: Value,
    /// Tool calls by index: id, name, argument text so far.
    tools: std::collections::BTreeMap<u64, StreamCall>,
    pub(crate) cancelled: bool,
}

/// One tool call as it streams in: its pieces, plus anything else the
/// provider hangs on it. Gemini 3 puts a `thought_signature` in
/// `extra_content`, and refuses the next request (HTTP 400) unless it comes
/// back with the call exactly as it was sent.
#[derive(Default)]
pub(crate) struct StreamCall {
    id: String,
    name: String,
    args: String,
    extra: serde_json::Map<String, Value>,
}

impl StreamAcc {
    /// Fold one SSE chunk in; returns the new content and reasoning text.
    pub(crate) fn absorb(&mut self, v: &Value) -> (String, String) {
        if let Some(m) = v.get("model").and_then(Value::as_str) {
            self.model = m.to_string();
        }
        if let Some(u) = v.get("usage") {
            if !u.is_null() { self.usage = u.clone(); }
        }
        let Some(delta) = v.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("delta")) else {
            return (String::new(), String::new());
        };
        let content = delta.get("content").and_then(Value::as_str).unwrap_or("").to_string();
        // DeepSeek calls it reasoning_content; OpenRouter, Ollama and others, reasoning.
        let reasoning = delta.get("reasoning_content").or_else(|| delta.get("reasoning")).and_then(Value::as_str).unwrap_or("").to_string();
        self.content.push_str(&content);
        self.reasoning.push_str(&reasoning);
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for (pos, call) in calls.iter().enumerate() {
                let index = call.get("index").and_then(Value::as_u64).unwrap_or(pos as u64);
                let entry = self.tools.entry(index).or_default();
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    if !id.is_empty() { entry.id = id.to_string(); }
                }
                if let Some(f) = call.get("function") {
                    if let Some(n) = f.get("name").and_then(Value::as_str) {
                        entry.name.push_str(n);
                    }
                    if let Some(a) = f.get("arguments").and_then(Value::as_str) {
                        entry.args.push_str(a);
                    }
                }
                // Everything else on the call is kept as it came.
                if let Some(obj) = call.as_object() {
                    for (k, v) in obj {
                        if !matches!(k.as_str(), "index" | "id" | "type" | "function") && !v.is_null() {
                            entry.extra.insert(k.clone(), v.clone());
                        }
                    }
                }
            }
        }
        (content, reasoning)
    }

    pub(crate) fn finish(self) -> Value {
        let calls: Vec<Value> = self
            .tools
            .into_values()
            .filter(|c| !c.name.is_empty())
            .map(|c| {
                let mut call = json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": c.args } });
                if let Some(obj) = call.as_object_mut() { obj.extend(c.extra); }
                call
            })
            .collect();
        json!({
            "content": self.content,
            "reasoning": self.reasoning,
            "model": self.model,
            "usage": self.usage,
            "tool_calls": if calls.is_empty() { Value::Null } else { Value::Array(calls) },
            "cancelled": self.cancelled,
        })
    }
}

/// Current DeepSeek account balance (`GET /user/balance`).
#[tauri::command]
async fn deepseek_balance(state: State<'_, AppState>, app: AppHandle) -> Result<Value, String> {
    let c = read_config(&app);
    let ep = providers::endpoint(&c)?;
    if ep.provider != providers::DEEPSEEK {
        return Err("Only DeepSeek reports a balance.".into());
    }
    let url = ep.url("user/balance");
    let resp = ep
        .authorise(state.deepseek.get(&url))
        .send()
        .await
        .map_err(|e| format!("DeepSeek request failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| format!("DeepSeek returned HTTP {status}: {}", text.chars().take(400).collect::<String>()))?;
    if !status.is_success() {
        let msg = value
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .or_else(|| value.get("error").and_then(Value::as_str))
            .unwrap_or("request failed");
        return Err(format!("{} HTTP {}: {msg}", ep.provider, status.as_u16()));
    }
    Ok(value)
}

/// Loopback, link-local and RFC1918 addresses that a question should never be
/// able to make the app fetch.
pub(crate) fn is_private_host(host: &str) -> bool {
    use std::net::IpAddr;
    let h = host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if h == "localhost" || h.ends_with(".localhost") {
        return true;
    }
    match h.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified(),
        Ok(IpAddr::V6(v6)) => v6.is_loopback() || v6.is_unspecified(),
        Err(_) => false,
    }
}

/// Fetch any http(s) image as a data URL, for the vision model. Unlike
/// `fetch_image`, this is not limited to webassign.net: questions can embed
/// figures from a CDN. Private/loopback hosts are refused so a crafted question
/// cannot use this as a local-network probe.
#[tauri::command]
async fn fetch_image_any(state: State<'_, AppState>, url: String) -> Result<String, String> {
    const MAX_BYTES: usize = 12 * 1024 * 1024;
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("bad url: {e}"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("only http(s) images can be fetched".into());
    }
    let host = parsed.host_str().unwrap_or("");
    if is_private_host(host) {
        return Err("refusing to fetch a private address".into());
    }
    let resp = state.http.get(parsed).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .split(';')
        .next()
        .unwrap_or("image/png")
        .trim()
        .to_string();
    if !mime.starts_with("image/") {
        return Err(format!("not an image ({mime})"));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("image too large".into());
    }
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

/// A figure that travels with an export, as a data URL.
#[derive(Deserialize)]
struct ExportImage {
    file: String,
    data: String,
}

/// Export one assignment. Several of these run at once when a batch is
/// exported, so each builds in a scratch folder of its own — every document
/// names its figures `figure-1.png`, and two jobs sharing a folder would
/// overwrite each other's.
#[tauri::command]
async fn export_pdf(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    html: String,
    subtitle: Option<String>,
    images: Vec<ExportImage>,
    job: Option<String>,
) -> Result<Value, String> {
    let dir = app
        .path()
        .document_dir()
        .or_else(|_| app.path().download_dir())
        .map_err(|e| format!("cannot find the Documents folder: {e}"))?;
    let work = scratch_dir(&app, &safe_name(&name))?;
    // Only the first job of a batch clears the switches; a later one starting
    // must not undo a Cancel the user has already pressed.
    if state.export_active.fetch_add(1, Ordering::SeqCst) == 0 {
        state.export_cancel.store(false, Ordering::Relaxed);
        state.export_pause.store(false, Ordering::Relaxed);
    }
    let pause = state.export_pause.clone();
    let cancel = state.export_cancel.clone();
    let active = state.export_active.clone();
    let app2 = app.clone();
    let cfg = read_config(&app);
    let python = python::interpreter(&app, &cfg.python_path)
        .ok_or("Exporting needs Python. Open AI settings and press Install.")?;
    let subtitle = subtitle.unwrap_or_default();
    let job = job.unwrap_or_else(|| name.clone());
    let out = tauri::async_runtime::spawn_blocking(move || {
        let r = export_pdf_blocking(&app2, &python, &dir, &work, &name, &html, &subtitle, &images, &pause, &cancel, &job);
        let _ = std::fs::remove_dir_all(&work);
        r
    })
    .await;
    active.fetch_sub(1, Ordering::SeqCst);
    out.map_err(|e| format!("export task failed: {e}"))?
}

/// A private folder to build one document in, under the app cache dir.
fn scratch_dir(app: &AppHandle, base: &str) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("export");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = EXPORT_SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = root.join(format!("{base}-{stamp}-{n}"));
    fs::create_dir_all(&dir).map_err(|e| format!("could not create a build folder: {e}"))?;
    Ok(dir)
}

static EXPORT_SEQ: AtomicUsize = AtomicUsize::new(0);

/// Build folders only outlive an export after a crash. Called once at startup.
fn sweep_exports(app: &AppHandle) {
    let Ok(root) = app.path().app_cache_dir().map(|d| d.join("export")) else { return };
    let Ok(entries) = fs::read_dir(&root) else { return };
    for e in entries.flatten() {
        if e.path().is_dir() {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

#[tauri::command]
fn export_pause(state: State<'_, AppState>, paused: bool) {
    state.export_pause.store(paused, Ordering::Relaxed);
}

#[tauri::command]
fn export_cancel(state: State<'_, AppState>) {
    state.export_cancel.store(true, Ordering::Relaxed);
    state.export_pause.store(false, Ordering::Relaxed);
}

/// Hand a file to whatever the system opens it with (a PDF viewer, usually).
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("{} is not there any more.", p.display()));
    }
    #[cfg(windows)]
    let mut cmd = {
        // `start` is a shell builtin, and its first quoted argument is a window
        // title, so the path has to be the second one.
        let mut c = std::process::Command::new("cmd.exe");
        c.arg("/C").arg("start").arg("").arg(&p);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&p);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&p);
        c
    };
    hide_window(&mut cmd);
    cmd.spawn().map_err(|e| format!("could not open the file: {e}"))?;
    Ok(())
}

/// Where exports are written, so the app can offer to open the folder.
/// Open an http(s) link in the default browser (YouTube timestamps, citations).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("not a link: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only http and https links can be opened.".into());
    }
    #[cfg(windows)]
    let mut cmd = {
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler").arg(parsed.as_str());
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(parsed.as_str());
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(parsed.as_str());
        c
    };
    hide_window(&mut cmd);
    cmd.spawn().map(|_| ()).map_err(|e| format!("could not open the link: {e}"))
}

#[tauri::command]
fn export_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .document_dir()
        .or_else(|_| app.path().download_dir())
        .map_err(|e| format!("cannot find the Documents folder: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    let dir = if p.is_dir() {
        p.clone()
    } else {
        p.parent().map(|d| d.to_path_buf()).unwrap_or_else(|| p.clone())
    };
    // Windows and macOS can select the file itself; elsewhere open the folder.
    #[cfg(windows)]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer.exe");
        if p.is_file() {
            c.arg(format!("/select,{}", p.display()));
        } else {
            c.arg(&dir);
        }
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        if p.is_file() {
            c.arg("-R").arg(&p);
        } else {
            c.arg(&dir);
        }
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&dir);
        c
    };
    hide_window(&mut cmd);
    cmd.spawn().map_err(|e| format!("could not open the folder: {e}"))?;
    Ok(())
}

/// Delete the intermediate files an export creates, leaving only the PDF.
fn safe_name(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '(' | ')' | '.') { c } else { '_' })
        .collect();
    let out = out.trim().to_string();
    let out = if out.is_empty() { "assignment".to_string() } else { out };
    out.chars().take(80).collect()
}

/// Keep a spawned console program (pdflatex) from flashing a terminal window.
pub(crate) fn hide_window(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Move a finished file out of the build folder and into the export folder,
/// across filesystems if that is where Documents lives.
fn move_out(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to).map_err(|e| format!("could not write {}: {e}", to.display()))?;
    let _ = std::fs::remove_file(from);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
// Generic over the runtime so the tests can drive it with a mock app; the only
// thing the handle is used for is the progress event.
/// Turn a document into a PDF with the app's own Python.
///
/// This used to run pdflatex or Tectonic, which meant asking every student to
/// install a TeX distribution before they could export anything. PyMuPDF and
/// matplotlib are already in Salem's environment for reading PDFs and drawing
/// figures, so the same environment now does the typesetting too — see
/// `python/salem_pdf.py`.
fn export_pdf_blocking<R: tauri::Runtime>(
    app: &AppHandle<R>,
    // The interpreter to render with, resolved by the caller: this stays
    // generic over the runtime so the tests can drive it.
    python: &std::path::Path,
    dir: &std::path::Path,
    work: &std::path::Path,
    name: &str,
    html: &str,
    subtitle: &str,
    images: &[ExportImage],
    pause: &AtomicBool,
    cancel: &AtomicBool,
    job: &str,
) -> Result<Value, String> {
    let emit = |stage: &str, line: &str| {
        // `job` tells the dialog which document a line belongs to when several
        // are being written at once.
        let _ = app.emit("export://progress", json!({ "job": job, "stage": stage, "line": line }));
    };
    emit("stage", "Laying out the pages…");
    std::fs::create_dir_all(dir).ok();
    let base = safe_name(name);
    let out_pdf = dir.join(format!("{base}.pdf"));
    let built = work.join(format!("{base}.pdf"));

    // The renderer reads one file and writes one file, so a job is a folder.
    let job_file = work.join("job.json");
    let payload = json!({
        "title": name,
        "subtitle": subtitle,
        "html": html,
        "out": built.to_string_lossy(),
        "images": images.iter().map(|i| json!({ "file": safe_name(&i.file), "data": i.data })).collect::<Vec<_>>(),
    });
    std::fs::write(&job_file, payload.to_string()).map_err(|e| format!("could not stage the export: {e}"))?;

    let script = work.join("salem_pdf.py");
    std::fs::write(&script, PDF_RENDERER).map_err(|e| format!("could not stage the renderer: {e}"))?;

    wait_while_paused(pause, cancel)?;
    emit("stage", "Rendering…");
    let mut cmd = std::process::Command::new(python);
    cmd.arg(&script).arg(&job_file).current_dir(work);
    hide_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("could not run the renderer: {e}"))?;
    for line in String::from_utf8_lossy(&out.stderr).lines() {
        if !line.trim().is_empty() {
            emit("log", line);
        }
    }
    if !out.status.success() || !built.exists() {
        let why: String = String::from_utf8_lossy(&out.stderr)
            .lines()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(if why.trim().is_empty() { "the PDF could not be made".into() } else { why });
    }

    move_out(&built, &out_pdf)?;
    emit("done", "Saved.");
    Ok(json!({ "pdf": out_pdf.to_string_lossy(), "tex": Value::Null }))
}

/// Block while the export dialog's Pause is held, and give up on Cancel.
fn wait_while_paused(pause: &AtomicBool, cancel: &AtomicBool) -> Result<(), String> {
    while pause.load(Ordering::Relaxed) {
        if cancel.load(Ordering::Relaxed) {
            return Err("stopped".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("stopped".into());
    }
    Ok(())
}


#[tauri::command]
fn bridge_info(state: State<'_, AppState>) -> Value {
    json!({
        "port": bridge::PORT,
        "managed": true,
        "processAlive": true,
        "error": state.bridge.error(),
        "log": state.bridge.log_lines().into_iter().rev().take(60).rev().collect::<Vec<_>>(),
    })
}

#[tauri::command]
fn restart_bridge(state: State<'_, AppState>) -> Value {
    // The bridge lives in this process and cannot die; report its status instead.
    bridge_info(state)
}

fn start_server(bridge: Bridge) {
    match std::net::TcpListener::bind((bridge::HOST, bridge::PORT)) {
        Ok(listener) => {
            let _ = listener.set_nonblocking(true);
            bridge.log(format!("listening on http://{}:{}", bridge::HOST, bridge::PORT));
            let app = bridge::router(bridge.clone());
            let reporter = bridge.clone();
            tauri::async_runtime::spawn(async move {
                match tokio::net::TcpListener::from_std(listener) {
                    Ok(listener) => {
                        if let Err(e) = axum::serve(listener, app).await {
                            reporter.log(format!("bridge server stopped: {e}"));
                        }
                    }
                    Err(e) => reporter.set_error(format!("bridge listener error: {e}")),
                }
            });
        }
        Err(e) => bridge.set_error(format!(
            "Could not bind {}:{} — {e}. Another bridge may be using the port.",
            bridge::HOST,
            bridge::PORT
        )),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(100))
        .build()
        .expect("http client");
    let deepseek = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .expect("deepseek client");
    let bridge = Bridge::new();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            bridge: bridge.clone(),
            http,
            deepseek,
            export_pause: Arc::new(AtomicBool::new(false)),
            export_cancel: Arc::new(AtomicBool::new(false)),
            export_active: Arc::new(AtomicUsize::new(0)),
            cancelled_streams: std::sync::Mutex::new(std::collections::HashSet::new()),
        })
        .manage(study::StudyDb(std::sync::Mutex::new(None)))
        .manage(salem::Salem::default())
        .manage(tabmode::TabMode::default())
        .manage(providers::OllamaProc::default())
        .manage(prefs::PrefsLock::default())
        .setup(move |app| {
            start_server(bridge.clone());
            bridge::spawn_logger(bridge.clone());
            // Sandbox folders only ever outlive a run after a crash.
            python::sweep_sandboxes(&app.handle().clone());
            sweep_exports(&app.handle().clone());
            if let Err(e) = tray::install(app.handle()) {
                eprintln!("[tray] could not add the tray icon: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides to the tray (the default), so tab mode keeps
            // serving and anything running keeps running. Quit is in the
            // tray's menu.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && read_config(window.app_handle()).close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            api,
            bridge_info,
            restart_bridge,
            fetch_image,
            fetch_image_any,
            get_config,
            set_config,
            deepseek_chat,
            deepseek_stream,
            ai_cancel,
            deepseek_balance,
            export_pdf,
            export_pause,
            export_cancel,
            export_dir,
            open_path,
            reveal_path,
            prefs::prefs_all,
            prefs::prefs_set,
            prefs::prefs_seed,
            providers::providers_catalog,
            providers::ollama_status,
            providers::ollama_start,
            providers::ollama_stop,
            python::python_status,
            python::python_setup,
            python::run_python,
            study::study_tree,
            study::study_create_subject,
            study::study_update_subject,
            study::study_delete_subject,
            study::study_create_notebook,
            study::study_update_notebook,
            study::study_delete_notebook,
            study::chat::chat_list,
            study::chat::chat_create,
            study::chat::chat_rename,
            study::chat::chat_delete,
            study::chat::chat_clear,
            study::chat::chat_truncate,
            study::notebook_set_overview,
            study::activity,
            study::activity_detail,
            study::focus_session_add,
            study::focus_minutes,
            study::usage::usage_summary,
            data::data_export,
            data::data_inspect,
            data::data_import,
            data::data_reset,
            study::pad::pad_overview,
            study::pad::pad_notes,
            study::pad::pad_search,
            study::pad::pad_note,
            study::pad::pad_folder_create,
            study::pad::pad_folder_rename,
            study::pad::pad_folder_delete,
            study::pad::pad_note_create,
            study::pad::pad_note_save,
            study::pad::pad_note_move,
            study::pad::pad_note_pin,
            study::pad::pad_note_delete,
            study::pad::pad_note_restore,
            study::pad::pad_empty_deleted,
            study::memory::memory_list,
            study::memory::memory_add,
            study::memory::memory_update,
            study::memory::memory_delete,
            study::memory::memory_clear,
            study::syllabus::syllabus_set,
            study::syllabus::syllabus_clear,
            study::syllabus::syllabus_text,
            study::usage::usage_reset,
            study::events::events_between,
            study::events::event_add,
            study::events::event_update,
            study::events::event_delete,
            study::search::search_everything,
            study::sources::source_image_add,
            study::sources::source_images_clear,
            study::sources::source_images,
            study::sources::source_image_data,
            study::chat::chat_delete_all,
            study::notes::notes_list,
            study::notes::note_get,
            study::notes::note_create,
            study::notes::note_update,
            study::notes::note_delete,
            study::chat::chat_messages,
            study::chat::chat_add_message,
            study::chat::attachment_add,
            study::chat::attachment_data,
            study::chat::attachment_set_text,
            study::chat::attachments_info,
            study::cards::decks_list,
            study::cards::deck_create,
            study::cards::deck_rename,
            study::cards::deck_delete,
            study::cards::deck_cards,
            study::cards::cards_add,
            study::cards::card_update,
            study::cards::card_delete,
            study::cards::deck_run_add,
            study::cards::deck_runs_list,
            study::cards::reviews_list,
            study::sources::sources_list,
            study::sources::source_add,
            study::sources::source_set_content,
            study::sources::source_set_status,
            study::sources::source_set_report,
            study::sources::source_rename,
            study::sources::source_delete,
            study::sources::source_units,
            study::sources::source_data,
            study::sources::sources_search,
            study::sources::sources_sample,
            python::youtube_transcript,
            web::web_search,
            web::web_fetch,
            salem::salem_run,
            salem::salem_cancel,
            salem::salem_tool_result,
            salem::salem_status,
            salem::salem_restart,
            salem::salem_telemetry,
            salem::salem_task_clear,
            tabmode::tab_mode_status,
            tabmode::tab_mode_start,
            tabmode::tab_mode_stop,
            tabmode::tab_mode_reply,
            open_url,
            study::cards::quizzes_list,
            study::cards::quiz_get,
            study::cards::quiz_create,
            study::cards::quiz_update,
            study::cards::quiz_rename,
            study::cards::quiz_delete,
            study::cards::quiz_attempt_add,
            study::cards::attempts_list
        ])
        .build(tauri::generate_context!())
        .expect("error while building WebAssign Desk");

    app.run(|app, event| {
        // macOS: clicking the Dock icon with the window hidden brings it back.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            tray::show_main(app);
        }
        // Quitting: a local model is gigabytes of memory, and Ollama keeps it
        // loaded for minutes after the last request. Unload it and stop Ollama.
        if let tauri::RunEvent::Exit = event {
            if providers::provider_of(&read_config(app)) == providers::OLLAMA {
                tauri::async_runtime::block_on(providers::stop_ollama(app));
            }
        }
        let _ = (app, event);
    });
}

#[cfg(test)]
mod stream_tests {
    use super::*;

    #[test]
    fn reassembles_text_and_split_tool_calls() {
        let mut acc = StreamAcc::default();
        let chunks = [
            json!({"model": "deepseek-flash", "choices": [{"delta": {"content": "The line is "}}]}),
            json!({"choices": [{"delta": {"content": "r = r0 + tv."}}]}),
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_1", "function": {"name": "run_", "arguments": "{\"co"}}]}}]}),
            json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"name": "python", "arguments": "de\": \"print(1)\"}"}}]}}]}),
            json!({"choices": [], "usage": {"total_tokens": 42}}),
        ];
        let deltas: Vec<String> = chunks.iter().map(|c| acc.absorb(c).0).collect();
        assert_eq!(deltas[..2], ["The line is ".to_string(), "r = r0 + tv.".to_string()]);
        let v = acc.finish();
        assert_eq!(v["content"], "The line is r = r0 + tv.");
        assert_eq!(v["model"], "deepseek-flash");
        assert_eq!(v["usage"]["total_tokens"], 42);
        assert_eq!(v["tool_calls"][0]["function"]["name"], "run_python");
        assert_eq!(v["tool_calls"][0]["function"]["arguments"], "{\"code\": \"print(1)\"}");
        assert_eq!(v["tool_calls"][0]["id"], "call_1");
    }

    #[test]
    fn keeps_what_the_provider_hangs_on_a_tool_call() {
        // Gemini 3: the call's thought_signature must go back with it, or the
        // next request is refused.
        let mut acc = StreamAcc::default();
        acc.absorb(&json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "type": "function",
            "function": {"name": "create_subject", "arguments": "{}"},
            "extra_content": {"google": {"thought_signature": "sig=="}}}]}}]}));
        let v = acc.finish();
        assert_eq!(v["tool_calls"][0]["extra_content"]["google"]["thought_signature"], "sig==");
        assert_eq!(v["tool_calls"][0]["function"]["name"], "create_subject");
    }
}

#[cfg(test)]
mod export_tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn doc(title: &str) -> String {
        // Every document refers to `figure-1.png`, which is exactly the case
        // that used to make two parallel exports overwrite each other.
        format!(
            "\\documentclass{{article}}\\usepackage{{graphicx}}\\begin{{document}}\
             \\section*{{{title}}}\\includegraphics[width=1cm]{{figure-1.png}}\\end{{document}}"
        )
    }

    fn figures() -> Vec<ExportImage> {
        vec![ExportImage { file: "figure-1.png".into(), data: format!("data:image/png;base64,{PNG}") }]
    }

    /// Where the renderer lives on this machine, or `None` if Python is not
    /// set up here. The export tests are about the pipeline, not about
    /// whether a particular laptop has an environment.
    fn renderer() -> Option<std::path::PathBuf> {
        let venv = dirs_next_data()?.join("net.serverside.webassign-desk/python/venv/bin/python3");
        venv.is_file().then_some(venv)
    }

    fn dirs_next_data() -> Option<std::path::PathBuf> {
        std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("Library/Application Support"))
    }

    /// Three documents rendered at once land as three PDFs, and nothing else
    /// is left in the export folder.
    #[test]
    fn parallel_exports_do_not_collide() {
        let Some(python) = renderer() else {
            eprintln!("skipped: no Salem Python environment on this machine");
            return;
        };
        let app = tauri::test::mock_app();
        let root = std::env::temp_dir().join(format!(
            "wa-export-test-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();

        let names = ["Alpha sheet", "Beta sheet", "Gamma sheet"];
        let handles: Vec<_> = names
            .iter()
            .enumerate()
            .map(|(i, name)| {
                let handle = app.handle().clone();
                let out = out.clone();
                let work = root.join(format!("work-{i}"));
                let name = name.to_string();
                let python = python.clone();
                std::thread::spawn(move || {
                    fs::create_dir_all(&work).unwrap();
                    let pause = AtomicBool::new(false);
                    let cancel = AtomicBool::new(false);
                    let html = format!("<p>{name}, with a formula \\(x^2 + 1\\).</p><img src=\"figure-1.png\" />");
                    let r = export_pdf_blocking(
                        &handle, &python, &out, &work, &name, &html, "", &figures(), &pause, &cancel, &name,
                    );
                    let _ = fs::remove_dir_all(&work);
                    r
                })
            })
            .collect();

        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        for (name, r) in names.iter().zip(&results) {
            let v = r.as_ref().unwrap_or_else(|e| panic!("{name} failed: {e}"));
            let pdf = v["pdf"].as_str().expect("a pdf path");
            assert!(std::path::Path::new(pdf).exists(), "{pdf} is missing");
            assert!(pdf.ends_with(&format!("{}.pdf", safe_name(name))));
        }
        let left: Vec<String> = fs::read_dir(&out)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(left.len(), 3, "the export folder should hold only the PDFs: {left:?}");
        assert!(left.iter().all(|n| n.ends_with(".pdf")), "{left:?}");
        let _ = fs::remove_dir_all(&root);
    }

    /// Cancelling stops the export rather than letting it finish quietly.
    #[test]
    fn a_cancelled_export_stops() {
        let Some(python) = renderer() else { return };
        let app = tauri::test::mock_app();
        let root = std::env::temp_dir().join("wa-export-cancel");
        let out = root.join("out");
        let work = root.join("work");
        fs::create_dir_all(&out).unwrap();
        fs::create_dir_all(&work).unwrap();
        let pause = AtomicBool::new(false);
        let cancel = AtomicBool::new(true);
        let r = export_pdf_blocking(
            &app.handle().clone(), &python, &out, &work, "Stopped", "<p>x</p>", "", &[], &pause, &cancel, "Stopped",
        );
        assert_eq!(r.unwrap_err(), "stopped");
        let _ = fs::remove_dir_all(&root);
    }
}
