use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use super::{expect_one, now_ms, with_db, StudyDb};

const MAX_SOURCE_BYTES: usize = 200 * 1024 * 1024;
const CHUNK_CHARS: usize = 1400;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: i64,
    pub notebook_id: i64,
    pub kind: String,
    pub title: String,
    pub filename: Option<String>,
    pub mime: String,
    pub size: i64,
    pub url: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub unit_count: i64,
    pub char_count: i64,
    pub created_at: i64,
    pub report: Option<Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UnitIn {
    pub label: String,
    pub text: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Unit {
    pub ord: i64,
    pub label: String,
    pub text: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub chunk_id: i64,
    pub source_id: i64,
    pub source_title: String,
    pub kind: String,
    pub unit_from: i64,
    pub unit_to: i64,
    pub label: String,
    pub text: String,
    pub score: f64,
}

const SOURCE_COLS: &str = "id, notebook_id, kind, title, filename, mime, size, url, status, error, unit_count, char_count, created_at, profile_json";

fn row_source(r: &rusqlite::Row) -> rusqlite::Result<Source> {
    Ok(Source {
        id: r.get(0)?,
        notebook_id: r.get(1)?,
        kind: r.get(2)?,
        title: r.get(3)?,
        filename: r.get(4)?,
        mime: r.get(5)?,
        size: r.get(6)?,
        url: r.get(7)?,
        status: r.get(8)?,
        error: r.get(9)?,
        unit_count: r.get(10)?,
        char_count: r.get(11)?,
        created_at: r.get(12)?,
        report: r.get::<_, Option<String>>(13)?.and_then(|s| serde_json::from_str(&s).ok()),
    })
}

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Option<Source>> {
    conn.query_row(&format!("SELECT {SOURCE_COLS} FROM source WHERE id = ?1"), [id], row_source).optional()
}

pub fn list(conn: &Connection, notebook_id: i64) -> rusqlite::Result<Vec<Source>> {
    conn.prepare(&format!("SELECT {SOURCE_COLS} FROM source WHERE notebook_id = ?1 ORDER BY created_at, id"))?
        .query_map([notebook_id], row_source)?
        .collect()
}

#[allow(clippy::too_many_arguments)]
pub fn add(conn: &Connection, notebook_id: i64, kind: &str, title: &str, filename: Option<&str>, mime: &str, data: Option<&[u8]>, url: Option<&str>) -> rusqlite::Result<Source> {
    conn.execute(
        "INSERT INTO source (notebook_id, kind, title, filename, mime, size, data, url, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'processing', ?9)",
        params![notebook_id, kind, title, filename, mime, data.map_or(0, |d| d.len() as i64), data, url, now_ms()],
    )?;
    Ok(get(conn, conn.last_insert_rowid())?.expect("just inserted"))
}

pub fn chunk_units(units: &[UnitIn]) -> Vec<(i64, i64, String)> {
    let mut out: Vec<(i64, i64, String)> = Vec::new();
    let mut cur = String::new();
    let mut from = 0i64;
    for (i, u) in units.iter().enumerate() {
        let i = i as i64;
        let text = u.text.trim();
        if text.is_empty() {
            continue;
        }
        if text.len() > CHUNK_CHARS {
            if !cur.is_empty() {
                out.push((from, i - 1, std::mem::take(&mut cur)));
            }
            let mut rest = text;
            while !rest.is_empty() {
                let cut = split_point(rest, CHUNK_CHARS);
                out.push((i, i, rest[..cut].trim().to_string()));
                rest = rest[cut..].trim_start();
            }
            from = i + 1;
            continue;
        }
        if cur.is_empty() {
            from = i;
        } else if cur.len() + text.len() > CHUNK_CHARS {
            out.push((from, i - 1, std::mem::take(&mut cur)));
            from = i;
        } else {
            cur.push_str("\n\n");
        }
        cur.push_str(text);
    }
    if !cur.is_empty() {
        out.push((from, units.len() as i64 - 1, cur));
    }
    out.retain(|c| !c.2.is_empty());
    out
}

fn split_point(s: &str, max: usize) -> usize {
    if s.len() <= max {
        return s.len();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    let window = &s[..end];
    let floor = end * 2 / 3;
    for pat in ["\n\n", "\n", ". ", "; ", ", ", " "] {
        if let Some(p) = window.rfind(pat) {
            if p >= floor {
                return p + pat.len();
            }
        }
    }
    end
}

pub fn set_content(conn: &Connection, id: i64, units: &[UnitIn]) -> rusqlite::Result<bool> {
    let notebook: Option<i64> = conn.query_row("SELECT notebook_id FROM source WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    let Some(notebook_id) = notebook else { return Ok(false) };
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM chunk WHERE source_id = ?1", [id])?;
    tx.execute("DELETE FROM unit WHERE source_id = ?1", [id])?;
    {
        let mut stmt = tx.prepare("INSERT INTO unit (source_id, ord, label, text) VALUES (?1, ?2, ?3, ?4)")?;
        for (i, u) in units.iter().enumerate() {
            stmt.execute(params![id, i as i64, u.label, u.text])?;
        }
        let mut stmt = tx.prepare(
            "INSERT INTO chunk (source_id, notebook_id, ord, text, unit_from, unit_to) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for (i, (from, to, text)) in chunk_units(units).into_iter().enumerate() {
            stmt.execute(params![id, notebook_id, i as i64, text, from, to])?;
        }
    }
    let chars: i64 = units.iter().map(|u| u.text.len() as i64).sum();
    tx.execute(
        "UPDATE source SET status = 'ready', error = NULL, unit_count = ?2, char_count = ?3 WHERE id = ?1",
        params![id, units.len() as i64, chars],
    )?;
    tx.commit()?;
    Ok(true)
}

pub fn fts_query(text: &str) -> Option<String> {
    const STOP: &[&str] = &[
        "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was", "one", "our", "out",
        "has", "his", "how", "its", "may", "new", "now", "see", "who", "did", "get", "use", "what", "when", "where",
        "which", "while", "with", "this", "that", "from", "they", "will", "would", "there", "their", "about", "into",
        "than", "then", "them", "these", "those", "does", "have", "been", "being", "some", "such", "only", "also",
        "just", "like", "more", "most", "other", "over", "your", "explain", "tell", "give", "show", "please", "why",
    ];
    let mut seen = std::collections::HashSet::new();
    let words: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .map(|w| w.to_lowercase())
        .filter(|w| w.chars().count() >= 3 && !STOP.contains(&w.as_str()) && seen.insert(w.clone()))
        .take(24)
        .map(|w| format!("\"{w}\""))
        .collect();
    if words.is_empty() { None } else { Some(words.join(" OR ")) }
}

pub fn search(conn: &Connection, source_ids: &[i64], query: &str, limit: usize) -> rusqlite::Result<Vec<Hit>> {
    if source_ids.is_empty() {
        return Ok(Vec::new());
    }
    let Some(q) = fts_query(query) else { return Ok(Vec::new()) };
    let ids = source_ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT c.id, c.source_id, s.title, s.kind, c.unit_from, c.unit_to, COALESCE(u.label, ''), c.text, bm25(chunk_fts)
         FROM chunk_fts JOIN chunk c ON c.id = chunk_fts.rowid JOIN source s ON s.id = c.source_id
         LEFT JOIN unit u ON u.source_id = c.source_id AND u.ord = c.unit_from
         WHERE chunk_fts MATCH ?1 AND c.source_id IN ({ids})
         ORDER BY bm25(chunk_fts) LIMIT ?2"
    );
    conn.prepare(&sql)?
        .query_map(params![q, limit as i64], |r| {
            Ok(Hit {
                chunk_id: r.get(0)?,
                source_id: r.get(1)?,
                source_title: r.get(2)?,
                kind: r.get(3)?,
                unit_from: r.get(4)?,
                unit_to: r.get(5)?,
                label: r.get(6)?,
                text: r.get(7)?,
                score: -r.get::<_, f64>(8)?,
            })
        })?
        .collect()
}

pub fn sample(conn: &Connection, source_ids: &[i64], max_chars: usize) -> rusqlite::Result<Vec<Hit>> {
    let mut all: Vec<Hit> = Vec::new();
    for id in source_ids {
        let mut rows: Vec<Hit> = conn
            .prepare(
                "SELECT c.id, c.source_id, s.title, s.kind, c.unit_from, c.unit_to, COALESCE(u.label, ''), c.text
                 FROM chunk c JOIN source s ON s.id = c.source_id
                 LEFT JOIN unit u ON u.source_id = c.source_id AND u.ord = c.unit_from
                 WHERE c.source_id = ?1 ORDER BY c.ord",
            )?
            .query_map([id], |r| {
                Ok(Hit {
                    chunk_id: r.get(0)?, source_id: r.get(1)?, source_title: r.get(2)?, kind: r.get(3)?,
                    unit_from: r.get(4)?, unit_to: r.get(5)?, label: r.get(6)?, text: r.get(7)?, score: 0.0,
                })
            })?
            .collect::<Result<_, _>>()?;
        all.append(&mut rows);
    }
    let total: usize = all.iter().map(|h| h.text.len()).sum();
    if total <= max_chars {
        return Ok(all);
    }
    let keep = (max_chars as f64 / total as f64).clamp(0.01, 1.0);
    let step = (1.0 / keep).ceil() as usize;
    Ok(all.into_iter().enumerate().filter(|(i, _)| i % step == 0).map(|(_, h)| h).collect())
}

fn decode(data: &str) -> Result<Vec<u8>, String> {
    let raw = data.split_once(";base64,").map(|(_, b)| b).unwrap_or(data);
    base64::engine::general_purpose::STANDARD.decode(raw.trim()).map_err(|e| format!("file is not valid base64: {e}"))
}

#[tauri::command]
pub fn sources_list(app: AppHandle, db: State<'_, StudyDb>, notebook_id: i64) -> Result<Vec<Source>, String> {
    with_db(&app, &db, |c| list(c, notebook_id))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn source_add(
    app: AppHandle,
    db: State<'_, StudyDb>,
    notebook_id: i64,
    kind: String,
    title: String,
    filename: Option<String>,
    mime: Option<String>,
    data: Option<String>,
    url: Option<String>,
) -> Result<Source, String> {
    let bytes = data.as_deref().map(decode).transpose()?;
    if bytes.as_ref().is_some_and(|b| b.len() > MAX_SOURCE_BYTES) {
        return Err(format!("{title} is larger than {} MB.", MAX_SOURCE_BYTES / 1024 / 1024));
    }
    let title: String = title.trim().chars().take(200).collect();
    with_db(&app, &db, |c| {
        add(c, notebook_id, &kind, &title, filename.as_deref(), mime.as_deref().unwrap_or(""), bytes.as_deref(), url.as_deref())
    })
}

#[tauri::command]
pub fn source_set_content(app: AppHandle, db: State<'_, StudyDb>, id: i64, units: Vec<UnitIn>) -> Result<Source, String> {
    let found = with_db(&app, &db, |c| set_content(c, id, &units))?;
    if !found {
        return Err("Source not found.".into());
    }
    with_db(&app, &db, |c| get(c, id))?.ok_or_else(|| "Source not found.".into())
}

#[tauri::command]
pub fn source_set_status(app: AppHandle, db: State<'_, StudyDb>, id: i64, status: String, error: Option<String>) -> Result<(), String> {
    let changed = with_db(&app, &db, |c| c.execute("UPDATE source SET status = ?2, error = ?3 WHERE id = ?1", params![id, status, error]))?;
    expect_one(changed, "Source")
}

#[tauri::command]
pub fn source_set_report(app: AppHandle, db: State<'_, StudyDb>, id: i64, report: Value) -> Result<(), String> {
    with_db(&app, &db, |c| {
        c.execute("UPDATE source SET profile_json = ?2 WHERE id = ?1", params![id, report.to_string()])
    })
    .and_then(|n| crate::study::expect_one(n, "source"))
}

#[tauri::command]
pub fn source_rename(app: AppHandle, db: State<'_, StudyDb>, id: i64, title: String) -> Result<(), String> {
    let title = super::clean_name(&title)?;
    let changed = with_db(&app, &db, |c| c.execute("UPDATE source SET title = ?2 WHERE id = ?1", params![id, title]))?;
    expect_one(changed, "Source")
}

#[tauri::command]
pub fn source_delete(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<(), String> {
    let changed = with_db(&app, &db, |c| c.execute("DELETE FROM source WHERE id = ?1", [id]))?;
    expect_one(changed, "Source")
}

#[tauri::command]
pub fn source_units(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<Vec<Unit>, String> {
    with_db(&app, &db, |c| {
        c.prepare("SELECT ord, label, text FROM unit WHERE source_id = ?1 ORDER BY ord")?
            .query_map([id], |r| Ok(Unit { ord: r.get(0)?, label: r.get(1)?, text: r.get(2)? }))?
            .collect()
    })
}

#[tauri::command]
pub fn source_data(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<String, String> {
    let row: Option<(String, Option<Vec<u8>>)> =
        with_db(&app, &db, |c| c.query_row("SELECT mime, data FROM source WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional())?;
    let (mime, data) = row.ok_or("Source not found.")?;
    let data = data.ok_or("This source has no file.")?;
    Ok(format!("data:{};base64,{}", if mime.is_empty() { "application/octet-stream" } else { &mime }, base64::engine::general_purpose::STANDARD.encode(data)))
}

#[tauri::command]
pub fn sources_search(app: AppHandle, db: State<'_, StudyDb>, source_ids: Vec<i64>, query: String, limit: Option<usize>) -> Result<Vec<Hit>, String> {
    with_db(&app, &db, |c| search(c, &source_ids, &query, limit.unwrap_or(10).clamp(1, 50)))
}

#[tauri::command]
pub fn sources_sample(app: AppHandle, db: State<'_, StudyDb>, source_ids: Vec<i64>, max_chars: Option<usize>) -> Result<Vec<Hit>, String> {
    with_db(&app, &db, |c| sample(c, &source_ids, max_chars.unwrap_or(60_000)))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SourceImage {
    pub id: i64,
    pub unit_ord: i64,
    pub caption: String,
}

#[tauri::command]
pub fn source_image_add(app: AppHandle, db: State<'_, StudyDb>, source_id: i64, unit_ord: i64, mime: String, data: String, caption: String) -> Result<i64, String> {
    let bytes = decode(&data)?;
    with_db(&app, &db, |c| {
        c.execute(
            "INSERT INTO source_image (source_id, unit_ord, mime, data, caption) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![source_id, unit_ord, mime, bytes, caption],
        )?;
        Ok(c.last_insert_rowid())
    })
}

#[tauri::command]
pub fn source_images_clear(app: AppHandle, db: State<'_, StudyDb>, source_id: i64) -> Result<(), String> {
    with_db(&app, &db, |c| c.execute("DELETE FROM source_image WHERE source_id = ?1", [source_id]).map(|_| ()))
}

#[tauri::command]
pub fn source_images(app: AppHandle, db: State<'_, StudyDb>, source_id: i64) -> Result<Vec<SourceImage>, String> {
    with_db(&app, &db, |c| {
        c.prepare("SELECT id, unit_ord, caption FROM source_image WHERE source_id = ?1 ORDER BY unit_ord, id")?
            .query_map([source_id], |r| Ok(SourceImage { id: r.get(0)?, unit_ord: r.get(1)?, caption: r.get(2)? }))?
            .collect()
    })
}

#[tauri::command]
pub fn source_image_data(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<String, String> {
    let row: Option<(String, Vec<u8>)> =
        with_db(&app, &db, |c| c.query_row("SELECT mime, data FROM source_image WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional())?;
    let (mime, data) = row.ok_or("Image not found.")?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(data)))
}

pub fn source_files(app: &AppHandle, db: &StudyDb, ids: &[i64]) -> Result<Vec<(String, Vec<u8>)>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    with_db(app, db, |c| {
        let mut stmt = c.prepare("SELECT COALESCE(filename, title), data FROM source WHERE id = ?1 AND data IS NOT NULL")?;
        let mut out = Vec::new();
        for id in ids {
            if let Some(row) = stmt.query_row([id], |r| Ok((r.get(0)?, r.get(1)?))).optional()? {
                out.push(row);
            }
        }
        Ok(out)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notebook() -> (Connection, i64) {
        let c = Connection::open_in_memory().unwrap();
        super::super::prepare(&c).unwrap();
        let s = super::super::create_subject(&c, "Calculus III").unwrap();
        let nb = super::super::create_notebook(&c, s, "Lines", "").unwrap();
        (c, nb)
    }

    fn unit(label: &str, text: &str) -> UnitIn {
        UnitIn { label: label.into(), text: text.into() }
    }

    #[test]
    fn content_is_chunked_indexed_and_searchable_per_source() {
        let (c, nb) = notebook();
        let a = add(&c, nb, "pdf", "Lecture 7", Some("l7.pdf"), "application/pdf", Some(b"%PDF"), None).unwrap();
        let b = add(&c, nb, "text", "Notes", None, "text/plain", None, None).unwrap();
        set_content(&c, a.id, &[
            unit("Page 1", "Vector equation of a line: r = r0 + t v, where v is the direction vector."),
            unit("Page 2", "The symmetric equations follow by solving each component for t."),
        ]).unwrap();
        set_content(&c, b.id, &[unit("Lines 1-3", "The ratio test compares consecutive terms of a series.")]).unwrap();

        let hits = search(&c, &[a.id, b.id], "What is the vector equation of a line?", 10).unwrap();
        assert_eq!(hits[0].source_id, a.id);
        assert_eq!(hits[0].label, "Page 1");
        assert!(search(&c, &[b.id], "vector equation line", 10).unwrap().is_empty(), "search is limited to the given sources");

        let s = get(&c, a.id).unwrap().unwrap();
        assert_eq!((s.status.as_str(), s.unit_count), ("ready", 2));
    }

    #[test]
    fn replacing_or_deleting_a_source_keeps_the_index_in_step() {
        let (c, nb) = notebook();
        let a = add(&c, nb, "text", "Notes", None, "text/plain", None, None).unwrap();
        set_content(&c, a.id, &[unit("1", "eigenvalues and eigenvectors")]).unwrap();
        set_content(&c, a.id, &[unit("1", "determinants and cofactors")]).unwrap();
        assert!(search(&c, &[a.id], "eigenvalues", 5).unwrap().is_empty());
        assert_eq!(search(&c, &[a.id], "cofactors", 5).unwrap().len(), 1);
        c.execute("DELETE FROM source WHERE id = ?1", [a.id]).unwrap();
        let fts: i64 = c.query_row("SELECT COUNT(*) FROM chunk_fts WHERE chunk_fts MATCH 'cofactors'", [], |r| r.get(0)).unwrap();
        assert_eq!(fts, 0);
    }

    #[test]
    fn long_units_split_at_sentence_breaks_and_short_units_merge() {
        let long = "This sentence is about forty characters. ".repeat(80);
        let chunks = chunk_units(&[unit("P1", "short one"), unit("P2", "short two"), unit("P3", &long)]);
        assert_eq!((chunks[0].0, chunks[0].1), (0, 1));
        assert!(chunks[0].2.contains("short one") && chunks[0].2.contains("short two"));
        assert!(chunks.len() > 2);
        assert!(chunks[1..].iter().all(|c| c.0 == 2 && c.2.len() <= CHUNK_CHARS && c.2.ends_with('.')));
    }

    #[test]
    fn queries_are_quoted_so_punctuation_is_safe() {
        assert_eq!(fts_query("what is the \"ratio\" test?").unwrap(), "\"ratio\" OR \"test\"");
        assert!(fts_query("a is it").is_none());
        let (c, nb) = notebook();
        let a = add(&c, nb, "text", "N", None, "", None, None).unwrap();
        set_content(&c, a.id, &[unit("1", "NEAR AND OR text")]).unwrap();
        assert!(search(&c, &[a.id], "NEAR(\"x\" AND) OR * : ^", 5).is_ok());
    }
}
