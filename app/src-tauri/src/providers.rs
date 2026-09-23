//! Which model answers, and how to talk to it.
//!
//! Every call the app makes is an OpenAI-style chat completion, so a provider
//! is three things: where its endpoint is, the key for it, and what its models
//! will accept. The catalogue of providers and models comes from models.dev
//! (the same one opencode uses), cached on disk; the student picks a provider,
//! gives its key, and picks a model from its list.
//!
//! Local models go through Ollama's own OpenAI-compatible endpoint. Ollama is
//! started when it is needed, and when Salem quits the models it loaded are
//! unloaded and Ollama is stopped, so a closed Salem is not still holding
//! gigabytes of a model in memory.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::Config;

pub const DEEPSEEK: &str = "deepseek";
pub const OLLAMA: &str = "ollama";
const OLLAMA_HOST: &str = "http://127.0.0.1:11434";
const CATALOG_URL: &str = "https://models.dev/api.json";
const CATALOG_FILE: &str = "models-catalog.json";
const CATALOG_MAX_AGE: Duration = Duration::from_secs(24 * 3600);

/// What the app keeps about a chosen model: its price and what it accepts.
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelInfo {
    /// USD per million tokens.
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    /// Takes `reasoning_effort`.
    pub effort: bool,
    /// The most it will write in one reply; 0 when unknown.
    pub max_output: u64,
    pub vision: bool,
    pub tools: bool,
}

/// OpenAI-compatible endpoints for providers the catalogue lists without one
/// (they ship their own SDK, but also answer the OpenAI shape here).
pub fn known_base(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "deepseek" => "https://api.deepseek.com",
        "openai" => "https://api.openai.com/v1",
        "anthropic" => "https://api.anthropic.com/v1",
        "google" => "https://generativelanguage.googleapis.com/v1beta/openai",
        "groq" => "https://api.groq.com/openai/v1",
        "xai" => "https://api.x.ai/v1",
        "mistral" => "https://api.mistral.ai/v1",
        "cerebras" => "https://api.cerebras.ai/v1",
        "togetherai" => "https://api.together.xyz/v1",
        "deepinfra" => "https://api.deepinfra.com/v1/openai",
        "perplexity" => "https://api.perplexity.ai",
        "cohere" => "https://api.cohere.ai/compatibility/v1",
        "venice" => "https://api.venice.ai/api/v1",
        "aihubmix" => "https://aihubmix.com/v1",
        "vercel" => "https://ai-gateway.vercel.sh/v1",
        "v0" => "https://api.v0.dev/v1",
        "ollama" => "http://127.0.0.1:11434/v1",
        _ => return None,
    })
}

/// Where a request goes and with what key.
pub struct Endpoint {
    pub provider: String,
    pub base: String,
    pub key: String,
}

impl Endpoint {
    pub fn url(&self, path: &str) -> String {
        format!("{}/{}", self.base.trim_end_matches('/'), path.trim_start_matches('/'))
    }

    /// The key as a bearer token, where there is one (Ollama has none).
    pub fn authorise(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if self.key.is_empty() { req } else { req.header("Authorization", format!("Bearer {}", self.key)) }
    }

    pub fn is_local(&self) -> bool { self.provider == OLLAMA }
}

pub fn provider_of(cfg: &Config) -> String {
    let p = cfg.provider.trim();
    if p.is_empty() { DEEPSEEK.to_string() } else { p.to_string() }
}

/// The saved key for a provider. DeepSeek's lived in `api_key` before there
/// were others, and still counts.
pub fn key_for(cfg: &Config, provider: &str) -> String {
    cfg.keys.get(provider).cloned().filter(|k| !k.is_empty())
        .or_else(|| (provider == DEEPSEEK && !cfg.api_key.is_empty()).then(|| cfg.api_key.clone()))
        .unwrap_or_default()
}

pub fn endpoint(cfg: &Config) -> Result<Endpoint, String> {
    let provider = provider_of(cfg);
    let base = if provider == OLLAMA {
        format!("{OLLAMA_HOST}/v1")
    } else if !cfg.base_url.trim().is_empty() {
        cfg.base_url.trim().to_string()
    } else {
        known_base(&provider).map(str::to_string).ok_or_else(|| format!("No endpoint is known for {provider}. Pick the provider again in Settings."))?
    };
    let key = key_for(cfg, &provider);
    if key.is_empty() && provider != OLLAMA {
        return Err(format!("No API key for {provider} yet. Add one in Settings → Model."));
    }
    Ok(Endpoint { provider, base, key })
}

/// Fit a request to what this provider and model accept.
///
/// `thinking` is DeepSeek's own switch; sent anywhere else it is an unknown
/// field, and some endpoints refuse the whole request over one. The same goes
/// for `reasoning_effort` on a model without reasoning, and for a
/// `max_tokens` larger than the model can write.
pub fn shape(ep: &Endpoint, cfg: &Config, body: &mut Value) {
    let model = body.get("model").and_then(Value::as_str).unwrap_or("").to_string();
    let info = cfg.models_info.get(&model);
    let Some(obj) = body.as_object_mut() else { return };
    if ep.provider != DEEPSEEK {
        obj.remove("thinking");
    }
    let effort_ok = ep.provider == DEEPSEEK || info.map(|i| i.effort).unwrap_or(false);
    if !effort_ok {
        obj.remove("reasoning_effort");
    }
    if let Some(limit) = info.map(|i| i.max_output).filter(|n| *n > 0) {
        let asked = obj.get("max_tokens").and_then(Value::as_u64).unwrap_or(16_384);
        obj.insert("max_tokens".into(), json!(asked.min(limit)));
    }
}

/// Send a request, waiting out a rate limit rather than failing on it.
///
/// Free tiers answer 429 after a handful of requests a minute, and a deck
/// sends several passes at once. Each 429 (or 503, "overloaded") is retried
/// after as long as the provider asks — its `Retry-After` header, or the
/// "retry in 8.8s" in Google's message — up to a limit, so a busy minute
/// slows a deck down instead of losing it.
pub async fn send(build: impl Fn() -> reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    const TRIES: u32 = 5;
    const MOST_WAIT: f64 = 65.0;
    let mut waited = 0.0;
    for attempt in 0..TRIES {
        let resp = build().send().await.map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        if (status != 429 && status != 503) || attempt + 1 == TRIES {
            return Ok(resp);
        }
        let header = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<f64>().ok());
        let text = resp.text().await.unwrap_or_default();
        let wait = header.or_else(|| retry_hint(&text)).unwrap_or(2f64.powi(attempt as i32 + 1)).clamp(1.0, 30.0);
        if waited + wait > MOST_WAIT {
            return Err(format!("the provider is rate-limiting requests (HTTP {status}): {}", error_text(&text)));
        }
        waited += wait;
        tokio::time::sleep(Duration::from_secs_f64(wait)).await;
    }
    unreachable!()
}

/// "Please retry in 8.797463943s." → 8.8
fn retry_hint(text: &str) -> Option<f64> {
    let at = text.find("retry in ")? + "retry in ".len();
    let num: String = text[at..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    num.parse::<f64>().ok().map(|n| n + 0.5)
}

/// The message out of an error body, whatever shape the provider uses:
/// `{"error": {"message"}}`, Google's `[{"error": …}]`, or plain text.
pub fn error_text(text: &str) -> String {
    let v: Option<Value> = serde_json::from_str(text).ok();
    let v = v.map(|v| if let Some(first) = v.as_array().and_then(|a| a.first()) { first.clone() } else { v });
    v.as_ref()
        .and_then(|v| v.get("error").and_then(|e| e.get("message").and_then(Value::as_str).or_else(|| e.as_str()))
            .or_else(|| v.get("message").and_then(Value::as_str)))
        .map(|m| m.lines().next().unwrap_or(m).to_string())
        .unwrap_or_else(|| text.chars().take(400).collect())
}

/// USD per million tokens (cache hit, cache miss, output) for a model, when
/// the app knows it. Local models are free.
pub fn price(cfg: &Config, model: &str) -> Option<(f64, f64, f64)> {
    if provider_of(cfg) == OLLAMA {
        return Some((0.0, 0.0, 0.0));
    }
    cfg.models_info.get(model).map(|i| (if i.cache_read > 0.0 { i.cache_read } else { i.input }, i.input, i.output))
}

// ---------------------------------------------------------------- catalogue

fn catalog_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(CATALOG_FILE))
}

/// Only what the settings page shows: models.dev's file is ~5 MB, most of it
/// descriptions and dates the app never reads.
fn trim(full: &Value) -> Value {
    let mut out = Map::new();
    let Some(providers) = full.as_object() else { return Value::Object(out) };
    for (id, p) in providers {
        let base = p.get("api").and_then(Value::as_str).map(str::to_string).or_else(|| known_base(id).map(str::to_string));
        let mut models = Vec::new();
        if let Some(ms) = p.get("models").and_then(Value::as_object) {
            for (mid, m) in ms {
                let input_mods = m.pointer("/modalities/input").and_then(Value::as_array).cloned().unwrap_or_default();
                let effort = m.get("reasoning_options").and_then(Value::as_array)
                    .map(|o| o.iter().any(|x| x.get("type").and_then(Value::as_str) == Some("effort")))
                    .unwrap_or(false);
                models.push(json!({
                    "id": mid,
                    "name": m.get("name").and_then(Value::as_str).unwrap_or(mid),
                    "reasoning": m.get("reasoning").and_then(Value::as_bool).unwrap_or(false),
                    "effort": effort,
                    "tools": m.get("tool_call").and_then(Value::as_bool).unwrap_or(false),
                    "vision": input_mods.iter().any(|x| x.as_str() == Some("image")),
                    "input": m.pointer("/cost/input").and_then(Value::as_f64).unwrap_or(0.0),
                    "output": m.pointer("/cost/output").and_then(Value::as_f64).unwrap_or(0.0),
                    "cacheRead": m.pointer("/cost/cache_read").and_then(Value::as_f64).unwrap_or(0.0),
                    "context": m.pointer("/limit/context").and_then(Value::as_u64).unwrap_or(0),
                    "maxOutput": m.pointer("/limit/output").and_then(Value::as_u64).unwrap_or(0),
                    "status": m.get("status").and_then(Value::as_str).unwrap_or(""),
                    "released": m.get("release_date").and_then(Value::as_str).unwrap_or(""),
                }));
            }
        }
        out.insert(id.clone(), json!({
            "id": id,
            "name": p.get("name").and_then(Value::as_str).unwrap_or(id),
            "base": base,
            "doc": p.get("doc").and_then(Value::as_str).unwrap_or(""),
            "env": p.get("env").cloned().unwrap_or(json!([])),
            "models": models,
        }));
    }
    Value::Object(out)
}

/// The provider catalogue, from disk if it is less than a day old, otherwise
/// fetched afresh from models.dev (and the old copy used if that fails).
#[tauri::command]
pub async fn providers_catalog(app: AppHandle, refresh: Option<bool>) -> Result<Value, String> {
    let path = catalog_path(&app);
    let cached = path.as_ref().and_then(|p| {
        let fresh = std::fs::metadata(p).ok()?.modified().ok()
            .and_then(|m| SystemTime::now().duration_since(m).ok())
            .map(|age| age < CATALOG_MAX_AGE)
            .unwrap_or(false);
        let text = std::fs::read_to_string(p).ok()?;
        Some((fresh, serde_json::from_str::<Value>(&text).ok()?))
    });
    if let Some((true, value)) = &cached {
        if refresh != Some(true) {
            return Ok(value.clone());
        }
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(40)).build().map_err(|e| e.to_string())?;
    let fetched = async {
        let resp = client.get(CATALOG_URL).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("models.dev answered HTTP {}", resp.status().as_u16()));
        }
        let full: Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok::<Value, String>(trim(&full))
    }.await;
    match fetched {
        Ok(value) => {
            if let Some(p) = &path {
                if let Some(dir) = p.parent() { let _ = std::fs::create_dir_all(dir); }
                let _ = std::fs::write(p, serde_json::to_string(&value).unwrap_or_default());
            }
            Ok(value)
        }
        Err(e) => cached.map(|(_, v)| v).ok_or_else(|| format!("Could not load the model list from models.dev: {e}")),
    }
}

// ------------------------------------------------------------------- ollama

/// The `ollama serve` Salem started itself, if it did.
#[derive(Default)]
pub struct OllamaProc(pub Mutex<Option<std::process::Child>>);

fn http() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(10)).build().expect("http client")
}

async fn ollama_up() -> Option<Value> {
    let client = reqwest::Client::builder().timeout(Duration::from_millis(1500)).build().ok()?;
    let resp = client.get(format!("{OLLAMA_HOST}/api/version")).send().await.ok()?;
    resp.json::<Value>().await.ok()
}

/// Where the `ollama` program is: on the PATH, or where its installers put it.
fn ollama_binary() -> Option<PathBuf> {
    let name = if cfg!(windows) { "ollama.exe" } else { "ollama" };
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join(name);
            if p.is_file() { return Some(p); }
        }
    }
    let mut known: Vec<PathBuf> = vec![
        "/opt/homebrew/bin/ollama".into(),
        "/usr/local/bin/ollama".into(),
        "/usr/bin/ollama".into(),
        "/Applications/Ollama.app/Contents/Resources/ollama".into(),
    ];
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        known.push(PathBuf::from(local).join("Programs").join("Ollama").join("ollama.exe"));
    }
    known.into_iter().find(|p| p.is_file())
}

/// Start Ollama if it is not already answering, and wait for it.
pub async fn ensure_ollama(app: &AppHandle) -> Result<(), String> {
    if ollama_up().await.is_some() {
        return Ok(());
    }
    let bin = ollama_binary().ok_or("Ollama is not installed. Install it from ollama.com, then pull a model (e.g. `ollama pull llama3.1`).")?;
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("serve").stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    crate::hide_window(&mut cmd);
    let child = cmd.spawn().map_err(|e| format!("Could not start Ollama: {e}"))?;
    if let Ok(mut slot) = app.state::<OllamaProc>().0.lock() {
        *slot = Some(child);
    }
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if ollama_up().await.is_some() {
            return Ok(());
        }
    }
    Err("Ollama was started but is not answering yet. Try again in a moment.".into())
}

/// Unload every model Ollama has in memory, then stop Ollama.
///
/// Unloading first matters: it is the model, not the server, that holds the
/// gigabytes. Then the server goes too — the one Salem started, and the
/// Ollama app if that is what was running — so nothing is left behind. It
/// comes back on its own the next time a local model is asked for.
pub async fn stop_ollama(app: &AppHandle) -> Value {
    let client = http();
    let mut unloaded = Vec::new();
    if let Ok(resp) = client.get(format!("{OLLAMA_HOST}/api/ps")).send().await {
        if let Ok(ps) = resp.json::<Value>().await {
            for m in ps.get("models").and_then(Value::as_array).cloned().unwrap_or_default() {
                let Some(name) = m.get("name").and_then(Value::as_str) else { continue };
                let _ = client
                    .post(format!("{OLLAMA_HOST}/api/generate"))
                    .json(&json!({ "model": name, "keep_alive": 0 }))
                    .send()
                    .await;
                unloaded.push(name.to_string());
            }
        }
    }
    if let Ok(mut slot) = app.state::<OllamaProc>().0.lock() {
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    if ollama_up().await.is_some() {
        kill_ollama();
    }
    json!({ "unloaded": unloaded })
}

/// Stop an Ollama Salem did not start (the desktop app, a service).
fn kill_ollama() {
    let run = |program: &str, args: &[&str]| {
        let mut cmd = std::process::Command::new(program);
        cmd.args(args).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        crate::hide_window(&mut cmd);
        let _ = cmd.status();
    };
    #[cfg(target_os = "macos")]
    {
        run("osascript", &["-e", "quit app \"Ollama\""]);
        run("pkill", &["-x", "ollama"]);
    }
    #[cfg(windows)]
    {
        run("taskkill", &["/F", "/IM", "ollama app.exe"]);
        run("taskkill", &["/F", "/IM", "ollama.exe"]);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    run("pkill", &["-x", "ollama"]);
}

#[tauri::command]
pub async fn ollama_status() -> Value {
    let installed = ollama_binary().is_some();
    let Some(version) = ollama_up().await else {
        return json!({ "installed": installed, "running": false, "version": Value::Null, "models": [], "loaded": [] });
    };
    let client = http();
    let get = |path: &'static str| {
        let client = client.clone();
        async move {
            client.get(format!("{OLLAMA_HOST}{path}")).send().await.ok()?.json::<Value>().await.ok()
        }
    };
    let tags = get("/api/tags").await;
    let ps = get("/api/ps").await;
    let models: Vec<Value> = tags.and_then(|t| t.get("models").cloned()).and_then(|m| m.as_array().cloned()).unwrap_or_default()
        .into_iter()
        .map(|m| json!({
            "id": m.get("name").cloned().unwrap_or(Value::Null),
            "size": m.get("size").cloned().unwrap_or(Value::Null),
            "family": m.pointer("/details/family").cloned().unwrap_or(Value::Null),
            "parameters": m.pointer("/details/parameter_size").cloned().unwrap_or(Value::Null),
        }))
        .collect();
    let loaded: Vec<Value> = ps.and_then(|p| p.get("models").cloned()).and_then(|m| m.as_array().cloned()).unwrap_or_default()
        .into_iter()
        .map(|m| json!({ "id": m.get("name").cloned().unwrap_or(Value::Null), "vram": m.get("size_vram").cloned().unwrap_or(Value::Null) }))
        .collect();
    json!({ "installed": installed, "running": true, "version": version.get("version"), "models": models, "loaded": loaded })
}

#[tauri::command]
pub async fn ollama_start(app: AppHandle) -> Result<Value, String> {
    ensure_ollama(&app).await?;
    Ok(ollama_status().await)
}

#[tauri::command]
pub async fn ollama_stop(app: AppHandle) -> Value {
    stop_ollama(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(provider: &str) -> Config {
        Config { provider: provider.into(), ..Config::default() }
    }

    #[test]
    fn thinking_goes_only_to_deepseek() {
        let mut c = cfg("openai");
        c.keys.insert("openai".into(), "k".into());
        let ep = endpoint(&c).unwrap();
        let mut body = json!({ "model": "gpt-x", "thinking": { "type": "disabled" }, "reasoning_effort": "low", "max_tokens": 16384 });
        shape(&ep, &c, &mut body);
        assert!(body.get("thinking").is_none());
        assert!(body.get("reasoning_effort").is_none(), "a model not known to take it does not get it");

        let d = cfg("deepseek");
        let mut c2 = d.clone();
        c2.api_key = "old".into();
        let ep = endpoint(&c2).unwrap();
        let mut body = json!({ "model": "deepseek-flash", "thinking": { "type": "disabled" }, "reasoning_effort": "low" });
        shape(&ep, &c2, &mut body);
        assert!(body.get("thinking").is_some());
        assert!(body.get("reasoning_effort").is_some());
    }

    #[test]
    fn max_tokens_stays_within_the_model() {
        let mut c = cfg("groq");
        c.keys.insert("groq".into(), "k".into());
        c.models_info.insert("small".into(), ModelInfo { max_output: 8192, ..Default::default() });
        let ep = endpoint(&c).unwrap();
        let mut body = json!({ "model": "small", "max_tokens": 16384 });
        shape(&ep, &c, &mut body);
        assert_eq!(body["max_tokens"], 8192);
    }

    #[test]
    fn a_provider_without_a_key_is_refused_and_ollama_needs_none() {
        assert!(endpoint(&cfg("openai")).is_err());
        let ep = endpoint(&cfg("ollama")).unwrap();
        assert!(ep.is_local());
        assert_eq!(ep.url("chat/completions"), "http://127.0.0.1:11434/v1/chat/completions");
    }

    #[test]
    fn the_old_deepseek_key_still_counts() {
        let mut c = cfg("deepseek");
        c.api_key = "sk-old".into();
        assert_eq!(key_for(&c, "deepseek"), "sk-old");
        assert_eq!(key_for(&c, "openai"), "");
    }

    #[test]
    fn reads_every_shape_of_error_and_the_wait_it_asks_for() {
        assert_eq!(retry_hint("Please retry in 8.797463943s."), Some(9.297463943));
        assert_eq!(error_text(r#"[{"error":{"code":429,"message":"You exceeded your quota\nmore"}}]"#), "You exceeded your quota");
        assert_eq!(error_text(r#"{"error":{"message":"bad key"}}"#), "bad key");
        assert_eq!(error_text("plain"), "plain");
    }

    #[test]
    fn local_models_are_free() {
        assert_eq!(price(&cfg("ollama"), "llama3.1"), Some((0.0, 0.0, 0.0)));
    }
}
