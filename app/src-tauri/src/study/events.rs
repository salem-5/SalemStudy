use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use super::{expect_one, now_ms, with_db, StudyDb};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: i64,
    pub title: String,
    pub notes: String,
    pub kind: String,
    pub start_at: i64,
    pub end_at: Option<i64>,
    pub all_day: bool,
    pub notebook_id: Option<i64>,
    pub subject_id: Option<i64>,
    pub done: bool,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct EventIn {
    pub title: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default = "other")]
    pub kind: String,
    pub start_at: i64,
    #[serde(default)]
    pub end_at: Option<i64>,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub notebook_id: Option<i64>,
    #[serde(default)]
    pub subject_id: Option<i64>,
    #[serde(default)]
    pub done: bool,
}

fn other() -> String {
    "other".into()
}

const COLS: &str = "id, title, notes, kind, start_at, end_at, all_day, notebook_id, done, subject_id";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Event> {
    Ok(Event {
        id: r.get(0)?,
        title: r.get(1)?,
        notes: r.get(2)?,
        kind: r.get(3)?,
        start_at: r.get(4)?,
        end_at: r.get(5)?,
        all_day: r.get::<_, i64>(6)? != 0,
        notebook_id: r.get(7)?,
        done: r.get::<_, i64>(8)? != 0,
        subject_id: r.get(9)?,
    })
}

pub fn between(conn: &Connection, from: i64, to: i64) -> rusqlite::Result<Vec<Event>> {
    conn.prepare(&format!(
        "SELECT {COLS} FROM event WHERE start_at < ?2 AND COALESCE(end_at, start_at) >= ?1 ORDER BY all_day DESC, start_at, id"
    ))?
    .query_map(params![from, to], row)?
    .collect()
}

fn validate(e: &EventIn) -> Result<(), String> {
    if e.title.trim().is_empty() {
        return Err("An event needs a title.".into());
    }
    if e.end_at.is_some_and(|end| end < e.start_at) {
        return Err("An event cannot end before it starts.".into());
    }
    Ok(())
}

const SUBJECT: &str = "COALESCE((SELECT n.subject_id FROM notebook n WHERE n.id = ?7), ?10)";

pub fn add(conn: &Connection, e: &EventIn) -> rusqlite::Result<Event> {
    conn.execute(
        &format!("INSERT INTO event (title, notes, kind, start_at, end_at, all_day, notebook_id, done, created_at, subject_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, {SUBJECT})"),
        params![e.title.trim(), e.notes, e.kind, e.start_at, e.end_at, e.all_day as i64, e.notebook_id, e.done as i64, now_ms(), e.subject_id],
    )?;
    Ok(conn.query_row(&format!("SELECT {COLS} FROM event WHERE id = ?1"), [conn.last_insert_rowid()], row)?)
}

pub fn update(conn: &Connection, id: i64, e: &EventIn) -> rusqlite::Result<usize> {
    conn.execute(
        &format!("UPDATE event SET title = ?2, notes = ?3, kind = ?4, start_at = ?5, end_at = ?6, all_day = ?8, notebook_id = ?7, done = ?9, subject_id = {SUBJECT} WHERE id = ?1"),
        params![id, e.title.trim(), e.notes, e.kind, e.start_at, e.end_at, e.notebook_id, e.all_day as i64, e.done as i64, e.subject_id],
    )
}

pub fn delete_for_subject(conn: &Connection, subject_id: i64) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM event
          WHERE subject_id = ?1
             OR notebook_id IN (SELECT id FROM notebook WHERE subject_id = ?1)",
        [subject_id],
    )
}

#[tauri::command]
pub fn events_between(app: AppHandle, db: State<'_, StudyDb>, from: i64, to: i64) -> Result<Vec<Event>, String> {
    with_db(&app, &db, |c| between(c, from, to))
}

#[tauri::command]
pub fn event_add(app: AppHandle, db: State<'_, StudyDb>, event: EventIn) -> Result<Event, String> {
    validate(&event)?;
    with_db(&app, &db, |c| add(c, &event))
}

#[tauri::command]
pub fn event_update(app: AppHandle, db: State<'_, StudyDb>, id: i64, event: EventIn) -> Result<Event, String> {
    validate(&event)?;
    let changed = with_db(&app, &db, |c| update(c, id, &event))?;
    expect_one(changed, "Event")?;
    with_db(&app, &db, |c| c.query_row(&format!("SELECT {COLS} FROM event WHERE id = ?1"), [id], row).optional())?
        .ok_or_else(|| "Event not found.".into())
}

#[tauri::command]
pub fn event_delete(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<(), String> {
    let changed = with_db(&app, &db, |c| c.execute("DELETE FROM event WHERE id = ?1", [id]))?;
    expect_one(changed, "Event")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(title: &str, start: i64, end: Option<i64>) -> EventIn {
        EventIn { title: title.into(), notes: String::new(), kind: "exam".into(), start_at: start, end_at: end, all_day: false, notebook_id: None, subject_id: None, done: false }
    }

    #[test]
    fn range_query_includes_overlapping_events_only() {
        let c = Connection::open_in_memory().unwrap();
        super::super::prepare(&c).unwrap();
        add(&c, &ev("before", 0, Some(50))).unwrap();
        add(&c, &ev("spans in", 50, Some(150))).unwrap();
        add(&c, &ev("inside", 120, None)).unwrap();
        add(&c, &ev("after", 200, None)).unwrap();
        let got: Vec<String> = between(&c, 100, 200).unwrap().into_iter().map(|e| e.title).collect();
        assert_eq!(got, ["spans in", "inside"]);
        assert!(validate(&ev(" ", 0, None)).is_err());
        assert!(validate(&ev("x", 10, Some(5))).is_err());
    }

    #[test]
    fn deleting_a_course_takes_its_calendar_with_it() {
        let c = Connection::open_in_memory().unwrap();
        super::super::prepare(&c).unwrap();
        let calc = super::super::create_subject(&c, "Calc").unwrap();
        let phys = super::super::create_subject(&c, "Physics").unwrap();
        let series = super::super::create_notebook(&c, calc, "Series", "").unwrap();

        add(&c, &EventIn { subject_id: Some(calc), ..ev("Calc final", 10, None) }).unwrap();
        add(&c, &EventIn { notebook_id: Some(series), ..ev("Series quiz", 20, None) }).unwrap();
        add(&c, &EventIn { subject_id: Some(phys), ..ev("Physics lab", 30, None) }).unwrap();
        add(&c, &ev("Dentist", 40, None)).unwrap();

        assert_eq!(delete_for_subject(&c, calc).unwrap(), 2);
        c.execute("DELETE FROM subject WHERE id = ?1", [calc]).unwrap();

        let left: Vec<String> = between(&c, 0, 100).unwrap().into_iter().map(|e| e.title).collect();
        assert_eq!(left, ["Physics lab", "Dentist"]);
    }

    #[test]
    fn another_course_and_the_student_s_own_entries_are_left_alone() {
        let c = Connection::open_in_memory().unwrap();
        super::super::prepare(&c).unwrap();
        let calc = super::super::create_subject(&c, "Calc").unwrap();
        let phys = super::super::create_subject(&c, "Physics").unwrap();
        super::super::create_notebook(&c, phys, "Waves", "").unwrap();
        add(&c, &EventIn { subject_id: Some(phys), ..ev("Physics lab", 30, None) }).unwrap();
        add(&c, &ev("Dentist", 40, None)).unwrap();

        assert_eq!(delete_for_subject(&c, calc).unwrap(), 0);
        assert_eq!(between(&c, 0, 100).unwrap().len(), 2);
    }

    #[test]
    fn deleting_a_notebook_keeps_its_events() {
        let c = Connection::open_in_memory().unwrap();
        super::super::prepare(&c).unwrap();
        let s = super::super::create_subject(&c, "Calc").unwrap();
        let nb = super::super::create_notebook(&c, s, "Series", "").unwrap();
        add(&c, &EventIn { notebook_id: Some(nb), ..ev("Midterm", 10, None) }).unwrap();
        c.execute("DELETE FROM notebook WHERE id = ?1", [nb]).unwrap();
        let e = &between(&c, 0, 100).unwrap()[0];
        assert_eq!((e.title.as_str(), e.notebook_id), ("Midterm", None));
    }

    #[test]
    fn a_notebook_event_takes_the_notebook_course() {
        let c = Connection::open_in_memory().unwrap();
        super::super::prepare(&c).unwrap();
        let calc = super::super::create_subject(&c, "Calc").unwrap();
        let phys = super::super::create_subject(&c, "Physics").unwrap();
        let nb = super::super::create_notebook(&c, calc, "Series", "").unwrap();
        let e = add(&c, &EventIn { notebook_id: Some(nb), subject_id: Some(phys), ..ev("Quiz", 10, None) }).unwrap();
        assert_eq!(e.subject_id, Some(calc));
        let free = add(&c, &EventIn { subject_id: Some(phys), ..ev("Lab", 10, None) }).unwrap();
        assert_eq!(free.subject_id, Some(phys));
        update(&c, free.id, &ev("Lab", 10, None)).unwrap();
        assert_eq!(between(&c, 0, 100).unwrap().iter().find(|x| x.id == free.id).unwrap().subject_id, None);
        c.execute("DELETE FROM subject WHERE id = ?1", [phys]).unwrap();
        assert!(between(&c, 0, 100).unwrap().iter().all(|x| x.subject_id != Some(phys)));
    }

    #[test]
    fn migration_links_existing_events_to_their_course() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        let all = super::super::MIGRATIONS;
        for sql in &all[..6] { c.execute_batch(sql).unwrap(); }
        c.execute_batch(
            "INSERT INTO subject (id, name, position, created_at) VALUES (1, 'Calculus 2', 0, 0), (2, 'Calculus', 1, 0), (3, 'Physics', 2, 0);
             INSERT INTO notebook (id, subject_id, name, description, position, created_at, updated_at) VALUES (7, 3, 'Waves', '', 0, 0, 0);
             INSERT INTO event (id, title, start_at, created_at) VALUES (1, 'Calculus 2: Exam 1', 0, 0);
             INSERT INTO event (id, title, start_at, created_at) VALUES (2, 'Calculus: Quiz', 0, 0);
             INSERT INTO event (id, title, start_at, created_at, notebook_id) VALUES (3, 'Lab report', 0, 0, 7);
             INSERT INTO event (id, title, start_at, created_at) VALUES (4, 'Dentist', 0, 0);
             INSERT INTO event (id, title, start_at, created_at) VALUES (5, 'Calculus 2:', 0, 0);",
        )
        .unwrap();
        c.execute_batch(all[6]).unwrap();
        let got: Vec<(String, Option<i64>)> = c
            .prepare("SELECT title, subject_id FROM event ORDER BY id").unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
            .collect::<Result<_, _>>().unwrap();
        assert_eq!(got, vec![
            ("Exam 1".into(), Some(1)),
            ("Quiz".into(), Some(2)),
            ("Lab report".into(), Some(3)),
            ("Dentist".into(), None),
            ("Calculus 2:".into(), Some(1)),
        ]);
    }
}
