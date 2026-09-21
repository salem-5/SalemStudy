//! Moving all of the user's data: export to one file, import an exact copy,
//! or reset to a fresh start.
//!
//! An export is a SQLite file: a consistent copy of `study.db` (made with
//! `VACUUM INTO`, so every source, note, chat and file is inside) plus a small
//! `salemstudy_export` table holding, optionally, the settings — the AI config
//! without the API key, and the app's local preferences. Importing replaces
//! `study.db` with it (the previous one is kept as `study.before-import.db`)
//! and restores the settings but never the API key.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::study::{self, with_db, StudyDb};
use crate::{read_config, write_config, Config};

const EXPORT_TABLE: &str = "salemstudy_export";
const FORMAT: &str = "1";

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// Close the database so its file can be replaced; the next use reopens it.
fn close(db: &StudyDb) -> Result<(), String> {
    let mut guard = db.0.lock().map_err(|_| "study database lock poisoned".to_string())?;
    *guard = None;
    Ok(())
}

fn remove_db_files(dir: &Path) -> Result<(), String> {
    for name in ["study.db", "study.db-wal", "study.db-shm"] {
        let p = dir.join(name);
        if p.exists() {
            fs::remove_file(&p).map_err(|e| format!("cannot remove {name}: {e}"))?;
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub bytes: u64,
}

/// Write the settings rows into an exported copy.
pub fn stamp(conn: &Connection, config: Option<&Config>, local: Option<&str>) -> rusqlite::Result<()> {
    conn.execute_batch(&format!("CREATE TABLE IF NOT EXISTS {EXPORT_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL);"))?;
    let put = |k: &str, v: &str| conn.execute(&format!("INSERT OR REPLACE INTO {EXPORT_TABLE} (key, value) VALUES (?1, ?2)"), params![k, v]);
    put("format", FORMAT)?;
    put("app", "SalemStudy")?;
    put("exported_at", &study::now_ms().to_string())?;
    if let Some(cfg) = config {
        let mut cfg = cfg.clone();
        cfg.api_key = String::new();
        put("config", &serde_json::to_string(&cfg).unwrap_or_default())?;
    }
    if let Some(local) = local {
        put("local", local)?;
    }
    Ok(())
}

#[tauri::command]
pub fn data_export(app: AppHandle, db: State<'_, StudyDb>, path: String, include_settings: bool, local: Option<String>) -> Result<ExportResult, String> {
    let target = PathBuf::from(&path);
    if target.exists() {
        fs::remove_file(&target).map_err(|e| format!("cannot replace {path}: {e}"))?;
    }
    with_db(&app, &db, |c| c.execute("VACUUM INTO ?1", [&path]).map(|_| ()))?;
    let out = Connection::open(&target).map_err(|e| e.to_string())?;
    let cfg = include_settings.then(|| read_config(&app));
    stamp(&out, cfg.as_ref(), if include_settings { local.as_deref() } else { None }).map_err(|e| e.to_string())?;
    drop(out);
    let bytes = fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    Ok(ExportResult { path, bytes })
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportInfo {
    pub exported_at: Option<i64>,
    pub has_settings: bool,
    pub subjects: i64,
    pub notebooks: i64,
    pub sources: i64,
    pub notes: i64,
    pub chats: i64,
    pub events: i64,
    pub bytes: u64,
}

/// Check a file is a SalemStudy export (or a study.db) this version can read.
pub fn inspect(path: &Path) -> Result<ExportInfo, String> {
    let bad = || "This file is not a SalemStudy export.".to_string();
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_| bad())?;
    let has = |t: &str| -> bool {
        c.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", [t], |_| Ok(())).optional().ok().flatten().is_some()
    };
    if !has("subject") || !has("notebook") {
        return Err(bad());
    }
    let version: usize = c.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(|_| bad())?;
    if version > study::schema_version() {
        return Err("This export was made by a newer version of SalemStudy. Update the app, then import it.".into());
    }
    let count = |t: &str| -> i64 { if has(t) { c.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0)).unwrap_or(0) } else { 0 } };
    let get = |k: &str| -> Option<String> {
        if !has(EXPORT_TABLE) { return None; }
        c.query_row(&format!("SELECT value FROM {EXPORT_TABLE} WHERE key = ?1"), [k], |r| r.get(0)).optional().ok().flatten()
    };
    Ok(ExportInfo {
        exported_at: get("exported_at").and_then(|v| v.parse().ok()),
        has_settings: get("config").is_some() || get("local").is_some(),
        subjects: count("subject"),
        notebooks: count("notebook"),
        sources: count("source"),
        notes: count("note"),
        chats: count("conversation"),
        events: count("event"),
        bytes: fs::metadata(path).map(|m| m.len()).unwrap_or(0),
    })
}

#[tauri::command]
pub fn data_inspect(path: String) -> Result<ExportInfo, String> {
    inspect(Path::new(&path))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// The exported local preferences (JSON), for the webview to restore.
    pub local: Option<String>,
    pub settings: bool,
}

/// Copy an export into place as `dest`: settings rows removed, settings returned.
pub fn unpack(src: &Path, dest: &Path) -> Result<(Option<Config>, Option<String>), String> {
    inspect(src)?;
    fs::copy(src, dest).map_err(|e| format!("cannot copy the export: {e}"))?;
    let c = Connection::open(dest).map_err(|e| e.to_string())?;
    let get = |k: &str| -> Option<String> {
        c.query_row(&format!("SELECT value FROM {EXPORT_TABLE} WHERE key = ?1"), [k], |r| r.get(0)).optional().ok().flatten()
    };
    let config = get("config").and_then(|v| serde_json::from_str::<Config>(&v).ok());
    let local = get("local");
    c.execute_batch(&format!("DROP TABLE IF EXISTS {EXPORT_TABLE};")).map_err(|e| e.to_string())?;
    // A copy may still be in WAL mode from where it came; settle it into one file.
    c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").ok();
    drop(c);
    for ext in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{ext}", dest.display()));
        if side.exists() { let _ = fs::remove_file(side); }
    }
    Ok((config, local))
}

#[tauri::command]
pub fn data_import(app: AppHandle, db: State<'_, StudyDb>, path: String) -> Result<ImportResult, String> {
    let dir = data_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let staging = dir.join("study.importing.db");
    if staging.exists() { let _ = fs::remove_file(&staging); }
    let (config, local) = unpack(Path::new(&path), &staging)?;

    close(&db)?;
    let live = dir.join("study.db");
    if live.exists() {
        fs::copy(&live, dir.join("study.before-import.db")).map_err(|e| format!("cannot back up the current data: {e}"))?;
    }
    remove_db_files(&dir)?;
    fs::rename(&staging, &live).map_err(|e| format!("cannot put the import in place: {e}"))?;
    // Reopen now so an older export is migrated straight away.
    with_db(&app, &db, |_| Ok(()))?;

    if let Some(mut cfg) = config.clone() {
        cfg.api_key = read_config(&app).api_key;
        write_config(&app, &cfg)?;
    }
    Ok(ImportResult { settings: config.is_some() || local.is_some(), local })
}

/// Delete everything: every subject, notebook, source, chat, card, event and
/// memory. With `forget_key`, the API key and AI settings go too.
#[tauri::command]
pub fn data_reset(app: AppHandle, db: State<'_, StudyDb>, forget_key: bool) -> Result<(), String> {
    let dir = data_dir(&app)?;
    close(&db)?;
    remove_db_files(&dir)?;
    let _ = fs::remove_file(dir.join("study.before-import.db"));
    if forget_key {
        write_config(&app, &Config::default())?;
    }
    with_db(&app, &db, |_| Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("salemstudy-data-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn export_round_trips_data_and_settings_without_the_key() {
        let d = tmp("roundtrip");
        let live = study::open(&d.join("study.db")).unwrap();
        let s = study::create_subject(&live, "Physics 1").unwrap();
        study::create_notebook(&live, s, "Waves", "").unwrap();
        let file = d.join("backup.salemstudy");
        live.execute("VACUUM INTO ?1", [file.to_str().unwrap()]).unwrap();
        let cfg = Config { api_key: "sk-secret".into(), flash_model: "custom-flash".into(), ..Config::default() };
        stamp(&Connection::open(&file).unwrap(), Some(&cfg), Some(r#"{"wa.theme":"light"}"#)).unwrap();

        let info = inspect(&file).unwrap();
        assert_eq!((info.subjects, info.notebooks, info.has_settings), (1, 1, true));

        let dest = d.join("restored.db");
        let (config, local) = unpack(&file, &dest).unwrap();
        let config = config.unwrap();
        assert_eq!(config.flash_model, "custom-flash");
        assert_eq!(config.api_key, "", "the key never travels in an export");
        assert_eq!(local.as_deref(), Some(r#"{"wa.theme":"light"}"#));
        let restored = study::open(&dest).unwrap();
        assert_eq!(study::tree(&restored).unwrap()[0].name, "Physics 1");
        let leftover: i64 = restored
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = ?1", [EXPORT_TABLE], |r| r.get(0))
            .unwrap();
        assert_eq!(leftover, 0);
    }

    #[test]
    fn data_only_export_has_no_settings() {
        let d = tmp("dataonly");
        let live = study::open(&d.join("study.db")).unwrap();
        let file = d.join("x.salemstudy");
        live.execute("VACUUM INTO ?1", [file.to_str().unwrap()]).unwrap();
        stamp(&Connection::open(&file).unwrap(), None, None).unwrap();
        assert!(!inspect(&file).unwrap().has_settings);
        assert_eq!(unpack(&file, &d.join("r.db")).unwrap().0.is_none(), true);
    }

    #[test]
    fn rejects_other_files_and_newer_versions() {
        let d = tmp("reject");
        let junk = d.join("notes.txt");
        fs::write(&junk, "hello").unwrap();
        assert!(inspect(&junk).is_err());
        let other = d.join("other.db");
        Connection::open(&other).unwrap().execute_batch("CREATE TABLE t (x);").unwrap();
        assert!(inspect(&other).is_err());
        let newer = d.join("newer.db");
        let c = study::open(&newer).unwrap();
        c.pragma_update(None, "user_version", study::schema_version() + 1).unwrap();
        drop(c);
        assert!(inspect(&newer).unwrap_err().contains("newer"));
    }
}
