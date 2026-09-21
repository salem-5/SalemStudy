//! Flashcard decks (replayed for a score, no scheduling), quizzes, and the
//! run / review / attempt logs that analytics read.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use super::{expect_one, now_ms, with_db, StudyDb};

fn parse(json: Option<String>) -> Value {
    json.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
}

fn opt_json(v: &Value) -> Option<String> {
    if v.is_null() { None } else { Some(v.to_string()) }
}

// ---------------------------------------------------------------- flashcards

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Deck {
    pub id: i64,
    pub notebook_id: i64,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub card_count: i64,
    pub runs: i64,
    /// Share right, 0..1, of the best and the latest finished run.
    pub best: Option<f64>,
    pub last: Option<f64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: i64,
    pub deck_id: i64,
    pub notebook_id: i64,
    pub front: String,
    pub back: String,
    pub topic: String,
    pub source_refs: Value,
    pub created_at: i64,
    pub reviews: i64,
    pub misses: i64,
    pub last_correct: Option<bool>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NewCard {
    pub front: String,
    pub back: String,
    #[serde(default)]
    pub topic: String,
    #[serde(default)]
    pub source_refs: Value,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CardResult {
    pub card_id: i64,
    pub correct: bool,
    #[serde(default)]
    pub elapsed_ms: i64,
}

pub fn list_decks(conn: &Connection, notebook_id: i64) -> rusqlite::Result<Vec<Deck>> {
    conn.prepare(
        "SELECT d.id, d.notebook_id, d.title, d.created_at, d.updated_at,
                (SELECT COUNT(*) FROM flashcard f WHERE f.deck_id = d.id),
                (SELECT COUNT(*) FROM deck_run r WHERE r.deck_id = d.id),
                (SELECT MAX(r.correct * 1.0 / r.total) FROM deck_run r WHERE r.deck_id = d.id AND r.total > 0),
                (SELECT r.correct * 1.0 / r.total FROM deck_run r WHERE r.deck_id = d.id AND r.total > 0 ORDER BY r.finished_at DESC, r.id DESC LIMIT 1)
         FROM deck d WHERE d.notebook_id = ?1 ORDER BY d.updated_at DESC, d.id DESC",
    )?
    .query_map([notebook_id], |r| {
        Ok(Deck {
            id: r.get(0)?,
            notebook_id: r.get(1)?,
            title: r.get(2)?,
            created_at: r.get(3)?,
            updated_at: r.get(4)?,
            card_count: r.get(5)?,
            runs: r.get(6)?,
            best: r.get(7)?,
            last: r.get(8)?,
        })
    })?
    .collect()
}

pub fn create_deck(conn: &Connection, notebook_id: i64, title: &str, cards: &[NewCard]) -> rusqlite::Result<i64> {
    let tx = conn.unchecked_transaction()?;
    let t = now_ms();
    tx.execute(
        "INSERT INTO deck (notebook_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params![notebook_id, title, t],
    )?;
    let deck = tx.last_insert_rowid();
    insert_cards(&tx, notebook_id, deck, cards)?;
    tx.commit()?;
    Ok(deck)
}

fn insert_cards(conn: &Connection, notebook_id: i64, deck_id: i64, cards: &[NewCard]) -> rusqlite::Result<Vec<i64>> {
    let t = now_ms();
    let mut stmt = conn.prepare(
        "INSERT INTO flashcard (notebook_id, deck_id, front, back, topic, source_refs_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    let mut ids = Vec::with_capacity(cards.len());
    for c in cards {
        stmt.execute(params![notebook_id, deck_id, c.front.trim(), c.back.trim(), c.topic.trim(), opt_json(&c.source_refs), t])?;
        ids.push(conn.last_insert_rowid());
    }
    Ok(ids)
}

pub fn list_cards(conn: &Connection, deck_id: i64) -> rusqlite::Result<Vec<Card>> {
    conn.prepare(
        "SELECT f.id, f.deck_id, f.notebook_id, f.front, f.back, f.topic, f.source_refs_json, f.created_at,
                (SELECT COUNT(*) FROM card_review r WHERE r.card_id = f.id),
                (SELECT COUNT(*) FROM card_review r WHERE r.card_id = f.id AND r.correct = 0),
                (SELECT r.correct FROM card_review r WHERE r.card_id = f.id ORDER BY r.reviewed_at DESC, r.id DESC LIMIT 1)
         FROM flashcard f WHERE f.deck_id = ?1 ORDER BY f.id",
    )?
    .query_map([deck_id], |r| {
        Ok(Card {
            id: r.get(0)?,
            deck_id: r.get(1)?,
            notebook_id: r.get(2)?,
            front: r.get(3)?,
            back: r.get(4)?,
            topic: r.get(5)?,
            source_refs: parse(r.get(6)?),
            created_at: r.get(7)?,
            reviews: r.get(8)?,
            misses: r.get(9)?,
            last_correct: r.get::<_, Option<i64>>(10)?.map(|v| v != 0),
        })
    })?
    .collect()
}

/// A finished play-through: one row for the score, one review per card.
pub fn record_run(conn: &Connection, deck_id: i64, started_at: i64, results: &[CardResult]) -> rusqlite::Result<Option<i64>> {
    let notebook: Option<i64> = conn.query_row("SELECT notebook_id FROM deck WHERE id = ?1", [deck_id], |r| r.get(0)).optional()?;
    let Some(notebook_id) = notebook else { return Ok(None) };
    let tx = conn.unchecked_transaction()?;
    let t = now_ms();
    let correct = results.iter().filter(|r| r.correct).count() as i64;
    tx.execute(
        "INSERT INTO deck_run (deck_id, notebook_id, started_at, finished_at, correct, total) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![deck_id, notebook_id, started_at, t, correct, results.len() as i64],
    )?;
    let run = tx.last_insert_rowid();
    {
        let mut stmt = tx.prepare(
            "INSERT INTO card_review (card_id, notebook_id, correct, elapsed_ms, reviewed_at)
             SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM flashcard WHERE id = ?1 AND deck_id = ?6)",
        )?;
        for r in results {
            stmt.execute(params![r.card_id, notebook_id, r.correct as i64, r.elapsed_ms.max(0), t, deck_id])?;
        }
    }
    tx.execute("UPDATE deck SET updated_at = ?2 WHERE id = ?1", params![deck_id, t])?;
    tx.commit()?;
    Ok(Some(run))
}

#[tauri::command]
pub fn decks_list(app: AppHandle, db: State<'_, StudyDb>, notebook_id: i64) -> Result<Vec<Deck>, String> {
    with_db(&app, &db, |c| list_decks(c, notebook_id))
}

#[tauri::command]
pub fn deck_create(app: AppHandle, db: State<'_, StudyDb>, notebook_id: i64, title: String, cards: Vec<NewCard>) -> Result<i64, String> {
    if cards.iter().any(|c| c.front.trim().is_empty() || c.back.trim().is_empty()) {
        return Err("A card needs both a front and a back.".into());
    }
    let title: String = title.trim().chars().take(200).collect();
    let title = if title.is_empty() { "Untitled deck".to_string() } else { title };
    with_db(&app, &db, |c| create_deck(c, notebook_id, &title, &cards))
}

#[tauri::command]
pub fn deck_rename(app: AppHandle, db: State<'_, StudyDb>, id: i64, title: String) -> Result<(), String> {
    let title = super::clean_name(&title)?;
    let changed = with_db(&app, &db, |c| c.execute("UPDATE deck SET title = ?2 WHERE id = ?1", params![id, title]))?;
    expect_one(changed, "Deck")
}

#[tauri::command]
pub fn deck_delete(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<(), String> {
    let changed = with_db(&app, &db, |c| c.execute("DELETE FROM deck WHERE id = ?1", [id]))?;
    expect_one(changed, "Deck")
}

#[tauri::command]
pub fn deck_cards(app: AppHandle, db: State<'_, StudyDb>, deck_id: i64) -> Result<Vec<Card>, String> {
    with_db(&app, &db, |c| list_cards(c, deck_id))
}

#[tauri::command]
pub fn cards_add(app: AppHandle, db: State<'_, StudyDb>, deck_id: i64, cards: Vec<NewCard>) -> Result<Vec<i64>, String> {
    if cards.iter().any(|c| c.front.trim().is_empty() || c.back.trim().is_empty()) {
        return Err("A card needs both a front and a back.".into());
    }
    let ids = with_db(&app, &db, |c| {
        let notebook: Option<i64> = c.query_row("SELECT notebook_id FROM deck WHERE id = ?1", [deck_id], |r| r.get(0)).optional()?;
        let Some(notebook_id) = notebook else { return Ok(None) };
        let ids = insert_cards(c, notebook_id, deck_id, &cards)?;
        c.execute("UPDATE deck SET updated_at = ?2 WHERE id = ?1", params![deck_id, now_ms()])?;
        Ok(Some(ids))
    })?;
    ids.ok_or_else(|| "Deck not found.".into())
}

#[tauri::command]
pub fn card_update(app: AppHandle, db: State<'_, StudyDb>, id: i64, front: String, back: String, topic: String) -> Result<(), String> {
    if front.trim().is_empty() || back.trim().is_empty() {
        return Err("A card needs both a front and a back.".into());
    }
    let changed = with_db(&app, &db, |c| {
        c.execute(
            "UPDATE flashcard SET front = ?2, back = ?3, topic = ?4 WHERE id = ?1",
            params![id, front.trim(), back.trim(), topic.trim()],
        )
    })?;
    expect_one(changed, "Card")
}

#[tauri::command]
pub fn card_delete(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<(), String> {
    let changed = with_db(&app, &db, |c| c.execute("DELETE FROM flashcard WHERE id = ?1", [id]))?;
    expect_one(changed, "Card")
}

#[tauri::command]
pub fn deck_run_add(app: AppHandle, db: State<'_, StudyDb>, deck_id: i64, started_at: i64, results: Vec<CardResult>) -> Result<i64, String> {
    if results.is_empty() {
        return Err("Nothing was answered.".into());
    }
    with_db(&app, &db, |c| record_run(c, deck_id, started_at, &results))?.ok_or_else(|| "Deck not found.".into())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub card_id: i64,
    pub correct: bool,
    pub elapsed_ms: i64,
    pub reviewed_at: i64,
    pub topic: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeckRun {
    pub id: i64,
    pub deck_id: i64,
    pub deck_title: String,
    pub started_at: i64,
    pub finished_at: i64,
    pub correct: i64,
    pub total: i64,
}

#[tauri::command]
pub fn reviews_list(app: AppHandle, db: State<'_, StudyDb>, notebook_id: i64, since: i64) -> Result<Vec<Review>, String> {
    with_db(&app, &db, |c| {
        c.prepare(
            "SELECT r.card_id, r.correct, r.elapsed_ms, r.reviewed_at, COALESCE(f.topic, '')
             FROM card_review r LEFT JOIN flashcard f ON f.id = r.card_id
             WHERE r.notebook_id = ?1 AND r.reviewed_at >= ?2 ORDER BY r.reviewed_at",
        )?
        .query_map(params![notebook_id, since], |r| {
            Ok(Review { card_id: r.get(0)?, correct: r.get::<_, i64>(1)? != 0, elapsed_ms: r.get(2)?, reviewed_at: r.get(3)?, topic: r.get(4)? })
        })?
        .collect()
    })
}

#[tauri::command]
pub fn deck_runs_list(app: AppHandle, db: State<'_, StudyDb>, notebook_id: i64, since: i64) -> Result<Vec<DeckRun>, String> {
    with_db(&app, &db, |c| {
        c.prepare(
            "SELECT r.id, r.deck_id, d.title, r.started_at, r.finished_at, r.correct, r.total
             FROM deck_run r JOIN deck d ON d.id = r.deck_id
             WHERE r.notebook_id = ?1 AND r.finished_at >= ?2 ORDER BY r.finished_at",
        )?
        .query_map(params![notebook_id, since], |r| {
            Ok(DeckRun {
                id: r.get(0)?, deck_id: r.get(1)?, deck_title: r.get(2)?, started_at: r.get(3)?,
                finished_at: r.get(4)?, correct: r.get(5)?, total: r.get(6)?,
            })
        })?
        .collect()
    })
}

// ------------------------------------------------------------------- quizzes

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QuizSummary {
    pub id: i64,
    pub notebook_id: i64,
    pub title: String,
    pub created_at: i64,
    pub question_count: i64,
    pub attempts: i64,
    pub best: Option<f64>,
    pub last: Option<f64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Quiz {
    pub id: i64,
    pub notebook_id: i64,
    pub title: String,
    pub questions: Value,
    pub created_at: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub id: i64,
    pub quiz_id: i64,
    pub quiz_title: String,
    pub started_at: i64,
    pub finished_at: i64,
    pub score: f64,
    pub total: i64,
    pub answers: Value,
}

pub fn list_quizzes(conn: &Connection, notebook_id: i64) -> rusqlite::Result<Vec<QuizSummary>> {
    conn.prepare(
        "SELECT q.id, q.notebook_id, q.title, q.created_at, json_array_length(q.questions_json),
                (SELECT COUNT(*) FROM quiz_attempt a WHERE a.quiz_id = q.id),
                (SELECT MAX(a.score * 1.0 / a.total) FROM quiz_attempt a WHERE a.quiz_id = q.id AND a.total > 0),
                (SELECT a.score * 1.0 / a.total FROM quiz_attempt a WHERE a.quiz_id = q.id AND a.total > 0 ORDER BY a.finished_at DESC LIMIT 1)
         FROM quiz q WHERE q.notebook_id = ?1 ORDER BY q.created_at DESC, q.id DESC",
    )?
    .query_map([notebook_id], |r| {
        Ok(QuizSummary {
            id: r.get(0)?,
            notebook_id: r.get(1)?,
            title: r.get(2)?,
            created_at: r.get(3)?,
            question_count: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
            attempts: r.get(5)?,
            best: r.get(6)?,
            last: r.get(7)?,
        })
    })?
    .collect()
}

#[tauri::command]
pub fn quizzes_list(app: AppHandle, db: State<'_, StudyDb>, notebook_id: i64) -> Result<Vec<QuizSummary>, String> {
    with_db(&app, &db, |c| list_quizzes(c, notebook_id))
}

#[tauri::command]
pub fn quiz_get(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<Quiz, String> {
    let quiz = with_db(&app, &db, |c| {
        c.query_row("SELECT id, notebook_id, title, questions_json, created_at FROM quiz WHERE id = ?1", [id], |r| {
            Ok(Quiz { id: r.get(0)?, notebook_id: r.get(1)?, title: r.get(2)?, questions: parse(r.get(3)?), created_at: r.get(4)? })
        })
        .optional()
    })?;
    quiz.ok_or_else(|| "Quiz not found.".into())
}

#[tauri::command]
pub fn quiz_create(app: AppHandle, db: State<'_, StudyDb>, notebook_id: i64, title: String, questions: Value) -> Result<i64, String> {
    if !questions.as_array().is_some_and(|a| !a.is_empty()) {
        return Err("A quiz needs at least one question.".into());
    }
    let title: String = title.trim().chars().take(200).collect();
    with_db(&app, &db, |c| {
        c.execute(
            "INSERT INTO quiz (notebook_id, title, questions_json, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![notebook_id, title, questions.to_string(), now_ms()],
        )?;
        Ok(c.last_insert_rowid())
    })
}

#[tauri::command]
pub fn quiz_delete(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<(), String> {
    let changed = with_db(&app, &db, |c| c.execute("DELETE FROM quiz WHERE id = ?1", [id]))?;
    expect_one(changed, "Quiz")
}

#[tauri::command]
pub fn quiz_attempt_add(
    app: AppHandle,
    db: State<'_, StudyDb>,
    quiz_id: i64,
    started_at: i64,
    score: f64,
    total: i64,
    answers: Value,
) -> Result<i64, String> {
    let id = with_db(&app, &db, |c| {
        let notebook: Option<i64> = c.query_row("SELECT notebook_id FROM quiz WHERE id = ?1", [quiz_id], |r| r.get(0)).optional()?;
        let Some(notebook_id) = notebook else { return Ok(None) };
        c.execute(
            "INSERT INTO quiz_attempt (quiz_id, notebook_id, started_at, finished_at, score, total, answers_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![quiz_id, notebook_id, started_at, now_ms(), score, total, answers.to_string()],
        )?;
        Ok(Some(c.last_insert_rowid()))
    })?;
    id.ok_or_else(|| "Quiz not found.".into())
}

#[tauri::command]
pub fn attempts_list(app: AppHandle, db: State<'_, StudyDb>, notebook_id: i64, since: i64) -> Result<Vec<Attempt>, String> {
    with_db(&app, &db, |c| {
        c.prepare(
            "SELECT a.id, a.quiz_id, q.title, a.started_at, a.finished_at, a.score, a.total, a.answers_json
             FROM quiz_attempt a JOIN quiz q ON q.id = a.quiz_id
             WHERE a.notebook_id = ?1 AND a.finished_at >= ?2 ORDER BY a.finished_at",
        )?
        .query_map(params![notebook_id, since], |r| {
            Ok(Attempt {
                id: r.get(0)?,
                quiz_id: r.get(1)?,
                quiz_title: r.get(2)?,
                started_at: r.get(3)?,
                finished_at: r.get(4)?,
                score: r.get(5)?,
                total: r.get(6)?,
                answers: parse(r.get(7)?),
            })
        })?
        .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notebook() -> (Connection, i64) {
        let c = Connection::open_in_memory().unwrap();
        super::super::prepare(&c).unwrap();
        let s = super::super::create_subject(&c, "Calculus II").unwrap();
        let nb = super::super::create_notebook(&c, s, "Series", "").unwrap();
        (c, nb)
    }

    fn card(front: &str) -> NewCard {
        NewCard { front: front.into(), back: "b".into(), topic: "Series".into(), source_refs: Value::Null }
    }

    #[test]
    fn decks_hold_their_cards_and_score_runs() {
        let (c, nb) = notebook();
        let deck = create_deck(&c, nb, "Convergence tests", &[card("ratio test"), card("root test")]).unwrap();
        let other = create_deck(&c, nb, "Series basics", &[card("geometric")]).unwrap();
        let cards = list_cards(&c, deck).unwrap();
        assert_eq!(cards.len(), 2);
        let res = |i: usize, ok: bool| CardResult { card_id: cards[i].id, correct: ok, elapsed_ms: 500 };
        record_run(&c, deck, 0, &[res(0, true), res(1, false)]).unwrap();
        record_run(&c, deck, 0, &[res(0, true), res(1, true)]).unwrap();
        let decks = list_decks(&c, nb).unwrap();
        let d = decks.iter().find(|d| d.id == deck).unwrap();
        assert_eq!((d.card_count, d.runs, d.best, d.last), (2, 2, Some(1.0), Some(1.0)));
        let o = decks.iter().find(|d| d.id == other).unwrap();
        assert_eq!((o.runs, o.best), (0, None));
        let again = list_cards(&c, deck).unwrap();
        assert_eq!((again[1].reviews, again[1].misses, again[1].last_correct), (2, 1, Some(true)));
        assert_eq!(super::super::tree(&c).unwrap()[0].notebooks[0].deck_count, 2);
    }

    #[test]
    fn a_run_ignores_cards_from_other_decks_and_deleting_a_deck_removes_its_cards() {
        let (c, nb) = notebook();
        let a = create_deck(&c, nb, "A", &[card("x")]).unwrap();
        let b = create_deck(&c, nb, "B", &[card("y")]).unwrap();
        let foreign = list_cards(&c, b).unwrap()[0].id;
        record_run(&c, a, 0, &[CardResult { card_id: foreign, correct: true, elapsed_ms: 0 }]).unwrap();
        let reviews: i64 = c.query_row("SELECT COUNT(*) FROM card_review", [], |r| r.get(0)).unwrap();
        assert_eq!(reviews, 0);
        c.execute("DELETE FROM deck WHERE id = ?1", [a]).unwrap();
        let left: i64 = c.query_row("SELECT COUNT(*) FROM flashcard", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 1);
        assert!(record_run(&c, a, 0, &[]).unwrap().is_none());
    }

    #[test]
    fn quiz_summary_reports_best_and_last() {
        let (c, nb) = notebook();
        c.execute(
            "INSERT INTO quiz (notebook_id, title, questions_json, created_at) VALUES (?1, 'Tests', '[{}, {}, {}, {}]', 0)",
            [nb],
        )
        .unwrap();
        let q = c.last_insert_rowid();
        for (score, at) in [(3.0, 1), (1.0, 2)] {
            c.execute(
                "INSERT INTO quiz_attempt (quiz_id, notebook_id, started_at, finished_at, score, total, answers_json) VALUES (?1, ?2, 0, ?3, ?4, 4, '[]')",
                params![q, nb, at, score],
            )
            .unwrap();
        }
        let s = &list_quizzes(&c, nb).unwrap()[0];
        assert_eq!((s.question_count, s.attempts, s.best, s.last), (4, 2, Some(0.75), Some(0.25)));
    }
}
