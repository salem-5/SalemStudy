//! The Salem AI runtime, from the app's side.
//!
//! The runtime itself is a Python process (`src-tauri/python/salem_ai`, built
//! on smolagents) that holds no key, opens no socket and touches no file of
//! the student's. This module is the other half: it starts that process, keeps
//! it alive, and answers everything it asks for — completions, tools, the
//! sandbox, task state, telemetry.
//!
//! ```text
//!   webview  ──salem_run──▶  this module  ──stdin──▶  salem_ai (smolagents)
//!      ▲                          ▲                        │
//!      └── salem://event ─────────┴──── stdout ────────────┘
//! ```
//!
//! Tools are declared by the app and executed by the app. Most of them run in
//! the webview, where the study space already lives; a few (the sandbox, the
//! web) are served here so they keep working while the UI is busy.

pub mod store;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::study::StudyDb;
use crate::{python, read_config, web, StreamAcc, DEFAULT_BASE_URL};

/// The runtime's own source, shipped with the binary and written out next to
/// the virtualenv on startup. Keeping it in the binary means the two halves of
/// the protocol can never drift apart across an update.
const SOURCES: &[(&str, &str)] = &[
    ("__init__.py", include_str!("../python/salem_ai/__init__.py")),
    ("__main__.py", include_str!("../python/salem_ai/__main__.py")),
    ("rpc.py", include_str!("../python/salem_ai/rpc.py")),
    ("state.py", include_str!("../python/salem_ai/state.py")),
    ("model.py", include_str!("../python/salem_ai/model.py")),
    ("toolkit.py", include_str!("../python/salem_ai/toolkit.py")),
    ("sandbox.py", include_str!("../python/salem_ai/sandbox.py")),
    ("workmem.py", include_str!("../python/salem_ai/workmem.py")),
    ("agents.py", include_str!("../python/salem_ai/agents.py")),
    ("runtime.py", include_str!("../python/salem_ai/runtime.py")),
];

/// Tools this side runs itself. Everything else is handed to the webview.
const NATIVE_TOOLS: &[&str] = &["web_search", "web_fetch", "run_python"];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Reply = tokio::sync::oneshot::Sender<Result<Value, String>>;

#[derive(Default)]
pub struct Salem {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    /// The handshake of the running process: version, interpreter, or why it
    /// refused to start.
    hello: Mutex<Option<Value>>,
    /// Runs in flight, waiting for their `done`.
    runs: Mutex<HashMap<String, Reply>>,
    /// Tool calls forwarded to the webview, waiting for `salem_tool_result`.
    forwarded: Mutex<HashMap<u64, Reply>>,
    /// Host calls the runtime is waiting on, so `abandon` can stop the work.
    inflight: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    next_id: AtomicU64,
    /// The last thing the runtime said on stderr before it gave up. Without
    /// this, "the AI runtime could not start" is all anyone ever sees.
    last_error: Mutex<Vec<String>>,
    /// Which interpreter the running process was started with, so Settings can
    /// say whether it is the one that was just installed.
    interpreter: Mutex<Option<String>>,
}

impl Salem {
    fn send(&self, message: &Value) -> Result<(), String> {
        let mut guard = self.stdin.lock().map_err(|_| "runtime lock poisoned".to_string())?;
        let pipe = guard.as_mut().ok_or("the AI runtime is not running")?;
        let line = serde_json::to_string(message).map_err(|e| e.to_string())?;
        pipe.write_all(line.as_bytes()).and_then(|_| pipe.write_all(b"\n")).and_then(|_| pipe.flush())
            .map_err(|e| format!("the AI runtime stopped listening: {e}"))
    }

    fn alive(&self) -> bool {
        let Ok(mut guard) = self.child.lock() else { return false };
        match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    }

    pub(crate) fn shut_down(&self, why: &str) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if let Ok(mut guard) = self.stdin.lock() {
            *guard = None;
        }
        // Nothing may be left waiting on a process that is gone.
        for (_, reply) in self.runs.lock().map(|mut m| m.drain().collect::<Vec<_>>()).unwrap_or_default() {
            let _ = reply.send(Err(why.to_string()));
        }
        for (_, reply) in self.forwarded.lock().map(|mut m| m.drain().collect::<Vec<_>>()).unwrap_or_default() {
            let _ = reply.send(Err(why.to_string()));
        }
    }
}

// ---------------------------------------------------------------------------
// Starting the runtime
// ---------------------------------------------------------------------------

/// Where the runtime's source lives: beside the virtualenv, so one folder
/// holds everything Python in this app.
fn package_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("python").join("runtime");
    std::fs::create_dir_all(dir.join("salem_ai")).map_err(|e| format!("cannot create the runtime folder: {e}"))?;
    Ok(dir)
}

/// Write the runtime out, but only what changed: an unchanged file keeps its
/// timestamp so Python's bytecode cache stays warm.
fn materialise(app: &AppHandle) -> Result<PathBuf, String> {
    let root = package_dir(app)?;
    let pkg = root.join("salem_ai");
    for (name, body) in SOURCES {
        let path = pkg.join(name);
        if std::fs::read_to_string(&path).map(|old| old == *body).unwrap_or(false) {
            continue;
        }
        std::fs::write(&path, body).map_err(|e| format!("cannot write {name}: {e}"))?;
    }
    Ok(root)
}

fn spawn(app: &AppHandle, salem: &Salem) -> Result<(), String> {
    let cfg = read_config(app);
    let interpreter = python::interpreter(app, &cfg.python_path)
        .ok_or("Salem's AI needs Python. Open AI settings and install it.")?;
    let root = materialise(app)?;

    let mut cmd = Command::new(&interpreter);
    cmd.arg("-u")
        .arg("-m")
        .arg("salem_ai")
        .current_dir(&root)
        .env("PYTHONPATH", &root)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONDONTWRITEBYTECODE", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    python::hide_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("could not start the AI runtime: {e}"))?;
    let stdout = child.stdout.take().ok_or("the AI runtime has no output pipe")?;
    let stderr = child.stderr.take();
    let stdin = child.stdin.take().ok_or("the AI runtime has no input pipe")?;

    if let Ok(mut tail) = salem.last_error.lock() {
        tail.clear();
    }
    if let Ok(mut slot) = salem.interpreter.lock() {
        *slot = Some(interpreter.to_string_lossy().to_string());
    }
    *salem.stdin.lock().map_err(|_| "runtime lock poisoned".to_string())? = Some(stdin);
    *salem.child.lock().map_err(|_| "runtime lock poisoned".to_string())? = Some(child);
    *salem.hello.lock().map_err(|_| "runtime lock poisoned".to_string())? = None;

    // Whatever the runtime writes to stderr is a Python traceback or a library
    // warning: useful in the log, never part of the protocol. The tail is kept
    // so Settings can show what actually went wrong.
    if let Some(stderr) = stderr {
        let handle = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                eprintln!("[salem] {line}");
                if let Some(state) = handle.try_state::<Salem>() {
                    if let Ok(mut tail) = state.last_error.lock() {
                        tail.push(line);
                        // Only the last few lines matter; a traceback's last
                        // line is the one that names the problem.
                        let extra = tail.len().saturating_sub(12);
                        tail.drain(..extra);
                    }
                }
            }
        });
    }

    let handle = app.clone();
    std::thread::spawn(move || read_loop(handle, stdout));
    Ok(())
}

/// Start the runtime if it is not already up, and wait for its handshake.
///
/// A process that came up and said it could not work — no smolagents, a
/// Python that is too old — is *not* kept. It is shut down and started again,
/// so that installing what was missing fixes the app without restarting it.
/// The old behaviour cached that failure for the life of the window, which
/// meant a successful "Install" changed nothing until the student quit.
async fn ensure(app: &AppHandle) -> Result<Value, String> {
    {
        let salem = app.state::<Salem>();
        let handshake = salem.hello.lock().ok().and_then(|h| h.clone());
        let usable = handshake.as_ref().is_some_and(|h| h.get("ok").and_then(Value::as_bool) == Some(true));
        if salem.alive() && usable {
            return check(handshake.expect("checked just above"));
        }
        salem.shut_down("the AI runtime is being restarted");
        spawn(app, &salem)?;
    }
    // The handshake is the first thing the process writes; give it long enough
    // to import smolagents on a cold start.
    for _ in 0..300 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let salem = app.state::<Salem>();
        if let Some(hello) = salem.hello.lock().ok().and_then(|h| h.clone()) {
            return check(hello);
        }
        if !salem.alive() {
            return Err("the AI runtime stopped before it was ready. Check AI settings → Python.".into());
        }
    }
    Err("the AI runtime did not start in time".into())
}

fn check(hello: Value) -> Result<Value, String> {
    if hello.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(hello);
    }
    Err(hello.get("error").and_then(Value::as_str).unwrap_or("the AI runtime could not start").to_string())
}

// ---------------------------------------------------------------------------
// Reading the runtime
// ---------------------------------------------------------------------------

fn read_loop(app: AppHandle, stdout: std::process::ChildStdout) {
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        match message.get("t").and_then(Value::as_str).unwrap_or("") {
            "hello" => {
                if let Ok(mut slot) = app.state::<Salem>().hello.lock() {
                    *slot = Some(message);
                }
            }
            "event" => {
                crate::tabmode::notify(&app, "salem://event", json!({
                    "run": message.get("run").cloned().unwrap_or(Value::Null),
                    "event": message.get("event").cloned().unwrap_or(Value::Null),
                }));
            }
            "done" => finish(&app, &message),
            "log" => eprintln!(
                "[salem] {} {}",
                message.get("level").and_then(Value::as_str).unwrap_or("info"),
                message.get("message").and_then(Value::as_str).unwrap_or("")
            ),
            "call" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move { serve(handle, message).await });
            }
            "abandon" => {
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    if let Some(flag) = app.state::<Salem>().inflight.lock().ok().and_then(|mut m| m.remove(&id)) {
                        flag.store(true, Ordering::SeqCst);
                    }
                }
            }
            _ => {}
        }
    }
    // The pipe closed: the process is gone, so nothing should still be waiting.
    app.state::<Salem>().shut_down("the AI runtime stopped unexpectedly");
}

fn finish(app: &AppHandle, message: &Value) {
    let run = message.get("run").and_then(Value::as_str).unwrap_or("").to_string();
    let ok = message.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let result = message.get("result").cloned().unwrap_or(Value::Null);
    let error = message.get("error").and_then(Value::as_str).unwrap_or("").to_string();
    crate::tabmode::notify(app, "salem://done", json!({ "run": run, "ok": ok, "result": result, "error": error }));
    let waiting = app.state::<Salem>().runs.lock().ok().and_then(|mut m| m.remove(&run));
    if let Some(reply) = waiting {
        let _ = reply.send(if ok { Ok(result) } else { Err(if error.is_empty() { "the task failed".into() } else { error }) });
    }
}

// ---------------------------------------------------------------------------
// Serving the runtime's calls
// ---------------------------------------------------------------------------

async fn serve(app: AppHandle, message: Value) {
    let id = message.get("id").and_then(Value::as_u64).unwrap_or(0);
    let method = message.get("method").and_then(Value::as_str).unwrap_or("").to_string();
    let args = message.get("args").cloned().unwrap_or_else(|| json!({}));

    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut inflight) = app.state::<Salem>().inflight.lock() {
        inflight.insert(id, cancel.clone());
    }
    let answer = dispatch(&app, &method, args, cancel).await;
    if let Ok(mut inflight) = app.state::<Salem>().inflight.lock() {
        inflight.remove(&id);
    }
    let reply = match answer {
        Ok(data) => json!({ "t": "reply", "id": id, "ok": true, "data": data }),
        Err(error) => json!({ "t": "reply", "id": id, "ok": false, "error": error }),
    };
    let _ = app.state::<Salem>().send(&reply);
}

async fn dispatch(app: &AppHandle, method: &str, args: Value, cancel: Arc<AtomicBool>) -> Result<Value, String> {
    let db = app.state::<StudyDb>();
    match method {
        "model.complete" => complete(app, args, cancel).await,
        "python.run" => run_python(app, args).await,
        "tool.invoke" => invoke_tool(app, args, cancel).await,
        "task.load" => store::load_task(app, &db, args.get("taskId").and_then(Value::as_str).unwrap_or("")),
        "task.save" => store::save_task(
            app,
            &db,
            args.get("taskId").and_then(Value::as_str).unwrap_or(""),
            args.get("state").unwrap_or(&Value::Null),
        ),
        "telemetry.record" => store::record_run(app, &db, &args).map(|_| json!({ "ok": true })),
        other => Err(format!("the app has no {other} to offer")),
    }
}

// ------------------------------------------------------------------ the model

/// A completion, with the key, the retry policy and the usage accounting all
/// staying on this side. When `stream` is set the text is emitted as it
/// arrives, so a plain chat answer still appears word by word.
async fn complete(app: &AppHandle, args: Value, cancel: Arc<AtomicBool>) -> Result<Value, String> {
    let cfg = read_config(app);
    if cfg.api_key.is_empty() {
        return Err("No DeepSeek API key set. Open AI settings and paste your key.".into());
    }
    let base = if cfg.base_url.trim().is_empty() { DEFAULT_BASE_URL } else { cfg.base_url.trim() };
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let model = args.get("model").and_then(Value::as_str).unwrap_or(&cfg.flash_model).to_string();
    let run = args.get("run").and_then(Value::as_str).unwrap_or("").to_string();
    let stream = args.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let feature = args.get("feature").and_then(Value::as_str).unwrap_or("chat").to_string();

    let mut body = json!({
        "model": model,
        "messages": for_deepseek(args.get("messages").cloned().unwrap_or_else(|| json!([]))),
        "stream": stream,
        "max_tokens": 16384,
    });
    if stream {
        body["stream_options"] = json!({ "include_usage": true });
    }
    for (from, to) in [("tools", "tools"), ("tool_choice", "tool_choice"), ("stop", "stop"), ("response_format", "response_format")] {
        match args.get(from) {
            Some(v) if !v.is_null() => body[to] = v.clone(),
            _ => {}
        }
    }
    if args.get("thinking").and_then(Value::as_bool) == Some(true) {
        body["thinking"] = json!({ "type": "enabled" });
    }
    // How hard to reason. The runtime asks for "low" on work that is
    // mechanical (a sub-agent checking arithmetic); everything else takes the
    // student's setting, which defaults to "low" because the API's own
    // default reasons at length on every short tool-choosing step.
    let effort = args
        .get("effort")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .unwrap_or(cfg.effort.trim());
    if !effort.is_empty() {
        body["reasoning_effort"] = json!(effort);
    }

    let state = app.state::<crate::AppState>();
    let mut resp = state
        .deepseek
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("DeepSeek request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| text.chars().take(300).collect());
        return Err(format!("DeepSeek HTTP {}: {detail}", status.as_u16()));
    }

    let value = if stream {
        stream_reply(app, &mut resp, &run, &cancel).await?
    } else {
        let text = resp.text().await.map_err(|e| e.to_string())?;
        let parsed: Value = serde_json::from_str(&text).map_err(|_| "DeepSeek sent something that is not JSON".to_string())?;
        let message = parsed.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("message")).cloned().unwrap_or(Value::Null);
        json!({
            "content": message.get("content").cloned().unwrap_or(Value::Null),
            "reasoning": message.get("reasoning_content").cloned().unwrap_or(Value::Null),
            "model": parsed.get("model").cloned().unwrap_or(Value::Null),
            "usage": parsed.get("usage").cloned().unwrap_or(Value::Null),
            "tool_calls": message.get("tool_calls").cloned().unwrap_or(Value::Null),
        })
    };

    let used = value.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or(&model).to_string();
    let cost = crate::record_usage(app, &app.state::<StudyDb>(), &used, Some(&feature), value.get("usage"));
    // What the run is costing, as it goes, for whoever is showing it.
    if cost > 0.0 && !run.is_empty() {
        crate::tabmode::notify(app, "salem://event", json!({ "run": run, "event": { "kind": "usage", "cost": cost } }));
    }
    Ok(shape(value, cancel.load(Ordering::SeqCst)))
}

/// Put the runtime's messages into the shape DeepSeek actually accepts.
///
/// smolagents hands every message a *list* of content parts, whatever its
/// role. DeepSeek only takes that form for a user message carrying images;
/// a system, assistant or tool message with an array `content` is rejected
/// outright, which is every request failing rather than a degraded answer.
/// So anything that is only text is flattened back to a plain string, and the
/// array form is kept exactly where it is needed.
fn for_deepseek(messages: Value) -> Value {
    let Some(list) = messages.as_array() else { return messages };
    let out: Vec<Value> = list
        .iter()
        .map(|message| {
            let mut message = message.clone();
            let Some(parts) = message.get("content").and_then(Value::as_array).cloned() else {
                return message;
            };
            let role = message.get("role").and_then(Value::as_str).unwrap_or("");
            let has_image = parts.iter().any(|p| p.get("type").and_then(Value::as_str) == Some("image_url"));
            if role == "user" && has_image {
                return message;
            }
            let text = parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            message["content"] = json!(text);
            message
        })
        .collect();
    Value::Array(out)
}

async fn stream_reply(app: &AppHandle, resp: &mut reqwest::Response, run: &str, cancel: &Arc<AtomicBool>) -> Result<Value, String> {
    let mut acc = StreamAcc::default();
    let mut buf = String::new();
    'read: loop {
        if cancel.load(Ordering::SeqCst) {
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
            let (content, _reasoning) = acc.absorb(&v);
            // Only the answer is streamed out. Reasoning stays in the reply so
            // the API can be given it back, and never reaches the window.
            if !content.is_empty() {
                crate::tabmode::notify(app, "salem://event", json!({
                    "run": run, "event": { "kind": "text", "text": content },
                }));
            }
        }
    }
    Ok(acc.finish())
}

/// DeepSeek's names for things, in the runtime's vocabulary.
fn shape(value: Value, cancelled: bool) -> Value {
    let usage = value.get("usage").cloned().unwrap_or(Value::Null);
    let n = |key: &str| usage.get(key).and_then(Value::as_i64).unwrap_or(0);
    json!({
        "content": value.get("content").and_then(Value::as_str).unwrap_or(""),
        "reasoning": value.get("reasoning").and_then(Value::as_str).unwrap_or(""),
        "model": value.get("model").and_then(Value::as_str).unwrap_or(""),
        "toolCalls": value.get("tool_calls").cloned().unwrap_or(Value::Null),
        "cancelled": cancelled || value.get("cancelled").and_then(Value::as_bool).unwrap_or(false),
        "usage": {
            "promptTokens": n("prompt_tokens"),
            "completionTokens": n("completion_tokens"),
            "totalTokens": n("total_tokens"),
        },
    })
}

// ----------------------------------------------------------------- the sandbox

async fn run_python(app: &AppHandle, args: Value) -> Result<Value, String> {
    let ids = |key: &str| -> Vec<i64> {
        args.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_i64).collect()).unwrap_or_default()
    };
    let code = args.get("code").and_then(Value::as_str).unwrap_or("").to_string();
    if code.trim().is_empty() {
        return Err("no code was given to run".into());
    }
    let timeout = args.get("timeout").and_then(Value::as_f64).map(|t| t as u64);
    python::run_python(
        app.clone(),
        app.state::<StudyDb>(),
        code,
        timeout,
        Some(ids("files")),
        Some(ids("sources")),
        None,
        None,
    )
    .await
}

// ------------------------------------------------------------------- the tools

async fn invoke_tool(app: &AppHandle, args: Value, cancel: Arc<AtomicBool>) -> Result<Value, String> {
    let name = args.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let payload = args.get("args").cloned().unwrap_or_else(|| json!({}));
    let idem = args.get("idem").and_then(Value::as_str).unwrap_or("").to_string();
    let db = app.state::<StudyDb>();

    // A mutating call that already went through comes back with its first
    // result. Retrying a step must not book the same event twice.
    if !idem.is_empty() {
        if let Some(previous) = store::already_applied(app, &db, &idem) {
            return Ok(json!({ "result": previous, "detail": "already done earlier in this task", "repeated": true }));
        }
    }

    let run = args.get("run").and_then(Value::as_str).unwrap_or("").to_string();
    let result = if NATIVE_TOOLS.contains(&name.as_str()) {
        native(app, &run, &name, payload).await
    } else {
        forward(app, &run, &name, payload, cancel).await
    }?;

    if !idem.is_empty() {
        store::remember_applied(app, &db, &idem, &name, &result);
    }
    Ok(result)
}

/// The tools the app serves itself, so they keep working while the window is
/// busy rendering a long answer.
async fn native(app: &AppHandle, run: &str, name: &str, args: Value) -> Result<Value, String> {
    let state = app.state::<crate::AppState>();
    match name {
        "web_search" => {
            let query = args.get("query").and_then(Value::as_str).unwrap_or("").to_string();
            let count = args.get("count").and_then(Value::as_u64).map(|c| c as usize);
            let hits = web::search(&state.http, query, count).await?;
            Ok(json!({ "result": hits, "detail": format!("{} result(s)", hits.len()) }))
        }
        "web_fetch" => {
            let url = args.get("url").and_then(Value::as_str).unwrap_or("").to_string();
            let max = args.get("maxChars").and_then(Value::as_u64).map(|c| c as usize);
            let page = web::fetch(&state.http, url, max).await?;
            Ok(json!({ "result": page }))
        }
        "run_python" => {
            let mut value = run_python(app, args).await?;
            // Figures go straight to the window as image data. Sending them
            // through the runtime would put a megabyte of base64 in front of
            // the model for no benefit; it only needs to know they exist.
            let figures = value.get_mut("figures").map(Value::take).unwrap_or(Value::Null);
            let names: Vec<String> = figures
                .as_array()
                .map(|a| a.iter().filter_map(|f| f.get("name").and_then(Value::as_str).map(str::to_string)).collect())
                .unwrap_or_default();
            if !names.is_empty() {
                crate::tabmode::notify(app, "salem://figures", json!({ "run": run, "figures": figures }));
            }
            value["figures"] = json!(names);
            Ok(json!({ "result": value }))
        }
        other => Err(format!("no tool called {other}")),
    }
}

/// Anything else: the webview owns the study space, so it runs the tool and
/// answers with `salem_tool_result`.
async fn forward(app: &AppHandle, run: &str, name: &str, args: Value, cancel: Arc<AtomicBool>) -> Result<Value, String> {
    let salem = app.state::<Salem>();
    let id = salem.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = tokio::sync::oneshot::channel();
    salem.forwarded.lock().map_err(|_| "runtime lock poisoned".to_string())?.insert(id, tx);
    crate::tabmode::notify(app, "salem://tool", json!({ "call": id, "run": run, "name": name, "args": args }));

    // The window can be closed or wedged; a tool must not hang the run.
    let waited = tokio::select! {
        answer = rx => answer.map_err(|_| "the app did not answer".to_string())?,
        _ = wait_for_cancel(cancel) => Err("stopped".to_string()),
        _ = tokio::time::sleep(std::time::Duration::from_secs(600)) => Err(format!("{name} did not finish in time")),
    };
    app.state::<Salem>().forwarded.lock().ok().map(|mut m| m.remove(&id));
    waited
}

async fn wait_for_cancel(cancel: Arc<AtomicBool>) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Run one AI request. Resolves with the runtime's result; progress arrives
/// meanwhile on `salem://event`, and `salem_cancel` stops it.
#[tauri::command]
pub async fn salem_run(app: AppHandle, run: String, input: Value) -> Result<Value, String> {
    ensure(&app).await?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let salem = app.state::<Salem>();
        salem.runs.lock().map_err(|_| "runtime lock poisoned".to_string())?.insert(run.clone(), tx);
        salem.send(&json!({ "t": "start", "run": run, "input": input }))?;
    }
    rx.await.map_err(|_| "the AI runtime stopped before answering".to_string())?
}

#[tauri::command]
pub fn salem_cancel(app: AppHandle, run: String) -> Result<(), String> {
    app.state::<Salem>().send(&json!({ "t": "cancel", "run": run }))
}

/// The webview's answer to a forwarded tool call.
#[tauri::command]
pub fn salem_tool_result(app: AppHandle, call: u64, ok: bool, data: Option<Value>, error: Option<String>) {
    let waiting = app.state::<Salem>().forwarded.lock().ok().and_then(|mut m| m.remove(&call));
    if let Some(reply) = waiting {
        let _ = reply.send(if ok {
            Ok(data.unwrap_or(Value::Null))
        } else {
            Err(error.unwrap_or_else(|| "the tool failed".into()))
        });
    }
}

/// Whether the runtime can start, and what is missing if it cannot. Safe to
/// call at any time; it is what onboarding and Settings show.
#[tauri::command]
pub async fn salem_status(app: AppHandle) -> Result<Value, String> {
    let ready = ensure(&app).await;
    let state = app.state::<Salem>();
    let hello = state.hello.lock().ok().and_then(|h| h.clone()).unwrap_or(Value::Null);
    let details = state.last_error.lock().map(|t| t.join("\n")).unwrap_or_default();
    let interpreter = state.interpreter.lock().ok().and_then(|i| i.clone());
    Ok(json!({
        "ready": ready.is_ok(),
        "error": ready.err(),
        // What Python actually printed on its way out — the line that says why.
        "details": if details.trim().is_empty() { Value::Null } else { json!(details) },
        "interpreter": interpreter,
        "hello": hello,
        "nativeTools": NATIVE_TOOLS,
    }))
}

/// Stop the runtime. The next request starts a fresh one — which is how a
/// changed interpreter or a reinstalled smolagents is picked up.
#[tauri::command]
pub fn salem_restart(app: AppHandle) {
    app.state::<Salem>().shut_down("the AI runtime was restarted");
}

#[tauri::command]
pub fn salem_telemetry(app: AppHandle, db: State<'_, StudyDb>, since: Option<i64>) -> Result<Value, String> {
    store::summary(&app, &db, since.unwrap_or(0))
}

#[tauri::command]
pub fn salem_task_clear(app: AppHandle, db: State<'_, StudyDb>, task_id: String) -> Result<(), String> {
    store::clear_task(&app, &db, &task_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_only_messages_are_flattened_to_strings() {
        // smolagents gives every role an array; DeepSeek refuses that for
        // anything but a user message with an image in it.
        let sent = for_deepseek(json!([
            { "role": "system", "content": [{ "type": "text", "text": "You are Salem." }] },
            { "role": "user", "content": [{ "type": "text", "text": "What is 2+2?" }] },
            { "role": "assistant", "content": [{ "type": "text", "text": "Four." }] },
        ]));
        for message in sent.as_array().unwrap() {
            assert!(message["content"].is_string(), "{message} should carry plain text");
        }
        assert_eq!(sent[0]["content"], "You are Salem.");
        assert_eq!(sent[2]["content"], "Four.");
    }

    #[test]
    fn several_text_parts_are_joined_rather_than_dropped() {
        let sent = for_deepseek(json!([
            { "role": "user", "content": [
                { "type": "text", "text": "First." },
                { "type": "text", "text": "Second." },
            ] },
        ]));
        assert_eq!(sent[0]["content"], "First.\nSecond.");
    }

    #[test]
    fn a_user_message_with_an_image_keeps_its_parts() {
        let original = json!([
            { "role": "user", "content": [
                { "type": "text", "text": "What is in this figure?" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } },
            ] },
        ]);
        let sent = for_deepseek(original.clone());
        assert_eq!(sent, original, "images have to stay in the array form");
    }

    #[test]
    fn messages_that_are_already_strings_are_left_alone() {
        let original = json!([{ "role": "system", "content": "Already plain." }]);
        assert_eq!(for_deepseek(original.clone()), original);
    }

    #[test]
    fn deepseek_usage_is_renamed_for_the_runtime() {
        let reply = json!({
            "content": "hi", "reasoning": "", "model": "deepseek-chat",
            "usage": { "prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150 },
            "tool_calls": Value::Null,
        });
        let out = shape(reply, false);
        assert_eq!(out["usage"]["promptTokens"], 120);
        assert_eq!(out["usage"]["completionTokens"], 30);
        assert_eq!(out["cancelled"], false);
        assert_eq!(out["content"], "hi");
    }

    #[test]
    fn a_cancelled_stream_is_reported_as_cancelled() {
        let out = shape(json!({ "content": "part" }), true);
        assert_eq!(out["cancelled"], true);
    }

    #[test]
    fn every_runtime_source_file_is_shipped() {
        let names: Vec<&str> = SOURCES.iter().map(|(n, _)| *n).collect();
        for required in ["__init__.py", "__main__.py", "rpc.py", "runtime.py", "agents.py", "toolkit.py"] {
            assert!(names.contains(&required), "{required} is missing from the bundle");
        }
        for (name, body) in SOURCES {
            assert!(!body.trim().is_empty(), "{name} is empty");
        }
    }
}
