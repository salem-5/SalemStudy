//! WebAssign Desk backend.
//!
//! The WebAssign bridge runs in-process (see `bridge.rs`); there is no Node
//! child process. `/api/*` calls from the webview are dispatched straight to
//! the bridge, while the userscript still talks to it over HTTP on 127.0.0.1.

mod bridge;

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use bridge::Bridge;

const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
const DEFAULT_FLASH_MODEL: &str = "deepseek-flash";
const DEFAULT_PRO_MODEL: &str = "deepseek-v4-pro";

/// AI settings, kept in a JSON file under the app config dir so the key never
/// has to live in the webview or the repo.
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct Config {
    api_key: String,
    flash_model: String,
    pro_model: String,
    base_url: String,
    max_attempts: u32,
    pause_after: u32,
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
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create config dir: {e}"))?;
    Ok(dir.join("config.json"))
}

fn read_config(app: &AppHandle) -> Config {
    let Ok(path) = config_path(app) else { return Config::default() };
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_config(app: &AppHandle, cfg: &Config) -> Result<(), String> {
    let path = config_path(app)?;
    let body = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(path, body).map_err(|e| format!("cannot write config: {e}"))
}

struct AppState {
    bridge: Bridge,
    http: reqwest::Client,
    /// Separate client: thinking-model replies can take several minutes.
    deepseek: reqwest::Client,
    /// Controls for an in-flight LaTeX export.
    export_pause: Arc<AtomicBool>,
    export_cancel: Arc<AtomicBool>,
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
    let chars: Vec<char> = c.api_key.chars().collect();
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
        "hasKey": !c.api_key.is_empty(),
        "keyHint": hint,
        "flashModel": c.flash_model,
        "proModel": c.pro_model,
        "baseUrl": c.base_url,
        "maxAttempts": c.max_attempts,
        "pauseAfter": c.pause_after,
    })
}

#[tauri::command]
fn set_config(app: AppHandle, patch: ConfigPatch) -> Result<Value, String> {
    let mut c = read_config(&app);
    if let Some(v) = patch.api_key { c.api_key = v.trim().to_string(); }
    if let Some(v) = patch.flash_model { if !v.trim().is_empty() { c.flash_model = v.trim().to_string(); } }
    if let Some(v) = patch.pro_model { if !v.trim().is_empty() { c.pro_model = v.trim().to_string(); } }
    if let Some(v) = patch.base_url { if !v.trim().is_empty() { c.base_url = v.trim().to_string(); } }
    if let Some(v) = patch.max_attempts { c.max_attempts = v.clamp(1, 10); }
    if let Some(v) = patch.pause_after { c.pause_after = v.min(10); }
    write_config(&app, &c)?;
    Ok(get_config(app))
}

/// Chat completion against DeepSeek. Images are allowed only for the Flash
/// model, and only inside user messages (DeepSeek's rule). Returns the message
/// content plus any chain-of-thought reasoning.
#[tauri::command]
async fn deepseek_chat(
    state: State<'_, AppState>,
    app: AppHandle,
    model: String,
    messages: Value,
    thinking: Option<bool>,
    effort: Option<String>,
    json: Option<bool>,
    tools: Option<Value>,
    choice: Option<Value>,
) -> Result<Value, String> {
    let c = read_config(&app);
    if c.api_key.is_empty() {
        return Err("No DeepSeek API key set. Open AI settings and paste your key.".into());
    }
    let base = if c.base_url.trim().is_empty() { DEFAULT_BASE_URL } else { c.base_url.trim() };
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));

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

    let resp = state
        .deepseek
        .post(&url)
        .header("Authorization", format!("Bearer {}", c.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("DeepSeek request failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| format!("DeepSeek returned HTTP {status}: {}", text.chars().take(600).collect::<String>()))?;

    if !status.is_success() {
        let msg = value
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .or_else(|| value.get("error").and_then(Value::as_str))
            .or_else(|| value.get("message").and_then(Value::as_str))
            .unwrap_or("request failed");
        return Err(format!("DeepSeek HTTP {}: {msg}", status.as_u16()));
    }

    let message = value.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("message")).cloned().unwrap_or(Value::Null);
    Ok(json!({
        "content": message.get("content").and_then(Value::as_str).unwrap_or(""),
        "reasoning": message.get("reasoning_content").and_then(Value::as_str).unwrap_or(""),
        "model": value.get("model").and_then(Value::as_str).unwrap_or(""),
        "usage": value.get("usage").cloned().unwrap_or(Value::Null),
        "tool_calls": message.get("tool_calls").cloned().unwrap_or(Value::Null),
    }))
}

/// Current DeepSeek account balance (`GET /user/balance`).
#[tauri::command]
async fn deepseek_balance(state: State<'_, AppState>, app: AppHandle) -> Result<Value, String> {
    let c = read_config(&app);
    if c.api_key.is_empty() {
        return Err("No DeepSeek API key set.".into());
    }
    let base = if c.base_url.trim().is_empty() { DEFAULT_BASE_URL } else { c.base_url.trim() };
    let url = format!("{}/user/balance", base.trim_end_matches('/'));
    let resp = state
        .deepseek
        .get(&url)
        .header("Authorization", format!("Bearer {}", c.api_key))
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
        return Err(format!("DeepSeek HTTP {}: {msg}", status.as_u16()));
    }
    Ok(value)
}

/// Loopback, link-local and RFC1918 addresses that a question should never be
/// able to make the app fetch.
fn is_private_host(host: &str) -> bool {
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

/// Write a LaTeX document to the Downloads folder; optionally compile it to PDF
/// with `pdflatex` (set `WA_PDFLATEX` to use a different binary).
#[derive(Deserialize)]
struct ExportImage {
    file: String,
    data: String,
}

#[tauri::command]
async fn export_latex(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    tex: String,
    compile: bool,
    images: Vec<ExportImage>,
    ai: String,
) -> Result<Value, String> {
    let dir = app
        .path()
        .document_dir()
        .or_else(|_| app.path().download_dir())
        .map_err(|e| format!("cannot find the Documents folder: {e}"))?;
    state.export_cancel.store(false, Ordering::Relaxed);
    state.export_pause.store(false, Ordering::Relaxed);
    let pause = state.export_pause.clone();
    let cancel = state.export_cancel.clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        export_latex_blocking(&app2, &dir, &name, &tex, compile, &images, &ai, &pause, &cancel)
    })
    .await
    .map_err(|e| format!("export task failed: {e}"))?
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

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    let dir = if p.is_dir() {
        p
    } else {
        p.parent().map(|d| d.to_path_buf()).unwrap_or(p)
    };
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("explorer.exe");
        cmd.arg(&dir);
        hide_window(&mut cmd);
        cmd.spawn().map_err(|e| format!("could not open the folder: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
    }
    Ok(())
}

/// Delete the intermediate files an export creates, leaving only the PDF.
fn cleanup_export(dir: &std::path::Path, base: &str, images: &[ExportImage]) {
    let mut names: Vec<String> = vec![
        format!("{base}.tex"),
        format!("{base}.ai.json"),
        "ai-reference.json".to_string(),
    ];
    for ext in ["aux", "log", "out", "fls", "fdb_latexmk", "synctex.gz", "toc"] {
        names.push(format!("{base}.{ext}"));
    }
    for img in images {
        names.push(safe_name(&img.file));
    }
    for n in names {
        let _ = std::fs::remove_file(dir.join(n));
    }
    // Any figure PNGs this app wrote for the export.
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("figure-") && name.ends_with(".png") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

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
fn hide_window(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

fn find_pdflatex() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("WA_PDFLATEX") {
        let pb = std::path::PathBuf::from(&p);
        if pb.exists() {
            return Some(pb);
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            for exe in ["pdflatex.exe", "pdflatex"] {
                let cand = dir.join(exe);
                if cand.exists() {
                    return Some(cand);
                }
            }
        }
    }
    for base in [std::env::var("LOCALAPPDATA").ok(), std::env::var("ProgramFiles").ok()] {
        if let Some(base) = base {
            let cand = std::path::PathBuf::from(&base).join("Programs/MiKTeX/miktex/bin/x64/pdflatex.exe");
            if cand.exists() {
                return Some(cand);
            }
            let cand = std::path::PathBuf::from(&base).join("MiKTeX/miktex/bin/x64/pdflatex.exe");
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn export_latex_blocking(
    app: &AppHandle,
    dir: &std::path::Path,
    name: &str,
    tex: &str,
    compile: bool,
    images: &[ExportImage],
    ai: &str,
    pause: &AtomicBool,
    cancel: &AtomicBool,
) -> Result<Value, String> {
    let emit = |stage: &str, line: &str| {
        let _ = app.emit("export://progress", json!({ "stage": stage, "line": line }));
    };
    emit("stage", "Writing files…");
    std::fs::create_dir_all(dir).ok();
    let base = safe_name(name);
    let tex_path = dir.join(format!("{base}.tex"));
    std::fs::write(&tex_path, tex).map_err(|e| format!("could not write the .tex file: {e}"))?;
    let tex_s = tex_path.to_string_lossy().to_string();

    // Figures, written next to the .tex so \includegraphics finds them.
    for img in images {
        let file = safe_name(&img.file);
        let b64 = img.data.split_once(',').map(|(_, b)| b).unwrap_or(&img.data);
        match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(bytes) => {
                let _ = std::fs::write(dir.join(file), bytes);
            }
            Err(e) => eprintln!("skipping image {}: {e}", img.file),
        }
    }

    // Machine-readable companion for AIs.
    let ai_path = dir.join(format!("{base}.ai.json"));
    let ai_s = ai_path.to_string_lossy().to_string();
    std::fs::write(&ai_path, ai).map_err(|e| format!("could not write the .ai.json file: {e}"))?;
    // The PDF embeds this copy (fixed, space-free name) as an attachment.
    let _ = std::fs::write(dir.join("ai-reference.json"), ai);

    if !compile {
        emit("stage", "Saved LaTeX source.");
        return Ok(json!({ "tex": tex_s, "pdf": Value::Null, "ai": ai_s }));
    }

    let bin = match find_pdflatex() {
        Some(b) => b,
        None => {
            return Err(format!(
                "Could not find pdflatex. Install a TeX distribution (MiKTeX or TeX Live), or set WA_PDFLATEX to its full path. The .tex and .ai.json were saved to {}.",
                dir.display()
            ));
        }
    };
    let bin_dir = bin.parent().map(|p| p.to_path_buf());

    // MiKTeX aborts on malformed PATH entries, so give the child a clean one.
    let mut paths = Vec::new();
    if let Some(bd) = bin_dir {
        paths.push(bd);
    }
    if let Ok(sys) = std::env::var("SystemRoot") {
        paths.push(std::path::PathBuf::from(&sys).join("System32"));
        paths.push(std::path::PathBuf::from(&sys));
    }
    let clean_path = std::env::join_paths(paths).unwrap_or_default();

    let mut tail: Vec<String> = Vec::new();
    // Two passes so hyperref/bookmarks settle.
    for pass in 0..2 {
        if cancel.load(Ordering::Relaxed) {
            return Err("Export cancelled.".into());
        }
        emit("pass", &format!("pdflatex pass {}/2", pass + 1));
        let mut cmd = std::process::Command::new(&bin);
        cmd.arg("-interaction=nonstopmode")
            .arg("-halt-on-error")
            .arg("-output-directory")
            .arg(dir)
            .arg(&tex_path)
            .current_dir(dir)
            .env("PATH", &clean_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        hide_window(&mut cmd);
        let child = cmd.spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                return Err(format!(
                    "Could not run '{}' ({e}). Install a TeX distribution or set WA_PDFLATEX. The .tex and .ai.json were saved.",
                    bin.display()
                ));
            }
        };

        if let Some(stdout) = child.stdout.take() {
            let mut reader = BufReader::new(stdout);
            let mut buf = String::new();
            loop {
                if cancel.load(Ordering::Relaxed) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Export cancelled.".into());
                }
                while pause.load(Ordering::Relaxed) && !cancel.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(120));
                }
                buf.clear();
                match reader.read_line(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let line = buf.trim_end().to_string();
                        tail.push(line.clone());
                        if tail.len() > 500 {
                            tail.remove(0);
                        }
                        emit("log", &line);
                    }
                }
            }
        }
        let _ = child.wait();
    }

    let pdf = dir.join(format!("{base}.pdf"));
    if pdf.exists() {
        let final_pdf = dir.join(format!("{base} - WebAssign.pdf"));
        let _ = std::fs::rename(&pdf, &final_pdf);
        cleanup_export(dir, &base, images);
        let out_pdf = if final_pdf.exists() { final_pdf } else { pdf };
        emit("stage", "PDF built.");
        Ok(json!({ "tex": tex_s, "pdf": out_pdf.to_string_lossy(), "ai": ai_s }))
    } else {
        let last: Vec<&str> = tail.iter().rev().take(25).map(|s| s.as_str()).collect();
        let last: Vec<&str> = last.into_iter().rev().collect();
        Err(format!("pdflatex could not build the PDF:\n{}", last.join("\n")))
    }
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
        .manage(AppState {
            bridge: bridge.clone(),
            http,
            deepseek,
            export_pause: Arc::new(AtomicBool::new(false)),
            export_cancel: Arc::new(AtomicBool::new(false)),
        })
        .setup(move |_app| {
            start_server(bridge.clone());
            bridge::spawn_logger(bridge.clone());
            Ok(())
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
            deepseek_balance,
            export_latex,
            export_pause,
            export_cancel,
            reveal_path
        ])
        .build(tauri::generate_context!())
        .expect("error while building WebAssign Desk");

    app.run(|_, _| {});
}
