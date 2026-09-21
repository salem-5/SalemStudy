//! A subject's syllabus: the uploaded file (kept as an attachment outside any
//! chat), its text, and the AI's summary of it that every notebook chat of the
//! subject reads as course context.

use rusqlite::{params, Connection, OptionalExtension};
use tauri::{AppHandle, State};

use super::{expect_one, now_ms, with_db, StudyDb};

/// Set (or replace) the syllabus. A replaced file is deleted.
pub fn set(conn: &Connection, subject_id: i64, file: Option<i64>, name: &str, text: &str, summary: &str) -> rusqlite::Result<usize> {
    let old: Option<Option<i64>> = conn
        .query_row("SELECT syllabus_file FROM subject WHERE id = ?1", [subject_id], |r| r.get(0))
        .optional()?;
    let Some(old) = old else { return Ok(0) };
    let changed = conn.execute(
        "UPDATE subject SET syllabus_file = ?2, syllabus_name = ?3, syllabus_text = ?4, syllabus_summary = ?5, syllabus_at = ?6 WHERE id = ?1",
        params![subject_id, file, name, text, summary, now_ms()],
    )?;
    if let Some(old) = old.filter(|o| Some(*o) != file) {
        conn.execute("DELETE FROM attachment WHERE id = ?1", [old])?;
    }
    Ok(changed)
}

pub fn clear(conn: &Connection, subject_id: i64) -> rusqlite::Result<usize> {
    set(conn, subject_id, None, "", "", "")
}

/// Remove the syllabus file when its subject goes (attachments do not cascade from subjects).
pub fn delete_file_of(conn: &Connection, subject_id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM attachment WHERE id = (SELECT syllabus_file FROM subject WHERE id = ?1)",
        [subject_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn syllabus_set(
    app: AppHandle,
    db: State<'_, StudyDb>,
    subject_id: i64,
    file: Option<i64>,
    name: String,
    text: String,
    summary: String,
) -> Result<(), String> {
    let changed = with_db(&app, &db, |c| set(c, subject_id, file, name.trim(), &text, summary.trim()))?;
    expect_one(changed, "Subject")
}

#[tauri::command]
pub fn syllabus_clear(app: AppHandle, db: State<'_, StudyDb>, subject_id: i64) -> Result<(), String> {
    let changed = with_db(&app, &db, |c| clear(c, subject_id))?;
    expect_one(changed, "Subject")
}

/// The syllabus's full text (the tree only carries its name and summary).
#[tauri::command]
pub fn syllabus_text(app: AppHandle, db: State<'_, StudyDb>, subject_id: i64) -> Result<String, String> {
    with_db(&app, &db, |c| {
        c.query_row("SELECT syllabus_text FROM subject WHERE id = ?1", [subject_id], |r| r.get(0))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        super::super::prepare(&c).unwrap();
        c
    }

    fn file(c: &Connection, name: &str) -> i64 {
        c.execute(
            "INSERT INTO attachment (conversation_id, notebook_id, kind, name, mime, size, data, created_at) VALUES (NULL, NULL, 'syllabus', ?1, 'text/plain', 1, x'41', 0)",
            [name],
        )
        .unwrap();
        c.last_insert_rowid()
    }

    fn files(c: &Connection) -> i64 {
        c.query_row("SELECT COUNT(*) FROM attachment", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn replacing_the_syllabus_deletes_the_old_file_and_shows_in_the_tree() {
        let c = db();
        let s = super::super::create_subject(&c, "Calc").unwrap();
        let a = file(&c, "old.pdf");
        assert_eq!(set(&c, s, Some(a), "old.pdf", "text", "sum").unwrap(), 1);
        let b = file(&c, "new.pdf");
        set(&c, s, Some(b), "new.pdf", "text 2", "Midterm is 30%").unwrap();
        assert_eq!(files(&c), 1);
        let t = super::super::tree(&c).unwrap();
        assert_eq!(t[0].syllabus_name, "new.pdf");
        assert_eq!(t[0].syllabus_summary, "Midterm is 30%");
        clear(&c, s).unwrap();
        assert_eq!(files(&c), 0);
        assert_eq!(super::super::tree(&c).unwrap()[0].syllabus_name, "");
    }

    #[test]
    fn unknown_subject_changes_nothing() {
        let c = db();
        assert_eq!(set(&c, 99, None, "x", "", "").unwrap(), 0);
    }

    #[test]
    fn deleting_the_subject_can_take_its_file() {
        let c = db();
        let s = super::super::create_subject(&c, "Calc").unwrap();
        let a = file(&c, "s.pdf");
        set(&c, s, Some(a), "s.pdf", "", "").unwrap();
        delete_file_of(&c, s).unwrap();
        c.execute("DELETE FROM subject WHERE id = ?1", [s]).unwrap();
        assert_eq!(files(&c), 0);
    }
}
