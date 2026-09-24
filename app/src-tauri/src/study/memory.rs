use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, State};

use super::{expect_one, now_ms, with_db, StudyDb};

pub const MAX_FACT_CHARS: usize = 400;
pub const CAPACITY_CHARS: usize = 12_000;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: i64,
    pub text: String,
    pub source: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn row(r: &rusqlite::Row) -> rusqlite::Result<Memory> {
    Ok(Memory { id: r.get(0)?, text: r.get(1)?, source: r.get(2)?, created_at: r.get(3)?, updated_at: r.get(4)? })
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Memory>> {
    conn.prepare("SELECT id, text, source, created_at, updated_at FROM memory ORDER BY created_at, id")?
        .query_map([], row)?
        .collect()
}

fn used(conn: &Connection) -> rusqlite::Result<usize> {
    Ok(list(conn)?.iter().map(|m| m.text.chars().count()).sum())
}

fn clean(text: &str) -> Result<String, String> {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        return Err("A memory needs some text.".into());
    }
    Ok(t.chars().take(MAX_FACT_CHARS).collect())
}

pub fn add(conn: &Connection, text: &str, source: &str) -> Result<Memory, String> {
    let text = clean(text)?;
    let db = |e: rusqlite::Error| e.to_string();
    let same: Option<Memory> = conn
        .query_row(
            "SELECT id, text, source, created_at, updated_at FROM memory WHERE lower(text) = lower(?1)",
            [&text],
            row,
        )
        .optional()
        .map_err(db)?;
    if let Some(m) = same {
        return Ok(m);
    }
    if used(conn).map_err(db)? + text.chars().count() > CAPACITY_CHARS {
        return Err("Memory is full. Delete some memories in Settings → Memory to make room.".into());
    }
    let t = now_ms();
    conn.execute(
        "INSERT INTO memory (text, source, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params![text, source, t],
    )
    .map_err(db)?;
    conn.query_row("SELECT id, text, source, created_at, updated_at FROM memory WHERE id = ?1", [conn.last_insert_rowid()], row)
        .map_err(db)
}

pub fn update(conn: &Connection, id: i64, text: &str) -> Result<usize, String> {
    let text = clean(text)?;
    conn.execute("UPDATE memory SET text = ?2, updated_at = ?3 WHERE id = ?1", params![id, text, now_ms()])
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryState {
    pub items: Vec<Memory>,
    pub used: usize,
    pub capacity: usize,
}

#[tauri::command]
pub fn memory_list(app: AppHandle, db: State<'_, StudyDb>) -> Result<MemoryState, String> {
    with_db(&app, &db, |c| {
        let items = list(c)?;
        let used = items.iter().map(|m| m.text.chars().count()).sum();
        Ok(MemoryState { items, used, capacity: CAPACITY_CHARS })
    })
}

#[tauri::command]
pub fn memory_add(app: AppHandle, db: State<'_, StudyDb>, text: String, source: Option<String>) -> Result<Memory, String> {
    let source = if source.as_deref() == Some("user") { "user" } else { "chat" };
    with_db(&app, &db, |c| Ok(add(c, &text, source)))?
}

#[tauri::command]
pub fn memory_update(app: AppHandle, db: State<'_, StudyDb>, id: i64, text: String) -> Result<(), String> {
    let changed = with_db(&app, &db, |c| Ok(update(c, id, &text)))??;
    expect_one(changed, "Memory")
}

#[tauri::command]
pub fn memory_delete(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<(), String> {
    let changed = with_db(&app, &db, |c| c.execute("DELETE FROM memory WHERE id = ?1", [id]))?;
    expect_one(changed, "Memory")
}

#[tauri::command]
pub fn memory_clear(app: AppHandle, db: State<'_, StudyDb>) -> Result<usize, String> {
    with_db(&app, &db, |c| c.execute("DELETE FROM memory", []))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        super::super::prepare(&c).unwrap();
        c
    }

    #[test]
    fn saves_trims_and_keeps_duplicates_once() {
        let c = db();
        let a = add(&c, "  Studies   mechanical engineering ", "chat").unwrap();
        assert_eq!(a.text, "Studies mechanical engineering");
        let b = add(&c, "studies MECHANICAL engineering", "user").unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(list(&c).unwrap().len(), 1);
        assert!(add(&c, "   ", "chat").is_err());
        assert_eq!(add(&c, &"x".repeat(1000), "chat").unwrap().text.len(), MAX_FACT_CHARS);
    }

    #[test]
    fn a_full_memory_refuses_new_facts() {
        let c = db();
        for i in 0..(CAPACITY_CHARS / MAX_FACT_CHARS) {
            add(&c, &format!("{i:03}{}", "y".repeat(MAX_FACT_CHARS - 3)), "chat").unwrap();
        }
        let err = add(&c, "One more fact", "chat").unwrap_err();
        assert!(err.contains("full"));
        let first = list(&c).unwrap()[0].id;
        c.execute("DELETE FROM memory WHERE id = ?1", [first]).unwrap();
        assert!(add(&c, "One more fact", "chat").is_ok());
    }

    #[test]
    fn editing_changes_the_text() {
        let c = db();
        let m = add(&c, "Takes Physics 1", "chat").unwrap();
        assert_eq!(update(&c, m.id, "Takes Physics 1 and 2").unwrap(), 1);
        assert_eq!(list(&c).unwrap()[0].text, "Takes Physics 1 and 2");
        assert_eq!(update(&c, 999, "x").unwrap(), 0);
    }
}
