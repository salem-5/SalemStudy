use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, State};

use super::{sources::fts_query, with_db, StudyDb};

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub kind: String,
    pub id: i64,
    pub notebook_id: Option<i64>,
    pub title: String,
    pub detail: String,
    pub snippet: String,
    pub target: Option<i64>,
}

fn like(q: &str) -> String {
    format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
}

pub fn search_all(conn: &Connection, query: &str, limit: i64) -> rusqlite::Result<Vec<Found>> {
    let q = query.trim();
    if q.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    if let Some(fts) = fts_query(q) {
        let mut stmt = conn.prepare(
            "SELECT s.id, s.notebook_id, s.title, COALESCE(u.label, ''), snippet(chunk_fts, 0, '[', ']', '…', 18), c.unit_from
             FROM chunk_fts JOIN chunk c ON c.id = chunk_fts.rowid JOIN source s ON s.id = c.source_id
             LEFT JOIN unit u ON u.source_id = c.source_id AND u.ord = c.unit_from
             WHERE chunk_fts MATCH ?1 ORDER BY bm25(chunk_fts) LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![fts, limit], |r| {
            Ok(Found { kind: "source".into(), id: r.get(0)?, notebook_id: r.get(1)?, title: r.get(2)?, detail: r.get(3)?, snippet: r.get(4)?, target: r.get(5)? })
        })?;
        out.extend(rows.collect::<Result<Vec<_>, _>>()?);
    }
    let pat = like(q);
    let snippet = |text: &str| -> String {
        let lower = text.to_lowercase();
        let at = lower.find(&q.to_lowercase()).unwrap_or(0);
        let start = text[..at].char_indices().rev().nth(60).map_or(0, |(i, _)| i);
        let piece: String = text[start..].chars().take(180).collect();
        format!("{}{}", if start > 0 { "…" } else { "" }, piece.replace('\n', " "))
    };
    let mut stmt = conn.prepare("SELECT id, notebook_id, title, content FROM note WHERE title LIKE ?1 ESCAPE '\\' OR content LIKE ?1 ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?2")?;
    let notes = stmt.query_map(params![pat, limit], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))?;
    for n in notes {
        let (id, nb, title, content) = n?;
        out.push(Found { kind: "note".into(), id, notebook_id: Some(nb), title, detail: String::new(), snippet: snippet(&content), target: None });
    }
    let mut stmt = conn.prepare(
        "SELECT f.id, f.notebook_id, d.title, f.front, f.back, d.id FROM flashcard f JOIN deck d ON d.id = f.deck_id
         WHERE f.front LIKE ?1 ESCAPE '\\' OR f.back LIKE ?1 ESCAPE '\\' LIMIT ?2",
    )?;
    let cards = stmt.query_map(params![pat, limit], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?, r.get::<_, i64>(5)?))
    })?;
    for c in cards {
        let (id, nb, deck, front, back, deck_id) = c?;
        out.push(Found { kind: "card".into(), id, notebook_id: Some(nb), title: front.chars().take(120).collect(), detail: deck, snippet: back.chars().take(180).collect(), target: Some(deck_id) });
    }
    let mut stmt = conn.prepare(
        "SELECT c.id, c.notebook_id, c.title, m.content FROM message m JOIN conversation c ON c.id = m.conversation_id
         WHERE m.content LIKE ?1 ESCAPE '\\' ORDER BY m.created_at DESC LIMIT ?2",
    )?;
    let chats = stmt.query_map(params![pat, limit], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))?;
    let mut seen = std::collections::HashSet::new();
    for c in chats {
        let (id, nb, title, content) = c?;
        if seen.insert(id) {
            out.push(Found { kind: "chat".into(), id, notebook_id: nb, title: if title.is_empty() { "Chat".into() } else { title }, detail: String::new(), snippet: snippet(&content), target: None });
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn search_everything(app: AppHandle, db: State<'_, StudyDb>, query: String) -> Result<Vec<Found>, String> {
    with_db(&app, &db, |c| search_all(c, &query, 12))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::study::sources::{add, set_content, UnitIn};

    #[test]
    fn finds_sources_notes_cards_and_chats_across_notebooks() {
        let c = Connection::open_in_memory().unwrap();
        crate::study::prepare(&c).unwrap();
        let s = crate::study::create_subject(&c, "Calc").unwrap();
        let a = crate::study::create_notebook(&c, s, "Series", "").unwrap();
        let b = crate::study::create_notebook(&c, s, "Lines", "").unwrap();
        let src = add(&c, a, "text", "Lecture 9", None, "", None, None).unwrap();
        set_content(&c, src.id, &[UnitIn { label: "Page 4".into(), text: "The ratio test compares consecutive terms.".into() }]).unwrap();
        crate::study::notes::create(&c, b, "Tests", "Use the ratio test for factorials.", "").unwrap();
        crate::study::cards::create_deck(&c, a, "Convergence", &[crate::study::cards::NewCard { front: "State the ratio test".into(), back: "L < 1".into(), topic: String::new(), source_refs: serde_json::Value::Null }]).unwrap();
        let t = crate::study::chat::create(&c, None, "Help").unwrap();
        crate::study::chat::add_message(&c, t.id, "user", "explain the ratio test", &serde_json::Value::Null).unwrap();
        let found = search_all(&c, "ratio test", 10).unwrap();
        let kinds: Vec<&str> = found.iter().map(|f| f.kind.as_str()).collect();
        assert_eq!(kinds, ["source", "note", "card", "chat"]);
        assert_eq!(found[0].detail, "Page 4");
        assert!(found[0].snippet.contains("[ratio]"));
        assert!(search_all(&c, "x", 10).unwrap().is_empty());
        assert!(search_all(&c, "100%_off", 10).is_ok());
    }
}
