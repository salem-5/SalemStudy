//! Sandboxed Python for the AI solver.
//!
//! The model gets a `run_python` tool; this module is what actually runs the
//! code. It never touches the machine's Python packages: `python_setup`
//! builds a private virtualenv under the app data dir and installs the math
//! stack (sympy, numpy, mpmath, scipy) into it, and every run happens in a
//! throwaway folder with a scrubbed environment, an audit hook (see
//! `sandbox_runner.py`) and a hard timeout.
//!
//! Windows and macOS both work out of the box: the interpreter search knows
//! the usual install locations on each, and the runner only uses the standard
//! library plus the venv.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const RUNNER: &str = include_str!("sandbox_runner.py");

/// Imported by the runner before the sandbox closes; the first three are what
/// the tool description promises, so a missing one means "not ready".
pub const CORE_PACKAGES: [&str; 3] = ["sympy", "numpy", "mpmath"];
pub const EXTRA_PACKAGES: [&str; 1] = ["scipy"];

const PROBE: &str = r#"
import json, sys
mods = {}
for m in ("sympy", "numpy", "mpmath", "scipy"):
    try:
        mods[m] = getattr(__import__(m), "__version__", "?")
    except Exception:
        mods[m] = None
print(json.dumps({"version": sys.version.split()[0], "exe": sys.executable, "packages": mods}))
"#;

// ---------------------------------------------------------------------------
// Running child processes
// ---------------------------------------------------------------------------

/// Keep a spawned console program from flashing a terminal window.
fn hide_window(cmd: &mut Command) {
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
        // A dedicated reader per pipe: waiting on the child first would
        // deadlock as soon as a pipe's buffer fills up.
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

/// Kill a child and everything it started. Nothing in the sandbox is allowed
/// to spawn children, but a broken pip run can leave some behind.
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
                // Give the readers a moment to flush the tail of the pipes.
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

/// Same, but the caller sees each line as it appears (used by the installer).
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
    // The reader lives in its own thread so a download that stalls without
    // printing anything still hits the deadline below.
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

// ---------------------------------------------------------------------------
// Finding an interpreter
// ---------------------------------------------------------------------------

fn exe(dir: &Path, stem: &str) -> Option<PathBuf> {
    for name in [format!("{stem}.exe"), stem.to_string()] {
        let cand = dir.join(name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// The private virtualenv: `<app data>/python/venv`.
fn venv_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("python").join("venv"))
}

pub fn venv_python(app: &AppHandle) -> Option<PathBuf> {
    let root = venv_root(app).ok()?;
    let bin = if cfg!(windows) { root.join("Scripts") } else { root.join("bin") };
    exe(&bin, "python3").or_else(|| exe(&bin, "python"))
}

/// Store-installed Python on Windows is a stub that opens the Microsoft Store
/// instead of running, so never pick one up.
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

/// Where a system Python lives when a GUI app's PATH does not have it.
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

/// A Python that can create the virtualenv. Never the venv's own interpreter.
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
    for stem in ["python3", "python"] {
        if let Some(p) = on_path(stem) {
            push(p);
        }
    }
    for dir in extra_dirs() {
        for stem in ["python3", "python"] {
            if let Some(p) = exe(&dir, stem) {
                push(p);
            }
        }
    }
    // The Windows launcher knows about installs that are on no PATH at all.
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
        for name in CORE_PACKAGES.iter().chain(EXTRA_PACKAGES.iter()) {
            let v = map.get(*name).and_then(Value::as_str).map(|s| s.to_string());
            packages.push((name.to_string(), v));
        }
    }
    Ok(Probe { version, packages })
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

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

fn status_value(app: &AppHandle, configured: &str) -> Value {
    // An explicit override wins; otherwise the managed venv, which is what
    // `python_setup` builds.
    let override_path = std::env::var("WA_PYTHON")
        .ok()
        .map(PathBuf::from)
        .filter(|p| usable(p))
        .or_else(|| Some(PathBuf::from(configured.trim())).filter(|p| !configured.trim().is_empty() && usable(p)));
    let (interpreter, source) = match override_path {
        Some(p) => (Some(p), "custom"),
        None => match venv_python(app).filter(|p| usable(p)) {
            Some(p) => (Some(p), "venv"),
            None => (None, "none"),
        },
    };
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
        });
    };
    match probe(&interpreter) {
        Ok(p) => {
            let missing: Vec<&str> = CORE_PACKAGES
                .iter()
                .filter(|name| !p.packages.iter().any(|(n, v)| n == *name && v.is_some()))
                .copied()
                .collect();
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
            })
        }
        Err(e) => json!({
            "ready": false,
            "source": source,
            "interpreter": interpreter.to_string_lossy(),
            "version": Value::Null,
            "packages": [],
            "missing": CORE_PACKAGES,
            "error": e,
            "help": install_help(),
            "canInstall": !find_system_python(configured).is_empty(),
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

// ---------------------------------------------------------------------------
// Setup: build the virtualenv and install the math stack
// ---------------------------------------------------------------------------

fn setup_blocking(app: &AppHandle, configured: &str, repair: bool) -> Result<Value, String> {
    let emit = |stage: &str, line: &str| {
        let _ = app.emit("python://progress", json!({ "stage": stage, "line": line }));
    };
    forget_ready();
    let root = venv_root(app)?;
    if repair && root.exists() {
        emit("stage", "Removing the old environment…");
        std::fs::remove_dir_all(&root).map_err(|e| format!("could not remove {}: {e}", root.display()))?;
    }

    let mut python = venv_python(app).filter(|p| usable(p));
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

    // pip first: a fresh venv on an old Python can have a pip too old for the
    // current wheels.
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
    // scipy has no wheel for every Python version; it is a bonus, not a
    // requirement, so a failure here is only a note.
    if let Err(e) = install(&EXTRA_PACKAGES, "scipy") {
        emit("log", &format!("scipy was skipped — {e}"));
    }

    emit("stage", "Checking the environment…");
    let status = status_value(app, configured);
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

// ---------------------------------------------------------------------------
// Running the model's code
// ---------------------------------------------------------------------------

static RUN_SEQ: AtomicU64 = AtomicU64::new(0);
/// Interpreter that already probed as ready, so a solve does not re-probe
/// before every single tool call. Cleared by `python_setup`.
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

/// PATH for the child: the interpreter's own folder plus the system essentials
/// and nothing else, so the sandbox cannot pick up tooling from the user's
/// shell profile.
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

fn run_blocking(app: &AppHandle, configured: &str, code: String, timeout: u64, memory_mb: u64) -> Result<Value, String> {
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
                &json!({ "code": code, "timeout": timeout, "memory_mb": memory_mb, "max_output": 20000 }).to_string(),
            )
        })
    {
        cleanup(&dir);
        return Err(e);
    }

    let mut cmd = Command::new(&python);
    // -I: ignore PYTHON* variables and the user site dir. -B: no .pyc files.
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
    // Keep a linear-algebra call from taking every core on the machine.
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

    // The runner stops itself at `timeout`; this is the backstop for code that
    // is stuck inside a C loop where Python cannot interrupt it.
    let out = match run(cmd, Duration::from_secs(timeout + 10)) {
        Ok(o) => o,
        Err(e) => {
            cleanup(&dir);
            return Err(format!("could not start Python: {e}"));
        }
    };

    let parsed = std::fs::read_to_string(&result)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
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
pub async fn run_python(app: AppHandle, code: String, timeout: Option<u64>) -> Result<Value, String> {
    let cfg = crate::read_config(&app);
    if !cfg.python_enabled {
        return Err("Python is switched off in AI settings.".into());
    }
    let configured = cfg.python_path;
    let timeout = timeout.unwrap_or(cfg.python_timeout as u64).clamp(1, 180);
    let memory_mb = (cfg.python_memory_mb as u64).clamp(256, 16384);
    tauri::async_runtime::spawn_blocking(move || run_blocking(&app, &configured, code, timeout, memory_mb))
        .await
        .map_err(|e| e.to_string())?
}

/// Delete any sandbox folder left behind by a crash. Called once at startup.
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
    use super::*;

    /// Drives the real runner the way `run_blocking` does, against the
    /// interpreter in WA_TEST_PYTHON — a virtualenv with the math stack in it:
    ///
    /// ```text
    /// python3 -m venv /tmp/wa-py && /tmp/wa-py/bin/pip install sympy numpy mpmath
    /// WA_TEST_PYTHON=/tmp/wa-py/bin/python cargo test
    /// ```
    ///
    /// Without that variable there is nothing to run against, so the tests
    /// report themselves as skipped instead of failing.
    fn exec(code: &str, timeout: u64) -> Option<Value> {
        let Ok(var) = std::env::var("WA_TEST_PYTHON") else {
            eprintln!("skipped: set WA_TEST_PYTHON to a virtualenv interpreter to run the sandbox tests");
            return None;
        };
        let python = PathBuf::from(var);
        let dir = std::env::temp_dir().join(format!("wa-test-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
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
