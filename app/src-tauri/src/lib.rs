//! WebAssign Desk backend.
//!
//! The WebAssign bridge runs in-process (see `bridge.rs`); there is no Node
//! child process. `/api/*` calls from the webview are dispatched straight to
//! the bridge, while the userscript still talks to it over HTTP on 127.0.0.1.

mod bridge;
mod python;

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

const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
const DEFAULT_FLASH_MODEL: &str = "deepseek-flash";
const DEFAULT_PRO_MODEL: &str = "deepseek-v4-pro";

/// AI settings, kept in a JSON file under the app config dir so the key never
/// has to live in the webview or the repo.
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Config {
    api_key: String,
    flash_model: String,
    pro_model: String,
    base_url: String,
    max_attempts: u32,
    pause_after: u32,
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
            python_enabled: true,
            python_auto: true,
            python_path: String::new(),
            python_timeout: 25,
            python_memory_mb: 4096,
            python_max_calls: 6,
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
    python_enabled: Option<bool>,
    python_auto: Option<bool>,
    python_path: Option<String>,
    python_timeout: Option<u32>,
    python_memory_mb: Option<u32>,
    python_max_calls: Option<u32>,
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
    /// Controls for in-flight LaTeX exports. Several run at once, and they
    /// share the pause/cancel switches: the dialog's buttons stop the batch.
    export_pause: Arc<AtomicBool>,
    export_cancel: Arc<AtomicBool>,
    /// Exports currently running, so only the first one of a batch clears the
    /// switches that a later Cancel sets.
    export_active: Arc<AtomicUsize>,
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
        "pythonEnabled": c.python_enabled,
        "pythonAuto": c.python_auto,
        "pythonPath": c.python_path,
        "pythonTimeout": c.python_timeout,
        "pythonMemoryMb": c.python_memory_mb,
        "pythonMaxCalls": c.python_max_calls,
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
    if let Some(v) = patch.python_enabled { c.python_enabled = v; }
    if let Some(v) = patch.python_auto { c.python_auto = v; }
    if let Some(v) = patch.python_path { c.python_path = v.trim().to_string(); }
    if let Some(v) = patch.python_timeout { c.python_timeout = v.clamp(1, 180); }
    if let Some(v) = patch.python_memory_mb { c.python_memory_mb = v.clamp(256, 16384); }
    if let Some(v) = patch.python_max_calls { c.python_max_calls = v.clamp(1, 20); }
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

/// Export one assignment. Several of these run at once when a batch is
/// exported, so each builds in a scratch folder of its own — every document
/// names its figures `figure-1.png`, and two jobs sharing a folder would
/// overwrite each other's.
#[tauri::command]
async fn export_latex(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    tex: String,
    compile: bool,
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
    let job = job.unwrap_or_else(|| name.clone());
    let out = tauri::async_runtime::spawn_blocking(move || {
        let r = export_latex_blocking(&app2, &dir, &work, &name, &tex, compile, &images, &pause, &cancel, &job);
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
fn hide_window(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// The TeX program an export runs: MiKTeX/TeX Live's pdflatex, or Tectonic,
/// which is a single binary that fetches what a document needs by itself.
#[derive(Clone, Copy, PartialEq)]
enum TexEngine {
    PdfLatex,
    Tectonic,
}

impl TexEngine {
    fn name(self) -> &'static str {
        match self {
            TexEngine::PdfLatex => "pdflatex",
            TexEngine::Tectonic => "tectonic",
        }
    }
}

struct Tex {
    bin: std::path::PathBuf,
    engine: TexEngine,
}

fn exe_in(dir: &std::path::Path, stem: &str) -> Option<std::path::PathBuf> {
    for name in [format!("{stem}.exe"), stem.to_string()] {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// Places a TeX binary lives that are not always on a GUI app's PATH.
fn extra_tex_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    let home = std::env::var("HOME").ok().or_else(|| std::env::var("USERPROFILE").ok());
    if let Some(home) = &home {
        for rel in [".cargo/bin", ".local/bin"] {
            dirs.push(std::path::PathBuf::from(home).join(rel));
        }
    }
    #[cfg(windows)]
    for base in [std::env::var("LOCALAPPDATA").ok(), std::env::var("ProgramFiles").ok()] {
        if let Some(base) = base {
            let base = std::path::PathBuf::from(&base);
            dirs.push(base.join("Programs/MiKTeX/miktex/bin/x64"));
            dirs.push(base.join("MiKTeX/miktex/bin/x64"));
            dirs.push(base.join("Programs/Tectonic"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        dirs.push(std::path::PathBuf::from("/Library/TeX/texbin"));
        dirs.push(std::path::PathBuf::from("/opt/homebrew/bin"));
        dirs.push(std::path::PathBuf::from("/usr/local/bin"));
        dirs.push(std::path::PathBuf::from("/opt/local/bin"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs.push(std::path::PathBuf::from("/usr/local/bin"));
        dirs.push(std::path::PathBuf::from("/usr/bin"));
        dirs.push(std::path::PathBuf::from("/var/lib/flatpak/exports/bin"));
        dirs.push(std::path::PathBuf::from("/snap/bin"));
        if let Some(home) = &home {
            dirs.push(std::path::PathBuf::from(home).join(".nix-profile/bin"));
        }
    }
    dirs
}

fn look_up(stem: &str) -> Option<std::path::PathBuf> {
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            if let Some(found) = exe_in(&dir, stem) {
                return Some(found);
            }
        }
    }
    extra_tex_dirs().iter().find_map(|d| exe_in(d, stem))
}

/// Windows machines usually have MiKTeX, so pdflatex comes first there;
/// elsewhere Tectonic is the one binary people can install in a second.
fn find_tex() -> Option<Tex> {
    for (var, engine) in [("WA_PDFLATEX", TexEngine::PdfLatex), ("WA_TECTONIC", TexEngine::Tectonic)] {
        if let Ok(p) = std::env::var(var) {
            let bin = std::path::PathBuf::from(&p);
            if bin.is_file() {
                return Some(Tex { bin, engine });
            }
        }
    }
    let order = if cfg!(windows) {
        [TexEngine::PdfLatex, TexEngine::Tectonic]
    } else {
        [TexEngine::Tectonic, TexEngine::PdfLatex]
    };
    order
        .into_iter()
        .find_map(|engine: TexEngine| look_up(engine.name()).map(|bin| Tex { bin, engine }))
}

/// What to tell someone who has no TeX installed, for their own platform.
fn install_tex_help() -> &'static str {
    if cfg!(windows) {
        "Install MiKTeX (https://miktex.org/download) or Tectonic (https://tectonic-typesetting.github.io/install.html), then try again. You can also point WA_PDFLATEX or WA_TECTONIC at the binary."
    } else if cfg!(target_os = "macos") {
        "Install Tectonic with 'brew install tectonic' (or MacTeX for a full TeX Live), then try again. You can also point WA_TECTONIC or WA_PDFLATEX at the binary."
    } else {
        "Install Tectonic with your package manager ('sudo apt install tectonic', 'sudo dnf install tectonic', 'sudo pacman -S tectonic') or 'cargo install tectonic'; TeX Live's pdflatex works too. You can also point WA_TECTONIC or WA_PDFLATEX at the binary."
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
fn export_latex_blocking<R: tauri::Runtime>(
    app: &AppHandle<R>,
    dir: &std::path::Path,
    work: &std::path::Path,
    name: &str,
    tex: &str,
    compile: bool,
    images: &[ExportImage],
    pause: &AtomicBool,
    cancel: &AtomicBool,
    job: &str,
) -> Result<Value, String> {
    let emit = |stage: &str, line: &str| {
        // `job` tells the dialog which document a line belongs to when several
        // are compiling at once.
        let _ = app.emit("export://progress", json!({ "job": job, "stage": stage, "line": line }));
    };
    emit("stage", "Writing files…");
    std::fs::create_dir_all(dir).ok();
    let base = safe_name(name);
    // Everything is written into this job's own folder; only the finished
    // files move to `dir`.
    let tex_path = work.join(format!("{base}.tex"));
    std::fs::write(&tex_path, tex).map_err(|e| format!("could not write the .tex file: {e}"))?;
    let out_tex = dir.join(format!("{base}.tex"));

    // Figures, written next to the .tex so \includegraphics finds them.
    let mut figures: Vec<std::path::PathBuf> = Vec::new();
    for img in images {
        let file = safe_name(&img.file);
        let b64 = img.data.split_once(',').map(|(_, b)| b).unwrap_or(&img.data);
        match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(bytes) => {
                let path = work.join(&file);
                if std::fs::write(&path, bytes).is_ok() {
                    figures.push(path);
                }
            }
            Err(e) => eprintln!("skipping image {}: {e}", img.file),
        }
    }

    // The saved source is only useful with its figures beside it.
    let save_source = |figs: &[std::path::PathBuf]| -> Result<String, String> {
        move_out(&tex_path, &out_tex)?;
        for f in figs {
            if let Some(n) = f.file_name() {
                let _ = move_out(f, &dir.join(n));
            }
        }
        Ok(out_tex.to_string_lossy().to_string())
    };

    if !compile {
        let saved = save_source(&figures)?;
        emit("stage", "Saved LaTeX source.");
        return Ok(json!({ "tex": saved, "pdf": Value::Null }));
    }

    let tex_bin = match find_tex() {
        Some(t) => t,
        None => {
            let _ = save_source(&figures);
            return Err(format!(
                "Could not find a TeX engine to build the PDF. {} The .tex file was saved to {}.",
                install_tex_help(),
                dir.display()
            ));
        }
    };
    let bin = tex_bin.bin.clone();
    let engine = tex_bin.engine;

    // MiKTeX aborts on malformed PATH entries, so give the child a clean one
    // built from the binary's own directory plus the system essentials.
    let mut paths = Vec::new();
    if let Some(bd) = bin.parent() {
        paths.push(bd.to_path_buf());
    }
    #[cfg(windows)]
    if let Ok(sys) = std::env::var("SystemRoot") {
        paths.push(std::path::PathBuf::from(&sys).join("System32"));
        paths.push(std::path::PathBuf::from(&sys));
    }
    #[cfg(not(windows))]
    for d in ["/usr/bin", "/bin", "/usr/local/bin"] {
        paths.push(std::path::PathBuf::from(d));
    }
    let clean_path = std::env::join_paths(paths).unwrap_or_default();

    let mut tail: Vec<String> = Vec::new();
    // pdflatex needs two passes for hyperref to settle; Tectonic reruns itself.
    let passes = if engine == TexEngine::Tectonic { 1 } else { 2 };
    for pass in 0..passes {
        if cancel.load(Ordering::Relaxed) {
            return Err("Export cancelled.".into());
        }
        emit("pass", &format!("{} pass {}/{}", engine.name(), pass + 1, passes));
        let mut cmd = std::process::Command::new(&bin);
        match engine {
            TexEngine::PdfLatex => {
                cmd.arg("-interaction=nonstopmode")
                    .arg("-halt-on-error")
                    .arg("-output-directory")
                    .arg(work)
                    .arg(&tex_path);
            }
            TexEngine::Tectonic => {
                // Tectonic downloads what the document needs on first use, so
                // the first export on a new machine wants a network connection.
                cmd.arg("--outdir").arg(work).arg("--chatter").arg("minimal").arg(&tex_path);
            }
        }
        // The build happens entirely inside this job's folder: the .aux, .log
        // and figures belong to it alone, so parallel exports cannot collide.
        cmd.current_dir(work).env("PATH", &clean_path);
        // pdflatex reports on stdout, Tectonic on stderr.
        if engine == TexEngine::Tectonic {
            cmd.stdout(Stdio::null()).stderr(Stdio::piped());
        } else {
            cmd.stdout(Stdio::piped()).stderr(Stdio::null());
        }
        hide_window(&mut cmd);
        let child = cmd.spawn();
        let mut child = match child {
            Ok(c) => c,
            Err(e) => {
                let _ = save_source(&figures);
                return Err(format!(
                    "Could not run '{}' ({e}). {} The .tex file was saved.",
                    bin.display(),
                    install_tex_help()
                ));
            }
        };

        let out: Option<Box<dyn std::io::Read + Send>> = if engine == TexEngine::Tectonic {
            child.stderr.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>)
        } else {
            child.stdout.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>)
        };
        if let Some(out) = out {
            let mut reader = BufReader::new(out);
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

    let built = work.join(format!("{base}.pdf"));
    if built.exists() {
        // Only the PDF leaves the build folder, under exactly the name the
        // export dialog asked for; the source and the figures go with the
        // folder when it is deleted.
        let pdf = dir.join(format!("{base}.pdf"));
        move_out(&built, &pdf)?;
        emit("stage", "PDF built.");
        Ok(json!({ "tex": Value::Null, "pdf": pdf.to_string_lossy() }))
    } else {
        // Nothing to open, so leave the user the source to look at.
        let saved = save_source(&figures).unwrap_or_default();
        let last: Vec<&str> = tail.iter().rev().take(25).map(|s| s.as_str()).collect();
        let last: Vec<&str> = last.into_iter().rev().collect();
        Err(format!(
            "{} could not build the PDF (the .tex was saved to {saved}):\n{}",
            engine.name(),
            last.join("\n")
        ))
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
            export_active: Arc::new(AtomicUsize::new(0)),
        })
        .setup(move |app| {
            start_server(bridge.clone());
            bridge::spawn_logger(bridge.clone());
            // Sandbox folders only ever outlive a run after a crash.
            python::sweep_sandboxes(&app.handle().clone());
            sweep_exports(&app.handle().clone());
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
            export_dir,
            open_path,
            reveal_path,
            python::python_status,
            python::python_setup,
            python::run_python
        ])
        .build(tauri::generate_context!())
        .expect("error while building WebAssign Desk");

    app.run(|_, _| {});
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

    /// Three documents compiled at once land as three PDFs, and nothing else
    /// is left in the export folder.
    #[test]
    fn parallel_exports_do_not_collide() {
        if find_tex().is_none() {
            eprintln!("skipped: no TeX engine on this machine");
            return;
        }
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
                let tex = doc(&name);
                std::thread::spawn(move || {
                    fs::create_dir_all(&work).unwrap();
                    let pause = AtomicBool::new(false);
                    let cancel = AtomicBool::new(false);
                    let r = export_latex_blocking(
                        &handle, &out, &work, &name, &tex, true, &figures(), &pause, &cancel, &name,
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

    /// Saving the source keeps the figures beside it, so it still compiles.
    #[test]
    fn saving_source_keeps_the_figures() {
        let app = tauri::test::mock_app();
        let root = std::env::temp_dir().join(format!(
            "wa-export-src-{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let out = root.join("out");
        let work = root.join("work");
        fs::create_dir_all(&out).unwrap();
        fs::create_dir_all(&work).unwrap();
        let pause = AtomicBool::new(false);
        let cancel = AtomicBool::new(false);
        let v = export_latex_blocking(
            &app.handle().clone(), &out, &work, "Delta sheet", &doc("Delta"), false, &figures(), &pause, &cancel, "Delta",
        )
        .unwrap();
        assert!(v["pdf"].is_null());
        assert!(std::path::Path::new(v["tex"].as_str().unwrap()).exists());
        assert!(out.join("figure-1.png").exists(), "the figure should sit next to the .tex");
        let _ = fs::remove_dir_all(&root);
    }
}
