//! Notes — the student's own notes app, laid out like Apple Notes.
//!
//! Separate from a notebook's study notes: these are the student's, in
//! folders of their own, written in a rich editor (Tiptap) and kept as HTML,
//! with a plain-text copy for titles, previews and search. The first line of
//! a note is its title, as in Apple Notes.
//!
//! Deleting is soft: a deleted note (or a deleted folder's notes) goes to
//! Recently Deleted and can be put back — which matters all the more now the
//! chats can edit and delete notes too.
//!
//! Every change is announced (`pad://changed`), so a note open in the window
//! or a browser tab updates when the assistant writes to it.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, State};

use super::{expect_one, now_ms, with_db, StudyDb};

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PadFolder {
    pub id: i64,
    pub name: String,
    pub count: i64,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PadNoteMeta {
    pub id: i64,
    pub folder_id: Option<i64>,
    pub title: String,
    pub snippet: String,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PadNote {
    #[serde(flatten)]
    pub meta: PadNoteMeta,
    pub html: String,
    pub text: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PadOverview {
    pub folders: Vec<PadFolder>,
    /// Notes not deleted, in any folder or none.
    pub all: i64,
    /// Notes in no folder ("Notes").
    pub unfiled: i64,
    pub deleted: i64,
}

/// The title is the first line with anything on it; the preview is what
/// follows. Apple Notes does the same.
pub fn title_and_snippet(text: &str) -> (String, String) {
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let title: String = lines.next().unwrap_or("").chars().take(120).collect();
    let rest: String = lines.collect::<Vec<_>>().join(" ");
    let snippet: String = rest.chars().take(160).collect();
    (title, snippet)
}

const META_COLS: &str = "id, folder_id, text, pinned, created_at, updated_at, deleted_at";

fn meta_row(r: &rusqlite::Row) -> rusqlite::Result<PadNoteMeta> {
    let text: String = r.get(2)?;
    let (title, snippet) = title_and_snippet(&text);
    Ok(PadNoteMeta {
        id: r.get(0)?,
        folder_id: r.get(1)?,
        title,
        snippet,
        pinned: r.get::<_, i64>(3)? != 0,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
        deleted_at: r.get(6)?,
    })
}

pub fn overview(c: &Connection) -> rusqlite::Result<PadOverview> {
    let folders = c
        .prepare(
            "SELECT f.id, f.name, (SELECT COUNT(*) FROM pad_note n WHERE n.folder_id = f.id AND n.deleted_at IS NULL)
             FROM pad_folder f ORDER BY f.position, lower(f.name)",
        )?
        .query_map([], |r| Ok(PadFolder { id: r.get(0)?, name: r.get(1)?, count: r.get(2)? }))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let count = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0));
    Ok(PadOverview {
        folders,
        all: count("SELECT COUNT(*) FROM pad_note WHERE deleted_at IS NULL")?,
        unfiled: count("SELECT COUNT(*) FROM pad_note WHERE deleted_at IS NULL AND folder_id IS NULL")?,
        deleted: count("SELECT COUNT(*) FROM pad_note WHERE deleted_at IS NOT NULL")?,
    })
}

/// Which notes a list shows: all of them, the ones in no folder, one
/// folder's, or Recently Deleted.
pub fn notes(c: &Connection, scope: &str, folder: Option<i64>) -> rusqlite::Result<Vec<PadNoteMeta>> {
    let (filter, arg): (&str, Option<i64>) = match scope {
        "deleted" => ("deleted_at IS NOT NULL", None),
        "unfiled" => ("deleted_at IS NULL AND folder_id IS NULL", None),
        "folder" => ("deleted_at IS NULL AND folder_id = ?1", folder),
        _ => ("deleted_at IS NULL", None),
    };
    let sql = format!("SELECT {META_COLS} FROM pad_note WHERE {filter} ORDER BY pinned DESC, updated_at DESC, id DESC");
    let mut stmt = c.prepare(&sql)?;
    let rows = match arg {
        Some(a) => stmt.query_map([a], meta_row)?.collect(),
        None => stmt.query_map([], meta_row)?.collect(),
    };
    rows
}

pub fn get(c: &Connection, id: i64) -> rusqlite::Result<Option<PadNote>> {
    c.query_row(
        &format!("SELECT {META_COLS}, html FROM pad_note WHERE id = ?1"),
        [id],
        |r| {
            let meta = meta_row(r)?;
            Ok(PadNote { html: r.get(7)?, text: r.get(2)?, meta })
        },
    )
    .optional()
}

pub fn create(c: &Connection, folder: Option<i64>, html: &str, text: &str) -> rusqlite::Result<PadNote> {
    let t = now_ms();
    c.execute(
        "INSERT INTO pad_note (folder_id, html, text, pinned, created_at, updated_at) VALUES (?1, ?2, ?3, 0, ?4, ?4)",
        params![folder, html, text, t],
    )?;
    Ok(get(c, c.last_insert_rowid())?.expect("just inserted"))
}

/// Every word of the query somewhere in the note (title included).
pub fn search(c: &Connection, query: &str) -> rusqlite::Result<Vec<PadNoteMeta>> {
    let words: Vec<String> = query.split_whitespace().map(|w| format!("%{}%", w.to_lowercase())).collect();
    if words.is_empty() {
        return notes(c, "all", None);
    }
    let cond = (1..=words.len()).map(|i| format!("lower(text) LIKE ?{i}")).collect::<Vec<_>>().join(" AND ");
    let sql = format!("SELECT {META_COLS} FROM pad_note WHERE deleted_at IS NULL AND {cond} ORDER BY pinned DESC, updated_at DESC LIMIT 200");
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(words.iter()), meta_row)?.collect();
    rows
}

fn changed(app: &AppHandle, what: &str, id: Option<i64>, by: Option<String>) {
    crate::tabmode::notify(app, "pad://changed", json!({ "what": what, "id": id, "by": by }));
}

fn clean_name(name: &str) -> Result<String, String> {
    let n = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if n.is_empty() { return Err("A folder needs a name.".into()); }
    Ok(n.chars().take(80).collect())
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub fn pad_overview(app: AppHandle, db: State<'_, StudyDb>) -> Result<PadOverview, String> {
    with_db(&app, &db, overview)
}

#[tauri::command]
pub fn pad_notes(app: AppHandle, db: State<'_, StudyDb>, scope: String, folder: Option<i64>) -> Result<Vec<PadNoteMeta>, String> {
    with_db(&app, &db, |c| notes(c, &scope, folder))
}

#[tauri::command]
pub fn pad_search(app: AppHandle, db: State<'_, StudyDb>, query: String) -> Result<Vec<PadNoteMeta>, String> {
    with_db(&app, &db, |c| search(c, &query))
}

#[tauri::command]
pub fn pad_note(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<PadNote, String> {
    with_db(&app, &db, |c| get(c, id))?.ok_or_else(|| "Note not found.".into())
}

#[tauri::command]
pub fn pad_folder_create(app: AppHandle, db: State<'_, StudyDb>, name: String, by: Option<String>) -> Result<PadFolder, String> {
    let name = clean_name(&name)?;
    let folder = with_db(&app, &db, |c| {
        let pos: i64 = c.query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM pad_folder", [], |r| r.get(0))?;
        c.execute("INSERT INTO pad_folder (name, position, created_at) VALUES (?1, ?2, ?3)", params![name, pos, now_ms()])?;
        Ok(PadFolder { id: c.last_insert_rowid(), name: name.clone(), count: 0 })
    })?;
    changed(&app, "folder", Some(folder.id), by);
    Ok(folder)
}

#[tauri::command]
pub fn pad_folder_rename(app: AppHandle, db: State<'_, StudyDb>, id: i64, name: String, by: Option<String>) -> Result<(), String> {
    let name = clean_name(&name)?;
    let n = with_db(&app, &db, |c| c.execute("UPDATE pad_folder SET name = ?2 WHERE id = ?1", params![id, name]))?;
    expect_one(n, "Folder")?;
    changed(&app, "folder", Some(id), by);
    Ok(())
}

/// A deleted folder's notes go to Recently Deleted, not nowhere.
#[tauri::command]
pub fn pad_folder_delete(app: AppHandle, db: State<'_, StudyDb>, id: i64, by: Option<String>) -> Result<(), String> {
    let n = with_db(&app, &db, |c| {
        let tx = c.unchecked_transaction()?;
        tx.execute("UPDATE pad_note SET deleted_at = ?2, folder_id = NULL WHERE folder_id = ?1 AND deleted_at IS NULL", params![id, now_ms()])?;
        let n = tx.execute("DELETE FROM pad_folder WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(n)
    })?;
    expect_one(n, "Folder")?;
    changed(&app, "folder", Some(id), by);
    Ok(())
}

#[tauri::command]
pub fn pad_note_create(app: AppHandle, db: State<'_, StudyDb>, folder: Option<i64>, html: String, text: String, by: Option<String>) -> Result<PadNote, String> {
    let note = with_db(&app, &db, |c| create(c, folder, &html, &text))?;
    changed(&app, "note", Some(note.meta.id), by);
    Ok(note)
}

#[tauri::command]
pub fn pad_note_save(app: AppHandle, db: State<'_, StudyDb>, id: i64, html: String, text: String, by: Option<String>) -> Result<i64, String> {
    let t = now_ms();
    let n = with_db(&app, &db, |c| c.execute("UPDATE pad_note SET html = ?2, text = ?3, updated_at = ?4 WHERE id = ?1", params![id, html, text, t]))?;
    expect_one(n, "Note")?;
    changed(&app, "note", Some(id), by);
    Ok(t)
}

#[tauri::command]
pub fn pad_note_move(app: AppHandle, db: State<'_, StudyDb>, id: i64, folder: Option<i64>, by: Option<String>) -> Result<(), String> {
    let n = with_db(&app, &db, |c| c.execute("UPDATE pad_note SET folder_id = ?2, deleted_at = NULL WHERE id = ?1", params![id, folder]))?;
    expect_one(n, "Note")?;
    changed(&app, "note", Some(id), by);
    Ok(())
}

#[tauri::command]
pub fn pad_note_pin(app: AppHandle, db: State<'_, StudyDb>, id: i64, pinned: bool, by: Option<String>) -> Result<(), String> {
    let n = with_db(&app, &db, |c| c.execute("UPDATE pad_note SET pinned = ?2 WHERE id = ?1", params![id, pinned as i64]))?;
    expect_one(n, "Note")?;
    changed(&app, "note", Some(id), by);
    Ok(())
}

/// To Recently Deleted; `forever` only for a note already there.
#[tauri::command]
pub fn pad_note_delete(app: AppHandle, db: State<'_, StudyDb>, id: i64, forever: Option<bool>, by: Option<String>) -> Result<(), String> {
    let n = with_db(&app, &db, |c| {
        if forever == Some(true) {
            c.execute("DELETE FROM pad_note WHERE id = ?1 AND deleted_at IS NOT NULL", [id])
        } else {
            c.execute("UPDATE pad_note SET deleted_at = ?2, pinned = 0 WHERE id = ?1 AND deleted_at IS NULL", params![id, now_ms()])
        }
    })?;
    expect_one(n, "Note")?;
    changed(&app, "note", Some(id), by);
    Ok(())
}

#[tauri::command]
pub fn pad_note_restore(app: AppHandle, db: State<'_, StudyDb>, id: i64, by: Option<String>) -> Result<(), String> {
    let n = with_db(&app, &db, |c| c.execute("UPDATE pad_note SET deleted_at = NULL WHERE id = ?1 AND deleted_at IS NOT NULL", [id]))?;
    expect_one(n, "Note")?;
    changed(&app, "note", Some(id), by);
    Ok(())
}

#[tauri::command]
pub fn pad_empty_deleted(app: AppHandle, db: State<'_, StudyDb>, by: Option<String>) -> Result<usize, String> {
    let n = with_db(&app, &db, |c| c.execute("DELETE FROM pad_note WHERE deleted_at IS NOT NULL", []))?;
    changed(&app, "note", None, by);
    Ok(n)
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
    fn the_first_line_is_the_title() {
        assert_eq!(title_and_snippet("\n  Shopping  \nmilk\n\neggs"), ("Shopping".into(), "milk eggs".into()));
        assert_eq!(title_and_snippet(""), ("".into(), "".into()));
    }

    #[test]
    fn folders_notes_and_recently_deleted() {
        let c = db();
        c.execute("INSERT INTO pad_folder (name, position, created_at) VALUES ('Physics', 1, 0)", []).unwrap();
        let f = c.last_insert_rowid();
        let a = create(&c, Some(f), "<p>Forces</p>", "Forces\nF = ma").unwrap();
        let _b = create(&c, None, "<p>Loose</p>", "Loose").unwrap();
        let o = overview(&c).unwrap();
        assert_eq!((o.all, o.unfiled, o.deleted, o.folders[0].count), (2, 1, 0, 1));
        assert_eq!(notes(&c, "folder", Some(f)).unwrap()[0].title, "Forces");
        assert_eq!(search(&c, "f = ma").unwrap().len(), 1);
        assert_eq!(search(&c, "forces loose").unwrap().len(), 0, "every word must match");

        // Deleting the folder sends its notes to Recently Deleted.
        c.execute("UPDATE pad_note SET deleted_at = 1, folder_id = NULL WHERE folder_id = ?1", [f]).unwrap();
        c.execute("DELETE FROM pad_folder WHERE id = ?1", [f]).unwrap();
        let o = overview(&c).unwrap();
        assert_eq!((o.all, o.deleted, o.folders.len()), (1, 1, 0));
        assert_eq!(notes(&c, "deleted", None).unwrap()[0].id, a.meta.id);
    }

    #[test]
    fn pinned_notes_come_first() {
        let c = db();
        let a = create(&c, None, "", "Old").unwrap();
        let _b = create(&c, None, "", "New").unwrap();
        c.execute("UPDATE pad_note SET pinned = 1 WHERE id = ?1", [a.meta.id]).unwrap();
        assert_eq!(notes(&c, "all", None).unwrap()[0].title, "Old");
    }
}
