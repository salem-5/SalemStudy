use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const RUNNER: &str = include_str!("sandbox_runner.py");

pub const CORE_PACKAGES: [&str; 3] = ["sympy", "numpy", "mpmath"];
pub const EXTRA_PACKAGES: [&str; 6] = ["scipy", "matplotlib", "pint", "pymupdf", "python-pptx", "yt-dlp"];
pub const AI_PACKAGES: [&str; 1] = ["smolagents>=1.26,<2"];
pub const AI_MODULES: [&str; 1] = ["smolagents"];
pub const MIN_AI_PYTHON: (u32, u32) = (3, 10);

const PROBE: &str = r#"
import json, sys
mods = {}
for m in ("sympy", "numpy", "mpmath", "scipy", "matplotlib", "pint", "pymupdf", "pptx", "yt_dlp", "smolagents"):
    try:
        mods[m] = getattr(__import__(m), "__version__", "?")
    except Exception:
        mods[m] = None
print(json.dumps({"version": sys.version.split()[0], "exe": sys.executable, "packages": mods}))
"#;

pub(crate) fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

struct Output {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

fn drain(pipe: Option<impl Read + Send + 'static>) -> Arc<Mutex<Vec<u8>>> {
    let buf = Arc::new(Mutex::new(Vec::new()));
    if let Some(mut pipe) = pipe {
        let sink = buf.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match pipe.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut out = sink.lock().unwrap();
                        if out.len() < 1_000_000 {
                            out.extend_from_slice(&chunk[..n]);
                        }
                    }
                }
            }
        });
    }
    buf
}

fn take(buf: &Arc<Mutex<Vec<u8>>>) -> String {
    String::from_utf8_lossy(&buf.lock().unwrap()).to_string()
}

fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hide_window(&mut cmd);
        let _ = cmd.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn run(mut cmd: Command, timeout: Duration) -> Result<Output, String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                std::thread::sleep(Duration::from_millis(30));
                return Ok(Output { code: status.code(), stdout: take(&out), stderr: take(&err), timed_out: false });
            }
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
        }
        if Instant::now() >= deadline {
            kill_tree(&mut child);
            std::thread::sleep(Duration::from_millis(30));
            return Ok(Output { code: None, stdout: take(&out), stderr: take(&err), timed_out: true });
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn run_streaming(
    mut cmd: Command,
    timeout: Duration,
    on_line: &dyn Fn(&str),
) -> Result<Output, String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let err = drain(child.stderr.take());
    let mut tail: Vec<String> = Vec::new();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if tx.send(line.trim_end().to_string()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    let deadline = Instant::now() + timeout;
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(text) => {
                if !text.is_empty() {
                    on_line(&text);
                    tail.push(text);
                    if tail.len() > 400 {
                        tail.remove(0);
                    }
                }
                continue;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
        if Instant::now() >= deadline {
            kill_tree(&mut child);
            return Ok(Output { code: None, stdout: tail.join("\n"), stderr: take(&err), timed_out: true });
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    std::thread::sleep(Duration::from_millis(30));
    Ok(Output { code: status.code(), stdout: tail.join("\n"), stderr: take(&err), timed_out: false })
}

fn exe(dir: &Path, stem: &str) -> Option<PathBuf> {
    for name in [format!("{stem}.exe"), stem.to_string()] {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

fn venv_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("python").join("venv"))
}

pub fn venv_python(app: &AppHandle) -> Option<PathBuf> {
    let root = venv_root(app).ok()?;
    let bin = if cfg!(windows) { root.join("Scripts") } else { root.join("bin") };
    exe(&bin, "python3").or_else(|| exe(&bin, "python"))
}

fn usable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    if path.to_string_lossy().contains("WindowsApps") {
        return false;
    }
    std::fs::metadata(path).map(|m| m.len() > 0).unwrap_or(false)
}

fn on_path(stem: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| exe(&dir, stem).filter(|p| usable(p)))
}

fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        for var in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
            let Some(base) = std::env::var_os(var) else { continue };
            let base = PathBuf::from(base);
            for root in [base.join("Programs").join("Python"), base.join("Python")] {
                if let Ok(entries) = std::fs::read_dir(&root) {
                    for e in entries.flatten() {
                        if e.path().is_dir() {
                            dirs.push(e.path());
                        }
                    }
                }
            }
        }
        for drive_root in ["C:\\"] {
            if let Ok(entries) = std::fs::read_dir(drive_root) {
                for e in entries.flatten() {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    if name.starts_with("python3") && e.path().is_dir() {
                        dirs.push(e.path());
                    }
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/local/bin"));
        if let Ok(entries) = std::fs::read_dir("/Library/Frameworks/Python.framework/Versions") {
            for e in entries.flatten() {
                dirs.push(e.path().join("bin"));
            }
        }
        dirs.push(PathBuf::from("/usr/bin"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/bin"));
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        dirs.push(PathBuf::from(&home).join(".local").join("bin"));
    }
    dirs
}

const NEWEST_FIRST: [&str; 8] =
    ["python3.14", "python3.13", "python3.12", "python3.11", "python3.10", "python3", "python", "python3.9"];

fn find_system_python(configured: &str) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if usable(&p) && !found.iter().any(|q| q == &p) {
            found.push(p);
        }
    };
    if let Ok(p) = std::env::var("WA_PYTHON") {
        push(PathBuf::from(p));
    }
    if !configured.trim().is_empty() {
        push(PathBuf::from(configured.trim()));
    }
    for stem in NEWEST_FIRST {
        if let Some(p) = on_path(stem) {
            push(p);
        }
    }
    for dir in extra_dirs() {
        for stem in NEWEST_FIRST {
            if let Some(p) = exe(&dir, stem) {
                push(p);
            }
        }
    }
    #[cfg(windows)]
    if let Some(py) = on_path("py") {
        let mut cmd = Command::new(py);
        cmd.args(["-3", "-c", "import sys; print(sys.executable)"]);
        if let Ok(out) = run(cmd, Duration::from_secs(15)) {
            let line = out.stdout.trim().to_string();
            if !line.is_empty() {
                push(PathBuf::from(line));
            }
        }
    }
    found
}

#[derive(Clone)]
pub struct Probe {
    pub version: String,
    pub packages: Vec<(String, Option<String>)>,
}

fn probe(python: &Path) -> Result<Probe, String> {
    let mut cmd = Command::new(python);
    cmd.args(["-I", "-B", "-c", PROBE]);
    cmd.env("PYTHONIOENCODING", "utf-8");
    let out = run(cmd, Duration::from_secs(60))?;
    if out.timed_out {
        return Err("the interpreter did not answer in time".into());
    }
    let line = out.stdout.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or("");
    let value: Value = serde_json::from_str(line.trim())
        .map_err(|_| {
            let msg = if out.stderr.trim().is_empty() { out.stdout.trim() } else { out.stderr.trim() };
            format!("could not run it: {}", msg.chars().take(300).collect::<String>())
        })?;
    let version = value.get("version").and_then(Value::as_str).unwrap_or("?").to_string();
    let mut packages = Vec::new();
    if let Some(map) = value.get("packages").and_then(Value::as_object) {
        for name in CORE_PACKAGES.iter().chain(EXTRA_PACKAGES.iter()).chain(AI_MODULES.iter()) {
            let v = map.get(*name).and_then(Value::as_str).map(|s| s.to_string());
            packages.push((name.to_string(), v));
        }
    }
    Ok(Probe { version, packages })
}

pub fn version_pair(version: &str) -> (u32, u32) {
    let mut parts = version.trim().split(['.', '-', '+']);
    let major = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    (major, minor)
}

pub fn new_enough_for_ai(version: &str) -> bool {
    version_pair(version) >= MIN_AI_PYTHON
}

fn ai_help() -> String {
    format!(
        "Salem's AI runtime needs Python {}.{} or newer. Press Repair to rebuild the environment on a newer interpreter, or point WA_PYTHON at one.",
        MIN_AI_PYTHON.0, MIN_AI_PYTHON.1
    )
}

fn install_help() -> &'static str {
    if cfg!(windows) {
        "Install Python 3 from python.org (tick “Add python.exe to PATH”) or the Microsoft Store, then press Install again. You can also point WA_PYTHON at python.exe."
    } else if cfg!(target_os = "macos") {
        "Install Python 3 with 'brew install python' or from python.org, then press Install again. You can also point WA_PYTHON at the interpreter."
    } else {
        "Install Python 3 with your package manager (it also needs the venv module, e.g. 'sudo apt install python3-venv'), then press Install again. You can also point WA_PYTHON at the interpreter."
    }
}

pub(crate) fn interpreter(app: &AppHandle, configured: &str) -> Option<PathBuf> {
    interpreter_with_source(app, configured).0
}

fn interpreter_with_source(app: &AppHandle, configured: &str) -> (Option<PathBuf>, &'static str) {
    let override_path = std::env::var("WA_PYTHON")
        .ok()
        .map(PathBuf::from)
        .filter(|p| usable(p))
        .or_else(|| Some(PathBuf::from(configured.trim())).filter(|p| !configured.trim().is_empty() && usable(p)));
    match override_path {
        Some(p) => (Some(p), "custom"),
        None => match venv_python(app).filter(|p| usable(p)) {
            Some(p) => (Some(p), "venv"),
            None => (None, "none"),
        },
    }
}

fn status_value(app: &AppHandle, configured: &str) -> Value {
    let (interpreter, source) = interpreter_with_source(app, configured);
    let Some(interpreter) = interpreter else {
        return json!({
            "ready": false,
            "source": source,
            "interpreter": Value::Null,
            "version": Value::Null,
            "packages": [],
            "missing": CORE_PACKAGES,
            "error": Value::Null,
            "help": install_help(),
            "canInstall": !find_system_python(configured).is_empty(),
            "aiReady": false,
            "aiMissing": AI_MODULES,
            "aiError": "Python is not set up yet.",
            "needsRebuild": false,
        });
    };
    match probe(&interpreter) {
        Ok(p) => {
            let has = |name: &str| p.packages.iter().any(|(n, v)| n == name && v.is_some());
            let missing: Vec<&str> = CORE_PACKAGES.iter().filter(|n| !has(n)).copied().collect();
            let old_python = !new_enough_for_ai(&p.version);
            let ai_missing: Vec<&str> = AI_MODULES.iter().filter(|n| !has(n)).copied().collect();
            let ai_error = if old_python {
                Some(format!("this environment is Python {} — {}", p.version, ai_help()))
            } else if !ai_missing.is_empty() {
                Some("smolagents is not installed yet. Press Install.".to_string())
            } else {
                None
            };
            if missing.is_empty() {
                remember_ready(&interpreter);
            } else {
                forget_ready();
            }
            json!({
                "ready": missing.is_empty(),
                "source": source,
                "interpreter": interpreter.to_string_lossy(),
                "version": p.version,
                "packages": p.packages.iter().map(|(n, v)| json!({"name": n, "version": v})).collect::<Vec<_>>(),
                "missing": missing,
                "error": Value::Null,
                "help": install_help(),
                "canInstall": true,
                "aiReady": ai_error.is_none(),
                "aiMissing": ai_missing,
                "aiError": ai_error,
                "needsRebuild": old_python,
            })
        }
        Err(e) => json!({
            "ready": false,
            "source": source,
            "interpreter": interpreter.to_string_lossy(),
            "version": Value::Null,
            "packages": [],
            "missing": CORE_PACKAGES,
            "error": e.clone(),
            "help": install_help(),
            "canInstall": !find_system_python(configured).is_empty(),
            "aiReady": false,
            "aiMissing": AI_MODULES,
            "aiError": e,
            "needsRebuild": false,
        }),
    }
}

#[tauri::command]
pub async fn python_status(app: AppHandle) -> Result<Value, String> {
    let configured = crate::read_config(&app).python_path;
    tauri::async_runtime::spawn_blocking(move || status_value(&app, &configured))
        .await
        .map_err(|e| e.to_string())
}

fn setup_blocking(app: &AppHandle, configured: &str, repair: bool) -> Result<Value, String> {
    let emit = |stage: &str, line: &str| {
        crate::tabmode::notify(&app, "python://progress", json!({ "stage": stage, "line": line }));
    };
    forget_ready();
    let root = venv_root(app)?;
    if repair && root.exists() {
        emit("stage", "Removing the old environment…");
        std::fs::remove_dir_all(&root).map_err(|e| format!("could not remove {}: {e}", root.display()))?;
    }

    let mut python = venv_python(app).filter(|p| usable(p));
    if let Some(existing) = python.clone() {
        if let Ok(p) = probe(&existing) {
            if !new_enough_for_ai(&p.version) {
                let upgrade = find_system_python(configured)
                    .into_iter()
                    .find(|base| probe(base).map(|b| new_enough_for_ai(&b.version)).unwrap_or(false));
                match upgrade {
                    Some(base) => {
                        emit("stage", &format!(
                            "This environment is Python {} and Salem's AI needs {}.{}. Rebuilding it with {}…",
                            p.version, MIN_AI_PYTHON.0, MIN_AI_PYTHON.1, base.display()
                        ));
                        std::fs::remove_dir_all(&root)
                            .map_err(|e| format!("could not remove the old environment at {}: {e}", root.display()))?;
                        python = None;
                    }
                    None => emit("log", &format!(
                        "This machine only has Python {}. The maths tools will work; Salem's AI needs {}.{} or newer.",
                        p.version, MIN_AI_PYTHON.0, MIN_AI_PYTHON.1
                    )),
                }
            }
        }
    }
    if python.is_none() {
        let bases = find_system_python(configured);
        if bases.is_empty() {
            return Err(format!("No Python 3 interpreter found on this machine. {}", install_help()));
        }
        if let Some(parent) = root.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }
        let mut last = String::new();
        for base in &bases {
            emit("stage", &format!("Creating the environment with {}…", base.display()));
            let mut cmd = Command::new(base);
            cmd.arg("-m").arg("venv").arg(&root);
            match run(cmd, Duration::from_secs(300)) {
                Ok(out) if out.code == Some(0) => {}
                Ok(out) => {
                    last = if out.timed_out {
                        "creating the environment timed out".into()
                    } else {
                        let msg = if out.stderr.trim().is_empty() { out.stdout } else { out.stderr };
                        msg.trim().chars().take(400).collect()
                    };
                    let _ = std::fs::remove_dir_all(&root);
                    continue;
                }
                Err(e) => {
                    last = e;
                    continue;
                }
            }
            python = venv_python(app).filter(|p| usable(p));
            if python.is_some() {
                break;
            }
        }
        let Some(_) = python else {
            return Err(format!("Could not create the Python environment: {last}\n{}", install_help()));
        };
    }
    let python = python.unwrap();

    emit("stage", "Updating pip…");
    let mut cmd = Command::new(&python);
    cmd.args(["-m", "pip", "install", "--upgrade", "--disable-pip-version-check", "pip"]);
    let _ = run_streaming(cmd, Duration::from_secs(300), &|l| emit("log", l));

    let install = |packages: &[&str], label: &str| -> Result<(), String> {
        emit("stage", &format!("Installing {label}…"));
        let mut cmd = Command::new(&python);
        cmd.args(["-m", "pip", "install", "--upgrade", "--disable-pip-version-check", "--no-input"]);
        cmd.args(packages);
        let out = run_streaming(cmd, Duration::from_secs(900), &|l| emit("log", l))?;
        if out.timed_out {
            return Err(format!("installing {label} timed out"));
        }
        if out.code != Some(0) {
            let msg = if out.stderr.trim().is_empty() { out.stdout.clone() } else { out.stderr.clone() };
            let tail: Vec<&str> = msg.lines().rev().take(12).collect();
            let tail: Vec<&str> = tail.into_iter().rev().collect();
            return Err(format!("installing {label} failed:\n{}", tail.join("\n")));
        }
        Ok(())
    };

    install(&CORE_PACKAGES, "sympy, numpy and mpmath")?;
    for pkg in EXTRA_PACKAGES {
        if let Err(e) = install(&[pkg], pkg) {
            emit("log", &format!("{pkg} was skipped — {e}"));
        }
    }

    let version = probe(&python).map(|p| p.version).unwrap_or_default();
    if new_enough_for_ai(&version) {
        if let Err(e) = install(&AI_PACKAGES, "smolagents (Salem's AI runtime)") {
            emit("log", &format!("Salem's AI runtime could not be installed — {e}"));
        }
    } else {
        emit("log", &format!("Skipped smolagents: {}", ai_help()));
    }

    emit("stage", "Checking the environment…");
    let status = status_value(app, configured);
    if let Some(salem) = app.try_state::<crate::salem::Salem>() {
        salem.shut_down("the Python environment changed");
    }
    emit("done", "Python is ready.");
    Ok(status)
}

#[tauri::command]
pub async fn python_setup(app: AppHandle, repair: Option<bool>) -> Result<Value, String> {
    let configured = crate::read_config(&app).python_path;
    let repair = repair.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || setup_blocking(&app, &configured, repair))
        .await
        .map_err(|e| e.to_string())?
}

static RUN_SEQ: AtomicU64 = AtomicU64::new(0);
static VERIFIED: Mutex<Option<PathBuf>> = Mutex::new(None);

fn remember_ready(path: &Path) {
    *VERIFIED.lock().unwrap() = Some(path.to_path_buf());
}

fn forget_ready() {
    *VERIFIED.lock().unwrap() = None;
}

fn ready_interpreter(app: &AppHandle, configured: &str) -> Result<PathBuf, String> {
    if let Some(p) = VERIFIED.lock().unwrap().clone() {
        if usable(&p) {
            return Ok(p);
        }
    }
    let status = status_value(app, configured);
    if status.get("ready").and_then(Value::as_bool).unwrap_or(false) {
        let p = PathBuf::from(status.get("interpreter").and_then(Value::as_str).unwrap_or_default());
        remember_ready(&p);
        return Ok(p);
    }
    let why = status.get("error").and_then(Value::as_str).unwrap_or("");
    Err(format!(
        "Python is not set up yet{}. Open AI settings \u{2192} Python and press Install.",
        if why.is_empty() { String::new() } else { format!(" ({why})") }
    ))
}

fn sandbox_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("python-sandbox");
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let n = RUN_SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = base.join(format!("run-{stamp}-{n}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create the sandbox folder: {e}"))?;
    Ok(dir)
}

fn child_path(python: &Path) -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = python.parent() {
        dirs.push(d.to_path_buf());
    }
    #[cfg(windows)]
    if let Some(sys) = std::env::var_os("SystemRoot") {
        let sys = PathBuf::from(sys);
        dirs.push(sys.join("System32"));
        dirs.push(sys);
    }
    #[cfg(not(windows))]
    for d in ["/usr/bin", "/bin"] {
        dirs.push(PathBuf::from(d));
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

pub struct InputFile {
    pub name: String,
    pub data: Vec<u8>,
}

fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '_' })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches(['.', '_']).to_string();
    if cleaned.is_empty() { "file".into() } else { cleaned.chars().take(120).collect() }
}

fn image_mime(name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();
    [(".png", "image/png"), (".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".gif", "image/gif"), (".svg", "image/svg+xml"), (".webp", "image/webp")]
        .iter()
        .find(|(ext, _)| lower.ends_with(ext))
        .map(|(_, m)| *m)
}

pub struct Limits {
    pub max_output: usize,
    pub max_figures: usize,
}

fn run_blocking(app: &AppHandle, configured: &str, code: String, timeout: u64, memory_mb: u64, files: Vec<InputFile>, limits: Limits) -> Result<Value, String> {
    let python = ready_interpreter(app, configured)?;

    let dir = sandbox_dir(app)?;
    let cleanup = |dir: &Path| {
        let _ = std::fs::remove_dir_all(dir);
    };
    let runner = dir.join("_runner.py");
    let job = dir.join("_job.json");
    let result = dir.join("_result.json");
    let write = |path: &Path, body: &str| -> Result<(), String> {
        std::fs::write(path, body).map_err(|e| format!("could not write {}: {e}", path.display()))
    };
    if let Err(e) = write(&runner, RUNNER)
        .and_then(|_| {
            write(
                &job,
                &json!({ "code": code, "timeout": timeout, "memory_mb": memory_mb, "max_output": limits.max_output, "max_figures": limits.max_figures }).to_string(),
            )
        })
    {
        cleanup(&dir);
        return Err(e);
    }
    let mut placed: Vec<String> = Vec::new();
    for f in files {
        let mut name = safe_file_name(&f.name);
        while placed.contains(&name) {
            name = format!("1-{name}");
        }
        if let Err(e) = std::fs::write(dir.join(&name), &f.data) {
            cleanup(&dir);
            return Err(format!("could not copy {name} into the sandbox: {e}"));
        }
        placed.push(name);
    }

    let mut cmd = Command::new(&python);
    cmd.arg("-I").arg("-B").arg(&runner).arg(&job).arg(&result);
    cmd.current_dir(&dir);
    cmd.env_clear();
    cmd.env("PATH", child_path(&python));
    cmd.env("HOME", &dir);
    cmd.env("USERPROFILE", &dir);
    cmd.env("TMPDIR", &dir);
    cmd.env("TEMP", &dir);
    cmd.env("TMP", &dir);
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONDONTWRITEBYTECODE", "1");
    cmd.env("PYTHONNOUSERSITE", "1");
    cmd.env("MPLBACKEND", "Agg");
    if let Ok(cache) = app.path().app_cache_dir() {
        let mpl = cache.join("mpl-config");
        if std::fs::create_dir_all(&mpl).is_ok() {
            cmd.env("MPLCONFIGDIR", mpl);
        }
    }
    for var in ["OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"] {
        cmd.env(var, "2");
    }
    #[cfg(windows)]
    {
        if let Some(v) = std::env::var_os("SystemRoot") {
            cmd.env("SystemRoot", v);
        }
        if let Some(v) = std::env::var_os("windir") {
            cmd.env("windir", v);
        }
        if let Some(v) = std::env::var_os("NUMBER_OF_PROCESSORS") {
            cmd.env("NUMBER_OF_PROCESSORS", v);
        }
    }

    let out = match run(cmd, Duration::from_secs(timeout + 10)) {
        Ok(o) => o,
        Err(e) => {
            cleanup(&dir);
            return Err(format!("could not start Python: {e}"));
        }
    };

    let mut parsed = std::fs::read_to_string(&result)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    if let Some(Value::Object(map)) = parsed.as_mut() {
        let names: Vec<String> = map
            .get("figures")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let figures: Vec<Value> = names
            .iter()
            .filter(|n| !n.contains(['/', '\\']))
            .filter_map(|n| {
                let mime = image_mime(n)?;
                let bytes = std::fs::read(dir.join(n)).ok()?;
                let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                Some(json!({ "name": n.trim_start_matches('_'), "dataUrl": format!("data:{mime};base64,{data}") }))
            })
            .collect();
        map.insert("figures".into(), Value::Array(figures));
    }
    cleanup(&dir);

    let mut value = match parsed {
        Some(Value::Object(map)) => Value::Object(map),
        _ => {
            let why = if out.timed_out {
                format!("the code was still running after {timeout}s and was stopped")
            } else {
                let msg = if out.stderr.trim().is_empty() { out.stdout.trim() } else { out.stderr.trim() };
                if msg.is_empty() {
                    format!("Python exited with code {:?} and wrote no result", out.code)
                } else {
                    msg.chars().take(1500).collect()
                }
            };
            json!({ "ok": false, "stdout": "", "stderr": "", "result": Value::Null, "error": why, "timed_out": out.timed_out })
        }
    };
    value["exitCode"] = json!(out.code);
    if out.timed_out {
        value["ok"] = json!(false);
        value["timed_out"] = json!(true);
    }
    Ok(value)
}

#[tauri::command]
pub async fn run_python(
    app: AppHandle,
    db: tauri::State<'_, crate::study::StudyDb>,
    code: String,
    timeout: Option<u64>,
    files: Option<Vec<i64>>,
    sources: Option<Vec<i64>>,
    max_output: Option<usize>,
    max_figures: Option<usize>,
) -> Result<Value, String> {
    let cfg = crate::read_config(&app);
    if !cfg.python_enabled {
        return Err("Python is switched off in AI settings.".into());
    }
    let configured = cfg.python_path;
    let timeout = timeout.unwrap_or(cfg.python_timeout as u64).clamp(1, 180);
    let memory_mb = (cfg.python_memory_mb as u64).clamp(256, 16384);
    let mut inputs: Vec<InputFile> = crate::study::attachment_files(&app, &db, &files.unwrap_or_default())?
        .into_iter()
        .map(|(name, data)| InputFile { name, data })
        .collect();
    inputs.extend(
        crate::study::sources::source_files(&app, &db, &sources.unwrap_or_default())?
            .into_iter()
            .map(|(name, data)| InputFile { name, data }),
    );
    let limits = Limits {
        max_output: max_output.unwrap_or(20_000).clamp(1_000, 8_000_000),
        max_figures: max_figures.unwrap_or(8).clamp(1, 40),
    };
    tauri::async_runtime::spawn_blocking(move || run_blocking(&app, &configured, code, timeout, memory_mb, inputs, limits))
        .await
        .map_err(|e| e.to_string())?
}

const YT_SCRIPT: &str = r#"
import json, sys
import yt_dlp

ENGLISH = ["en", "en-US", "en-GB", "en-CA", "en-AU", "en-IN", "en-IE", "en-NZ"]

def pick(tracks, prefer):
    for code in prefer:
        if code in tracks:
            return tracks[code]
    return None

url = sys.argv[1]
with yt_dlp.YoutubeDL({"skip_download": True, "quiet": True, "no_warnings": True}) as ydl:
    info = ydl.extract_info(url, download=False)
    auto = info.get("automatic_captions") or {}
    track = (pick(info.get("subtitles") or {}, ENGLISH)
             or pick(auto, ["en-orig", "en"])
             or pick(auto, [c for c in auto if c.endswith("-orig")]))
    segs = []
    if track:
        fmt = next((f for f in track if f.get("ext") == "json3"), None)
        if fmt:
            data = json.loads(ydl.urlopen(fmt["url"]).read().decode("utf-8"))
            for ev in data.get("events", []):
                text = "".join(s.get("utf8", "") for s in ev.get("segs", []) or []).strip()
                if text:
                    segs.append({"start": ev.get("tStartMs", 0) / 1000.0, "text": text})
print(json.dumps({
    "title": info.get("title"), "channel": info.get("channel"), "duration": info.get("duration"),
    "chapters": [{"start": c.get("start_time"), "title": c.get("title")} for c in (info.get("chapters") or [])],
    "segments": segs,
}))
"#;

#[tauri::command]
pub async fn youtube_transcript(app: AppHandle, url: String) -> Result<Value, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "That is not a link.".to_string())?;
    let host = parsed.host_str().unwrap_or_default().trim_start_matches("www.").trim_start_matches("m.").to_string();
    if !matches!(host.as_str(), "youtube.com" | "youtu.be" | "music.youtube.com") {
        return Err("Only YouTube links are supported.".into());
    }
    let configured = crate::read_config(&app).python_path;
    tauri::async_runtime::spawn_blocking(move || {
        let python = ready_interpreter(&app, &configured)?;
        let dir = sandbox_dir(&app)?;
        let script = dir.join("_yt.py");
        std::fs::write(&script, YT_SCRIPT).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(&python);
        cmd.arg("-I").arg(&script).arg(parsed.as_str());
        cmd.current_dir(&dir);
        let out = run(cmd, Duration::from_secs(180));
        let _ = std::fs::remove_dir_all(&dir);
        let out = out?;
        if out.timed_out {
            return Err("YouTube took too long to answer.".into());
        }
        if out.code != Some(0) {
            let err = out.stderr.trim();
            if err.contains("No module named 'yt_dlp'") {
                return Err("yt-dlp is not installed. Open Settings → Python and press Update packages.".into());
            }
            return Err(format!("Could not read the video: {}", err.lines().last().unwrap_or("unknown error")));
        }
        serde_json::from_str::<Value>(out.stdout.trim()).map_err(|e| format!("unexpected output from yt-dlp: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn sweep_sandboxes(app: &AppHandle) {
    let Ok(base) = app.path().app_cache_dir().map(|d| d.join("python-sandbox")) else { return };
    let Ok(entries) = std::fs::read_dir(&base) else { return };
    for e in entries.flatten() {
        if e.path().is_dir() {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{new_enough_for_ai, version_pair, AI_MODULES, AI_PACKAGES, MIN_AI_PYTHON, NEWEST_FIRST};

    #[test]
    fn python_versions_are_compared_by_major_and_minor() {
        assert_eq!(version_pair("3.12.4"), (3, 12));
        assert_eq!(version_pair("3.9.6"), (3, 9));
        assert_eq!(version_pair("3.10.0rc1"), (3, 10));
        assert_eq!(version_pair("weird"), (0, 0));
    }

    #[test]
    fn only_a_new_enough_python_can_run_the_ai_runtime() {
        assert!(!new_enough_for_ai("3.9.6"), "macOS's system Python is too old for smolagents");
        assert!(new_enough_for_ai("3.10.0"));
        assert!(new_enough_for_ai("3.14.1"));
        assert_eq!(MIN_AI_PYTHON, (3, 10));
    }

    #[test]
    fn the_interpreter_search_prefers_newer_pythons() {
        let at = |name: &str| NEWEST_FIRST.iter().position(|s| *s == name).unwrap();
        assert!(at("python3.12") < at("python3"), "a versioned 3.12 must beat a bare python3");
        assert!(at("python3") < at("python3.9"), "3.9 is the last resort");
    }

    #[test]
    fn the_ai_requirement_is_pinned_and_matches_its_import_name() {
        assert_eq!(AI_MODULES, ["smolagents"]);
        assert!(AI_PACKAGES[0].starts_with("smolagents>="), "the version must be pinned");
        assert!(AI_PACKAGES[0].contains('<'), "and capped, so a major bump is deliberate");
    }

    use super::*;

    fn exec(code: &str, timeout: u64) -> Option<Value> {
        let Ok(var) = std::env::var("WA_TEST_PYTHON") else {
            eprintln!("skipped: set WA_TEST_PYTHON to a virtualenv interpreter to run the sandbox tests");
            return None;
        };
        let python = PathBuf::from(var);
        let n = RUN_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("wa-test-{}-{n}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let runner = dir.join("_runner.py");
        let job = dir.join("_job.json");
        let result = dir.join("_result.json");
        std::fs::write(&runner, RUNNER).unwrap();
        std::fs::write(&job, json!({"code": code, "timeout": timeout, "memory_mb": 2048, "max_output": 20000}).to_string()).unwrap();
        let mut cmd = Command::new(&python);
        cmd.arg("-I").arg("-B").arg(&runner).arg(&job).arg(&result);
        cmd.current_dir(&dir);
        cmd.env_clear();
        cmd.env("PATH", child_path(&python));
        cmd.env("HOME", &dir);
        cmd.env("TMPDIR", &dir);
        cmd.env("PYTHONIOENCODING", "utf-8");
        let out = run(cmd, Duration::from_secs(timeout + 10)).unwrap();
        let parsed = std::fs::read_to_string(&result).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok());
        let _ = std::fs::remove_dir_all(&dir);
        Some(parsed.unwrap_or_else(|| json!({"ok": false, "error": out.stderr, "timed_out": out.timed_out})))
    }

    #[test]
    fn computes_with_sympy() {
        let Some(v) = exec("print(sp.integrate(sp.Symbol('x')**2, (sp.Symbol('x'), 0, 3)))\nsp.nsimplify(sp.sqrt(8))", 30) else { return };
        assert_eq!(v["ok"], json!(true), "{v}");
        assert_eq!(v["stdout"].as_str().unwrap().trim(), "9");
        assert_eq!(v["result"].as_str().unwrap(), "2*sqrt(2)");
    }

    #[test]
    fn refuses_the_network() {
        let Some(v) = exec("import socket; socket.gethostbyname('example.com')", 20) else { return };
        assert_eq!(v["ok"], json!(false));
        assert!(v["error"].as_str().unwrap().contains("no network"), "{v}");
    }

    #[test]
    fn returns_matplotlib_figures() {
        let code = "x = np.linspace(0, 6, 50)\nplt.plot(x, np.sin(x))\nplt.title('sin')\nplt.show()";
        let Some(v) = exec(code, 60) else { return };
        assert_eq!(v["ok"], json!(true), "{v}");
        assert_eq!(v["figures"], json!(["_figure-1.png"]), "{v}");
    }

    #[test]
    fn pint_checks_units() {
        let Some(v) = exec("(Q_(3, 'm') / Q_(2, 's')).to('km/h').magnitude", 60) else { return };
        assert_eq!(v["ok"], json!(true), "{v}");
        assert_eq!(v["result"].as_str().unwrap(), "5.4");
    }

    #[test]
    fn file_names_cannot_escape_the_folder() {
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name("C:\\Users\\me\\data.csv"), "data.csv");
        assert_eq!(safe_file_name("_runner.py"), "runner.py");
        assert_eq!(safe_file_name(".."), "file");
    }

    #[test]
    fn stops_an_endless_loop() {
        let Some(v) = exec("while True:\n    pass", 3) else { return };
        assert_eq!(v["timed_out"], json!(true), "{v}");
    }

    #[test]
    fn survives_a_flood_of_output() {
        let Some(v) = exec("for i in range(200000):\n    print('x' * 40)", 40) else { return };
        assert_eq!(v["truncated"], json!(true), "{v}");
        assert!(v["stdout"].as_str().unwrap().len() < 30000);
    }
}
