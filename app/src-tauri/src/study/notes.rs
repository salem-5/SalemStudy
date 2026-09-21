//! Notes: Markdown documents in a notebook, generated from sources, a topic
//! or a chat (with the user's instructions kept for rewrites) and edited by hand.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, State};

use super::{expect_one, now_ms, with_db, StudyDb};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: i64,
    pub notebook_id: i64,
    pub title: String,
    pub content: String,
    /// What the user asked for when it was written ("exam cheat sheet", …).
    pub instructions: String,
    pub created_at: i64,
    pub updated_at: i64,
}

const COLS: &str = "id, notebook_id, title, content, instructions, created_at, updated_at";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: r.get(0)?,
        notebook_id: r.get(1)?,
        title: r.get(2)?,
        content: r.get(3)?,
        instructions: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Option<Note>> {
    conn.query_row(&format!("SELECT {COLS} FROM note WHERE id = ?1"), [id], row).optional()
}

pub fn list(conn: &Connection, notebook_id: i64) -> rusqlite::Result<Vec<Note>> {
    conn.prepare(&format!("SELECT {COLS} FROM note WHERE notebook_id = ?1 ORDER BY updated_at DESC, id DESC"))?
        .query_map([notebook_id], row)?
        .collect()
}

pub fn create(conn: &Connection, notebook_id: i64, title: &str, content: &str, instructions: &str) -> rusqlite::Result<Note> {
    let t = now_ms();
    conn.execute(
        "INSERT INTO note (notebook_id, title, content, instructions, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![notebook_id, title, content, instructions, t],
    )?;
    Ok(get(conn, conn.last_insert_rowid())?.expect("just inserted"))
}

#[tauri::command]
pub fn notes_list(app: AppHandle, db: State<'_, StudyDb>, notebook_id: i64) -> Result<Vec<Note>, String> {
    with_db(&app, &db, |c| list(c, notebook_id))
}

#[tauri::command]
pub fn note_get(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<Note, String> {
    with_db(&app, &db, |c| get(c, id))?.ok_or_else(|| "Note not found.".into())
}

#[tauri::command]
pub fn note_create(app: AppHandle, db: State<'_, StudyDb>, notebook_id: i64, title: String, content: String, instructions: Option<String>) -> Result<Note, String> {
    let title: String = title.trim().chars().take(200).collect();
    let title = if title.is_empty() { "Untitled note".to_string() } else { title };
    with_db(&app, &db, |c| create(c, notebook_id, &title, &content, instructions.as_deref().unwrap_or("")))
}

#[tauri::command]
pub fn note_update(
    app: AppHandle,
    db: State<'_, StudyDb>,
    id: i64,
    title: Option<String>,
    content: Option<String>,
    instructions: Option<String>,
) -> Result<Note, String> {
    let title = title.map(|t| super::clean_name(&t)).transpose()?;
    let changed = with_db(&app, &db, |c| {
        c.execute(
            "UPDATE note SET title = COALESCE(?2, title), content = COALESCE(?3, content),
                             instructions = COALESCE(?4, instructions), updated_at = ?5 WHERE id = ?1",
            params![id, title, content, instructions, now_ms()],
        )
    })?;
    expect_one(changed, "Note")?;
    with_db(&app, &db, |c| get(c, id))?.ok_or_else(|| "Note not found.".into())
}

#[tauri::command]
pub fn note_delete(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<(), String> {
    let changed = with_db(&app, &db, |c| c.execute("DELETE FROM note WHERE id = ?1", [id]))?;
    expect_one(changed, "Note")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_are_listed_newest_first_and_go_with_their_notebook() {
        let c = Connection::open_in_memory().unwrap();
        super::super::prepare(&c).unwrap();
        let s = super::super::create_subject(&c, "Calc").unwrap();
        let nb = super::super::create_notebook(&c, s, "Lines", "").unwrap();
        let a = create(&c, nb, "Lines", "# Lines", "cheat sheet").unwrap();
        c.execute("UPDATE note SET updated_at = 0 WHERE id = ?1", [a.id]).unwrap();
        let b = create(&c, nb, "Planes", "# Planes", "").unwrap();
        assert_eq!(list(&c, nb).unwrap().iter().map(|n| n.id).collect::<Vec<_>>(), [b.id, a.id]);
        assert_eq!(get(&c, a.id).unwrap().unwrap().instructions, "cheat sheet");
        c.execute("DELETE FROM notebook WHERE id = ?1", [nb]).unwrap();
        assert!(list(&c, nb).unwrap().is_empty());
    }
}
