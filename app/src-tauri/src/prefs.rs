use std::collections::BTreeMap;
use std::sync::Mutex;

use serde_json::json;
use tauri::{AppHandle, Manager};

const FILE: &str = "prefs.json";

#[derive(Default)]
pub struct PrefsLock(pub Mutex<()>);

fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(FILE))
}

fn read(app: &AppHandle) -> BTreeMap<String, String> {
    path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write(app: &AppHandle, prefs: &BTreeMap<String, String>) -> Result<(), String> {
    let p = path(app).ok_or("no config folder")?;
    if let Some(dir) = p.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(prefs).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn prefs_all(app: AppHandle) -> BTreeMap<String, String> {
    read(&app)
}

#[tauri::command]
pub fn prefs_set(app: AppHandle, key: String, value: Option<String>, source: String) -> Result<(), String> {
    let lock = app.state::<PrefsLock>();
    let _guard = lock.0.lock().map_err(|e| e.to_string())?;
    let mut prefs = read(&app);
    match &value {
        Some(v) => { prefs.insert(key.clone(), v.clone()); }
        None => { prefs.remove(&key); }
    }
    write(&app, &prefs)?;
    crate::tabmode::notify(&app, "prefs://changed", json!({ "key": key, "value": value, "source": source }));
    Ok(())
}

#[tauri::command]
pub fn prefs_seed(app: AppHandle, prefs: BTreeMap<String, String>) -> Result<BTreeMap<String, String>, String> {
    let lock = app.state::<PrefsLock>();
    let _guard = lock.0.lock().map_err(|e| e.to_string())?;
    let mut all = read(&app);
    let mut added = false;
    for (k, v) in prefs {
        if !all.contains_key(&k) { all.insert(k, v); added = true; }
    }
    if added { write(&app, &all)?; }
    Ok(all)
}
