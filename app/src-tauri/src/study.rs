//! Study: Subject → Notebook → Sources, kept in one SQLite file (`study.db`)
//! under the app data dir. See docs/study-plan.md.
//!
//! Every notebook-owned row carries `notebook_id` (directly or through its
//! source), so retrieval can be limited to a notebook in SQL rather than by
//! asking the model to ignore what it was given.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

pub mod cards;
pub mod chat;
pub mod events;
pub mod memory;
pub mod notes;
pub mod search;
pub mod sources;
pub mod syllabus;
pub mod usage;

pub use chat::attachment_files;

pub struct StudyDb(pub Mutex<Option<Connection>>);

/// Each entry moves the schema one version forward; `PRAGMA user_version`
/// records how many have run.
const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE subject (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE notebook (
  id INTEGER PRIMARY KEY,
  subject_id INTEGER NOT NULL REFERENCES subject(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX notebook_subject ON notebook(subject_id);
CREATE TABLE source (
  id INTEGER PRIMARY KEY,
  notebook_id INTEGER NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  filename TEXT,
  hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  profile_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX source_notebook ON source(notebook_id);
CREATE TABLE unit (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  label TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX unit_source ON unit(source_id, ord);
CREATE TABLE section (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES section(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  unit_from INTEGER,
  unit_to INTEGER,
  meta_json TEXT
);
CREATE INDEX section_source ON section(source_id);
CREATE TABLE chunk (
  id INTEGER PRIMARY KEY,
  section_id INTEGER REFERENCES section(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  notebook_id INTEGER NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL,
  unit_from INTEGER,
  unit_to INTEGER,
  meta_json TEXT
);
CREATE INDEX chunk_notebook ON chunk(notebook_id);
CREATE INDEX chunk_source ON chunk(source_id, ord);
CREATE TABLE topic (
  id INTEGER PRIMARY KEY,
  notebook_id INTEGER NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES topic(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT ''
);
CREATE INDEX topic_notebook ON topic(notebook_id);
CREATE TABLE topic_chunk (
  topic_id INTEGER NOT NULL REFERENCES topic(id) ON DELETE CASCADE,
  chunk_id INTEGER NOT NULL REFERENCES chunk(id) ON DELETE CASCADE,
  PRIMARY KEY (topic_id, chunk_id)
);
CREATE TABLE conversation (
  id INTEGER PRIMARY KEY,
  notebook_id INTEGER NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE message (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  citations_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX message_conversation ON message(conversation_id);
CREATE TABLE flashcard (
  id INTEGER PRIMARY KEY,
  notebook_id INTEGER NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  source_refs_json TEXT,
  fsrs_json TEXT,
  due_at INTEGER
);
CREATE INDEX flashcard_notebook ON flashcard(notebook_id, due_at);
CREATE TABLE quiz (
  id INTEGER PRIMARY KEY,
  notebook_id INTEGER NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  questions_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX quiz_notebook ON quiz(notebook_id);
CREATE TABLE job (
  id INTEGER PRIMARY KEY,
  notebook_id INTEGER NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  source_id INTEGER REFERENCES source(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  error TEXT
);
"#,
// 2: standalone chats (notebook_id NULL), attachments, review and attempt logs.
// Nothing had been written to conversation/message yet, so they are rebuilt.
r#"
DROP TABLE message;
DROP TABLE conversation;
CREATE TABLE conversation (
  id INTEGER PRIMARY KEY,
  notebook_id INTEGER REFERENCES notebook(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX conversation_notebook ON conversation(notebook_id, updated_at);
CREATE TABLE message (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX message_conversation ON message(conversation_id, id);
CREATE TABLE attachment (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversation(id) ON DELETE CASCADE,
  notebook_id INTEGER REFERENCES notebook(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  text TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX attachment_conversation ON attachment(conversation_id);
ALTER TABLE flashcard ADD COLUMN topic TEXT NOT NULL DEFAULT '';
ALTER TABLE flashcard ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE card_review (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES flashcard(id) ON DELETE CASCADE,
  notebook_id INTEGER NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  correct INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  reviewed_at INTEGER NOT NULL
);
CREATE INDEX card_review_notebook ON card_review(notebook_id, reviewed_at);
CREATE INDEX card_review_card ON card_review(card_id, reviewed_at);
CREATE TABLE quiz_attempt (
  id INTEGER PRIMARY KEY,
  quiz_id INTEGER NOT NULL REFERENCES quiz(id) ON DELETE CASCADE,
  notebook_id INTEGER NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  score REAL NOT NULL,
  total INTEGER NOT NULL,
  answers_json TEXT NOT NULL
);
CREATE INDEX quiz_attempt_notebook ON quiz_attempt(notebook_id, finished_at);
"#,
// 3: flashcards come in decks you replay for a score (no due dates), and
// sources keep their file and are searchable.
r#"
CREATE TABLE deck (
  id INTEGER PRIMARY KEY,
  notebook_id INTEGER NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX deck_notebook ON deck(notebook_id);
ALTER TABLE flashcard ADD COLUMN deck_id INTEGER REFERENCES deck(id) ON DELETE CASCADE;
INSERT INTO deck (notebook_id, title, created_at, updated_at)
  SELECT DISTINCT notebook_id, 'Flashcards', 0, 0 FROM flashcard;
UPDATE flashcard SET deck_id = (SELECT d.id FROM deck d WHERE d.notebook_id = flashcard.notebook_id);
CREATE INDEX flashcard_deck ON flashcard(deck_id);
CREATE TABLE deck_run (
  id INTEGER PRIMARY KEY,
  deck_id INTEGER NOT NULL REFERENCES deck(id) ON DELETE CASCADE,
  notebook_id INTEGER NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  total INTEGER NOT NULL
);
CREATE INDEX deck_run_deck ON deck_run(deck_id, finished_at);
CREATE INDEX deck_run_notebook ON deck_run(notebook_id, finished_at);
ALTER TABLE source ADD COLUMN mime TEXT NOT NULL DEFAULT '';
ALTER TABLE source ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source ADD COLUMN data BLOB;
ALTER TABLE source ADD COLUMN url TEXT;
ALTER TABLE source ADD COLUMN error TEXT;
ALTER TABLE source ADD COLUMN unit_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source ADD COLUMN char_count INTEGER NOT NULL DEFAULT 0;
CREATE VIRTUAL TABLE chunk_fts USING fts5(text, content='chunk', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER chunk_ai AFTER INSERT ON chunk BEGIN
  INSERT INTO chunk_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER chunk_ad AFTER DELETE ON chunk BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
"#,
// 4: notes, written by the model from sources/topic/chat and edited by hand.
r#"
CREATE TABLE note (
  id INTEGER PRIMARY KEY,
  notebook_id INTEGER NOT NULL REFERENCES notebook(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX note_notebook ON note(notebook_id, updated_at);
"#,
// 5: AI usage log, subject icons, notebook overviews, the calendar, and the
// pictures found inside sources (slide images, figure pages).
r#"
CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  model TEXT NOT NULL,
  feature TEXT NOT NULL,
  prompt_hit INTEGER NOT NULL DEFAULT 0,
  prompt_miss INTEGER NOT NULL DEFAULT 0,
  completion INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0
);
CREATE INDEX ai_usage_at ON ai_usage(at);
ALTER TABLE subject ADD COLUMN icon TEXT NOT NULL DEFAULT '';
ALTER TABLE subject ADD COLUMN color TEXT NOT NULL DEFAULT '';
ALTER TABLE notebook ADD COLUMN overview TEXT NOT NULL DEFAULT '';
ALTER TABLE notebook ADD COLUMN overview_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE event (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'other',
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  all_day INTEGER NOT NULL DEFAULT 0,
  notebook_id INTEGER REFERENCES notebook(id) ON DELETE SET NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX event_start ON event(start_at);
CREATE TABLE source_image (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES source(id) ON DELETE CASCADE,
  unit_ord INTEGER NOT NULL,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  caption TEXT NOT NULL DEFAULT ''
);
CREATE INDEX source_image_source ON source_image(source_id, unit_ord);
"#,
// 6: a syllabus per subject (file kept as an attachment, its text and summary).
r#"
ALTER TABLE subject ADD COLUMN syllabus_file INTEGER REFERENCES attachment(id) ON DELETE SET NULL;
ALTER TABLE subject ADD COLUMN syllabus_name TEXT NOT NULL DEFAULT '';
ALTER TABLE subject ADD COLUMN syllabus_text TEXT NOT NULL DEFAULT '';
ALTER TABLE subject ADD COLUMN syllabus_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE subject ADD COLUMN syllabus_at INTEGER NOT NULL DEFAULT 0;
"#,
// 7: every event belongs to a course (subject) or to none. Existing events get
// the course of their notebook, or of the "Course: " prefix syllabus imports
// put in their titles (the prefix is dropped: the course now shows by colour).
r#"
ALTER TABLE event ADD COLUMN subject_id INTEGER REFERENCES subject(id) ON DELETE SET NULL;
CREATE INDEX event_subject ON event(subject_id);
UPDATE event SET subject_id = (SELECT n.subject_id FROM notebook n WHERE n.id = event.notebook_id)
  WHERE notebook_id IS NOT NULL;
UPDATE event SET subject_id = (
    SELECT s.id FROM subject s WHERE substr(event.title, 1, length(s.name) + 1) = s.name || ':'
    ORDER BY length(s.name) DESC LIMIT 1)
  WHERE subject_id IS NULL;
UPDATE event SET title = trim(substr(title, (SELECT length(s.name) FROM subject s WHERE s.id = event.subject_id) + 2))
  WHERE subject_id IS NOT NULL
    AND substr(title, 1, (SELECT length(s.name) FROM subject s WHERE s.id = event.subject_id) + 1)
        = (SELECT s.name FROM subject s WHERE s.id = event.subject_id) || ':'
    AND length(trim(substr(title, (SELECT length(s.name) FROM subject s WHERE s.id = event.subject_id) + 2))) > 0;
"#,
// 8: facts the AI remembers about the student (Settings → Memory).
r#"
CREATE TABLE memory (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'chat',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
"#];

/// How many migrations this build knows; files from a newer build are refused.
pub(crate) fn schema_version() -> usize {
    MIGRATIONS.len()
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn open(path: &std::path::Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    prepare(&conn)?;
    Ok(conn)
}

pub(crate) fn prepare(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
    let version: usize = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version) {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", i + 1)?;
        tx.commit()?;
    }
    Ok(())
}

/// Opens the database on first use, so a broken data dir only fails Study.
pub(crate) fn with_db<T>(app: &AppHandle, db: &StudyDb, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<T, String> {
    let mut guard = db.0.lock().map_err(|_| "study database lock poisoned".to_string())?;
    if guard.is_none() {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create data dir: {e}"))?;
        *guard = Some(open(&dir.join("study.db")).map_err(|e| format!("cannot open study.db: {e}"))?);
    }
    f(guard.as_ref().unwrap()).map_err(|e| e.to_string())
}

pub(crate) fn clean_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("Name cannot be empty.".into());
    }
    Ok(n.chars().take(120).collect())
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotebookSummary {
    pub id: i64,
    pub subject_id: i64,
    pub name: String,
    pub description: String,
    pub source_count: i64,
    pub card_count: i64,
    pub quiz_count: i64,
    pub deck_count: i64,
    pub note_count: i64,
    /// AI-written list of what the notebook covers ("" until generated).
    pub overview: String,
    pub overview_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubjectNode {
    pub id: i64,
    pub name: String,
    pub context: String,
    /// Lucide icon name and accent colour chosen for the subject ("" = default).
    pub icon: String,
    pub color: String,
    /// The syllabus file's name ("" = none) and the AI summary of it.
    pub syllabus_name: String,
    pub syllabus_summary: String,
    pub syllabus_at: i64,
    pub notebooks: Vec<NotebookSummary>,
}

pub fn tree(conn: &Connection) -> rusqlite::Result<Vec<SubjectNode>> {
    let mut subjects: Vec<SubjectNode> = conn
        .prepare("SELECT id, name, context, icon, color, syllabus_name, syllabus_summary, syllabus_at FROM subject ORDER BY position, id")?
        .query_map([], |r| {
            Ok(SubjectNode {
                id: r.get(0)?,
                name: r.get(1)?,
                context: r.get(2)?,
                icon: r.get(3)?,
                color: r.get(4)?,
                syllabus_name: r.get(5)?,
                syllabus_summary: r.get(6)?,
                syllabus_at: r.get(7)?,
                notebooks: vec![],
            })
        })?
        .collect::<Result<_, _>>()?;
    let mut stmt = conn.prepare(
        "SELECT n.id, n.subject_id, n.name, n.description, n.updated_at,
                (SELECT COUNT(*) FROM source s WHERE s.notebook_id = n.id),
                (SELECT COUNT(*) FROM flashcard f WHERE f.notebook_id = n.id),
                (SELECT COUNT(*) FROM quiz q WHERE q.notebook_id = n.id),
                (SELECT COUNT(*) FROM deck d WHERE d.notebook_id = n.id),
                (SELECT COUNT(*) FROM note x WHERE x.notebook_id = n.id),
                n.overview, n.overview_at
         FROM notebook n ORDER BY n.position, n.id",
    )?;
    let notebooks = stmt.query_map([], |r| {
        Ok(NotebookSummary {
            id: r.get(0)?,
            subject_id: r.get(1)?,
            name: r.get(2)?,
            description: r.get(3)?,
            updated_at: r.get(4)?,
            source_count: r.get(5)?,
            card_count: r.get(6)?,
            quiz_count: r.get(7)?,
            deck_count: r.get(8)?,
            note_count: r.get(9)?,
            overview: r.get(10)?,
            overview_at: r.get(11)?,
        })
    })?;
    for nb in notebooks {
        let nb = nb?;
        if let Some(s) = subjects.iter_mut().find(|s| s.id == nb.subject_id) {
            s.notebooks.push(nb);
        }
    }
    Ok(subjects)
}

fn next_position(conn: &Connection, sql: &str, arg: Option<i64>) -> rusqlite::Result<i64> {
    match arg {
        Some(a) => conn.query_row(sql, [a], |r| r.get(0)),
        None => conn.query_row(sql, [], |r| r.get(0)),
    }
}

pub(crate) fn create_subject(conn: &Connection, name: &str) -> rusqlite::Result<i64> {
    let pos = next_position(conn, "SELECT COALESCE(MAX(position) + 1, 0) FROM subject", None)?;
    conn.execute("INSERT INTO subject (name, position, created_at) VALUES (?1, ?2, ?3)", params![name, pos, now_ms()])?;
    Ok(conn.last_insert_rowid())
}

pub fn create_notebook(conn: &Connection, subject_id: i64, name: &str, description: &str) -> rusqlite::Result<i64> {
    let pos = next_position(conn, "SELECT COALESCE(MAX(position) + 1, 0) FROM notebook WHERE subject_id = ?1", Some(subject_id))?;
    let t = now_ms();
    conn.execute(
        "INSERT INTO notebook (subject_id, name, description, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![subject_id, name, description, pos, t],
    )?;
    Ok(conn.last_insert_rowid())
}

pub(crate) fn expect_one(changed: usize, what: &str) -> Result<(), String> {
    if changed == 0 { Err(format!("{what} not found.")) } else { Ok(()) }
}

#[tauri::command]
pub fn study_tree(app: AppHandle, db: State<'_, StudyDb>) -> Result<Vec<SubjectNode>, String> {
    with_db(&app, &db, tree)
}

#[tauri::command]
pub fn study_create_subject(app: AppHandle, db: State<'_, StudyDb>, name: String) -> Result<i64, String> {
    let name = clean_name(&name)?;
    with_db(&app, &db, |c| create_subject(c, &name))
}

#[tauri::command]
pub fn study_update_subject(
    app: AppHandle,
    db: State<'_, StudyDb>,
    id: i64,
    name: Option<String>,
    context: Option<String>,
    icon: Option<String>,
    color: Option<String>,
) -> Result<(), String> {
    let name = name.map(|n| clean_name(&n)).transpose()?;
    let changed = with_db(&app, &db, |c| {
        c.execute(
            "UPDATE subject SET name = COALESCE(?2, name), context = COALESCE(?3, context),
                               icon = COALESCE(?4, icon), color = COALESCE(?5, color) WHERE id = ?1",
            params![id, name, context, icon, color],
        )
    })?;
    expect_one(changed, "Subject")
}

#[tauri::command]
pub fn study_delete_subject(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<(), String> {
    let changed = with_db(&app, &db, |c| {
        syllabus::delete_file_of(c, id)?;
        c.execute("DELETE FROM subject WHERE id = ?1", [id])
    })?;
    expect_one(changed, "Subject")
}

#[tauri::command]
pub fn study_create_notebook(
    app: AppHandle,
    db: State<'_, StudyDb>,
    subject_id: i64,
    name: String,
    description: Option<String>,
) -> Result<i64, String> {
    let name = clean_name(&name)?;
    let description = description.unwrap_or_default().trim().to_string();
    with_db(&app, &db, |c| {
        let exists: Option<i64> = c.query_row("SELECT id FROM subject WHERE id = ?1", [subject_id], |r| r.get(0)).optional()?;
        exists.map(|_| create_notebook(c, subject_id, &name, &description)).transpose()
    })?
    .ok_or_else(|| "Subject not found.".into())
}

#[tauri::command]
pub fn study_update_notebook(
    app: AppHandle,
    db: State<'_, StudyDb>,
    id: i64,
    name: Option<String>,
    description: Option<String>,
) -> Result<(), String> {
    let name = name.map(|n| clean_name(&n)).transpose()?;
    let description = description.map(|d| d.trim().to_string());
    let changed = with_db(&app, &db, |c| {
        c.execute(
            "UPDATE notebook SET name = COALESCE(?2, name), description = COALESCE(?3, description), updated_at = ?4 WHERE id = ?1",
            params![id, name, description, now_ms()],
        )
    })?;
    expect_one(changed, "Notebook")
}

#[tauri::command]
pub fn study_delete_notebook(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<(), String> {
    let changed = with_db(&app, &db, |c| c.execute("DELETE FROM notebook WHERE id = ?1", [id]))?;
    expect_one(changed, "Notebook")
}

#[tauri::command]
pub fn notebook_set_overview(app: AppHandle, db: State<'_, StudyDb>, id: i64, overview: String) -> Result<(), String> {
    let changed = with_db(&app, &db, |c| {
        c.execute("UPDATE notebook SET overview = ?2, overview_at = ?3 WHERE id = ?1", params![id, overview, now_ms()])
    })?;
    expect_one(changed, "Notebook")
}

/// Per-day counts of study activity (card answers, quiz attempts, deck plays,
/// questions asked, notes written) since `since`, for the activity chart.
#[tauri::command]
pub fn activity(app: AppHandle, db: State<'_, StudyDb>, since: i64) -> Result<Vec<i64>, String> {
    with_db(&app, &db, |c| {
        // Timestamps only: the UI buckets them into local days.
        let mut stmt = c.prepare(
            "SELECT reviewed_at FROM card_review WHERE reviewed_at >= ?1
             UNION ALL SELECT finished_at FROM quiz_attempt WHERE finished_at >= ?1
             UNION ALL SELECT m.created_at FROM message m WHERE m.role = 'user' AND m.created_at >= ?1
             UNION ALL SELECT created_at FROM note WHERE created_at >= ?1
             UNION ALL SELECT created_at FROM source WHERE created_at >= ?1",
        )?;
        let times = stmt.query_map([since], |r| r.get(0))?.collect::<Result<_, _>>()?;
        Ok(times)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        prepare(&c).unwrap();
        c
    }

    #[test]
    fn migrations_are_idempotent() {
        let c = mem();
        prepare(&c).unwrap();
        let v: usize = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, MIGRATIONS.len());
    }

    #[test]
    fn tree_groups_notebooks_under_subjects_in_order() {
        let c = mem();
        let calc = create_subject(&c, "Calculus II").unwrap();
        let phys = create_subject(&c, "Physics I").unwrap();
        create_notebook(&c, calc, "Midterm Review", "").unwrap();
        create_notebook(&c, phys, "Kinematics", "").unwrap();
        create_notebook(&c, calc, "Series", "").unwrap();
        let t = tree(&c).unwrap();
        assert_eq!(t.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Calculus II", "Physics I"]);
        assert_eq!(t[0].notebooks.iter().map(|n| n.name.as_str()).collect::<Vec<_>>(), ["Midterm Review", "Series"]);
        assert_eq!(t[1].notebooks.len(), 1);
        assert_eq!(t[0].notebooks[0].source_count, 0);
    }

    #[test]
    fn deleting_a_subject_removes_its_notebooks_and_their_contents() {
        let c = mem();
        let calc = create_subject(&c, "Calculus II").unwrap();
        let other = create_subject(&c, "Linear Algebra").unwrap();
        let nb = create_notebook(&c, calc, "Midterm Review", "").unwrap();
        let keep = create_notebook(&c, other, "Vectors", "").unwrap();
        c.execute("INSERT INTO source (notebook_id, kind, title, created_at) VALUES (?1, 'pdf', 'Lecture 1', 0)", [nb]).unwrap();
        c.execute("INSERT INTO source (notebook_id, kind, title, created_at) VALUES (?1, 'pdf', 'Lecture A', 0)", [keep]).unwrap();
        c.execute("DELETE FROM subject WHERE id = ?1", [calc]).unwrap();
        let sources: i64 = c.query_row("SELECT COUNT(*) FROM source", [], |r| r.get(0)).unwrap();
        let notebooks: i64 = c.query_row("SELECT COUNT(*) FROM notebook", [], |r| r.get(0)).unwrap();
        assert_eq!((sources, notebooks), (1, 1));
        assert_eq!(tree(&c).unwrap()[0].notebooks[0].source_count, 1);
    }

    #[test]
    fn names_are_trimmed_and_required() {
        assert_eq!(clean_name("  Series ").unwrap(), "Series");
        assert!(clean_name("   ").is_err());
    }
}
