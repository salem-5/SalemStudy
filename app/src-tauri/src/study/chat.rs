//! Saved chats: standalone threads (`notebook_id` NULL) and notebook chats,
//! their messages, and the files attached to them or produced by Python.

use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use super::{expect_one, now_ms, with_db, StudyDb};

/// Uploads larger than this are refused rather than bloating study.db.
const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatThread {
    pub id: i64,
    pub notebook_id: Option<i64>,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: i64,
    pub role: String,
    pub content: String,
    /// Python runs, figure and attachment ids, citations: whatever the UI
    /// needs to redraw the message exactly.
    pub meta: Value,
    pub created_at: i64,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub id: i64,
    pub kind: String,
    pub name: String,
    pub mime: String,
    pub size: i64,
    /// Extracted text, when there is any (text files, PDFs).
    pub text: Option<String>,
}

fn thread(conn: &Connection, id: i64) -> rusqlite::Result<ChatThread> {
    conn.query_row(
        "SELECT c.id, c.notebook_id, c.title, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM message m WHERE m.conversation_id = c.id)
         FROM conversation c WHERE c.id = ?1",
        [id],
        |r| {
            Ok(ChatThread {
                id: r.get(0)?,
                notebook_id: r.get(1)?,
                title: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
                message_count: r.get(5)?,
            })
        },
    )
}

pub fn list(conn: &Connection, notebook_id: Option<i64>) -> rusqlite::Result<Vec<ChatThread>> {
    let ids: Vec<i64> = conn
        .prepare("SELECT id FROM conversation WHERE notebook_id IS ?1 ORDER BY updated_at DESC, id DESC")?
        .query_map([notebook_id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    ids.into_iter().map(|id| thread(conn, id)).collect()
}

pub fn create(conn: &Connection, notebook_id: Option<i64>, title: &str) -> rusqlite::Result<ChatThread> {
    let t = now_ms();
    conn.execute(
        "INSERT INTO conversation (notebook_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params![notebook_id, title, t],
    )?;
    thread(conn, conn.last_insert_rowid())
}

pub fn messages(conn: &Connection, conversation_id: i64) -> rusqlite::Result<Vec<ChatMessage>> {
    conn.prepare("SELECT id, role, content, meta_json, created_at FROM message WHERE conversation_id = ?1 ORDER BY id")?
        .query_map([conversation_id], |r| {
            let meta: Option<String> = r.get(3)?;
            Ok(ChatMessage {
                id: r.get(0)?,
                role: r.get(1)?,
                content: r.get(2)?,
                meta: meta.and_then(|m| serde_json::from_str(&m).ok()).unwrap_or(Value::Null),
                created_at: r.get(4)?,
            })
        })?
        .collect()
}

pub fn add_message(conn: &Connection, conversation_id: i64, role: &str, content: &str, meta: &Value) -> rusqlite::Result<ChatMessage> {
    let t = now_ms();
    let meta_json = if meta.is_null() { None } else { Some(meta.to_string()) };
    conn.execute(
        "INSERT INTO message (conversation_id, role, content, meta_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![conversation_id, role, content, meta_json, t],
    )?;
    let id = conn.last_insert_rowid();
    conn.execute("UPDATE conversation SET updated_at = ?2 WHERE id = ?1", params![conversation_id, t])?;
    Ok(ChatMessage { id, role: role.into(), content: content.into(), meta: meta.clone(), created_at: t })
}

/// Accepts plain base64 or a `data:` URL.
fn decode(data: &str) -> Result<Vec<u8>, String> {
    let raw = data.split_once(";base64,").map(|(_, b)| b).unwrap_or(data);
    base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|e| format!("attachment is not valid base64: {e}"))
}

#[tauri::command]
pub fn chat_list(app: AppHandle, db: State<'_, StudyDb>, notebook_id: Option<i64>) -> Result<Vec<ChatThread>, String> {
    with_db(&app, &db, |c| list(c, notebook_id))
}

#[tauri::command]
pub fn chat_create(app: AppHandle, db: State<'_, StudyDb>, notebook_id: Option<i64>, title: Option<String>) -> Result<ChatThread, String> {
    let title = title.unwrap_or_default().trim().chars().take(200).collect::<String>();
    with_db(&app, &db, |c| create(c, notebook_id, &title))
}

#[tauri::command]
pub fn chat_rename(app: AppHandle, db: State<'_, StudyDb>, id: i64, title: String) -> Result<(), String> {
    let title: String = title.trim().chars().take(200).collect();
    let changed = with_db(&app, &db, |c| c.execute("UPDATE conversation SET title = ?2 WHERE id = ?1", params![id, title]))?;
    expect_one(changed, "Chat")
}

#[tauri::command]
pub fn chat_delete(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<(), String> {
    let changed = with_db(&app, &db, |c| c.execute("DELETE FROM conversation WHERE id = ?1", [id]))?;
    expect_one(changed, "Chat")
}

/// Empty a chat: its messages and files go, the thread (and its title) stays.
pub fn clear(conn: &Connection, id: i64) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM attachment WHERE conversation_id = ?1", [id])?;
    conn.execute("DELETE FROM message WHERE conversation_id = ?1", [id])
}

#[tauri::command]
pub fn chat_clear(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<(), String> {
    with_db(&app, &db, |c| clear(c, id)).map(|_| ())
}

/// Drop a message and everything after it in its thread (regenerating a
/// reply, or editing an earlier question). Returns how many went.
pub fn truncate(conn: &Connection, conversation_id: i64, from_id: i64) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM message WHERE conversation_id = ?1 AND id >= ?2", [conversation_id, from_id])
}

#[tauri::command]
pub fn chat_truncate(app: AppHandle, db: State<'_, StudyDb>, conversation_id: i64, from_id: i64) -> Result<usize, String> {
    with_db(&app, &db, |c| truncate(c, conversation_id, from_id))
}

/// Delete every chat in one place: the standalone Chat tab (`notebook_id`
/// null) or one notebook.
#[tauri::command]
pub fn chat_delete_all(app: AppHandle, db: State<'_, StudyDb>, notebook_id: Option<i64>) -> Result<usize, String> {
    with_db(&app, &db, |c| c.execute("DELETE FROM conversation WHERE notebook_id IS ?1", [notebook_id]))
}

#[tauri::command]
pub fn chat_messages(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<Vec<ChatMessage>, String> {
    with_db(&app, &db, |c| messages(c, id))
}

#[tauri::command]
pub fn chat_add_message(
    app: AppHandle,
    db: State<'_, StudyDb>,
    conversation_id: i64,
    role: String,
    content: String,
    meta: Option<Value>,
) -> Result<ChatMessage, String> {
    if !matches!(role.as_str(), "user" | "assistant" | "system" | "event") {
        return Err(format!("unknown message role {role}"));
    }
    with_db(&app, &db, |c| add_message(c, conversation_id, &role, &content, &meta.unwrap_or(Value::Null)))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn attachment_add(
    app: AppHandle,
    db: State<'_, StudyDb>,
    conversation_id: Option<i64>,
    notebook_id: Option<i64>,
    kind: String,
    name: String,
    mime: String,
    data: String,
    text: Option<String>,
) -> Result<AttachmentInfo, String> {
    let bytes = decode(&data)?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!("{name} is larger than {} MB.", MAX_ATTACHMENT_BYTES / 1024 / 1024));
    }
    let size = bytes.len() as i64;
    let name: String = name.trim().chars().take(200).collect();
    with_db(&app, &db, |c| {
        c.execute(
            "INSERT INTO attachment (conversation_id, notebook_id, kind, name, mime, size, data, text, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![conversation_id, notebook_id, kind, name, mime, size, bytes, text, now_ms()],
        )?;
        Ok(AttachmentInfo { id: c.last_insert_rowid(), kind, name, mime, size, text })
    })
}

/// Text pulled out of an attachment after upload (a PDF read with PyMuPDF).
#[tauri::command]
pub fn attachment_set_text(app: AppHandle, db: State<'_, StudyDb>, id: i64, text: String) -> Result<(), String> {
    let changed = with_db(&app, &db, |c| c.execute("UPDATE attachment SET text = ?2 WHERE id = ?1", params![id, text]))?;
    expect_one(changed, "Attachment")
}

/// Metadata (and extracted text) of several attachments, in the order asked.
#[tauri::command]
pub fn attachments_info(app: AppHandle, db: State<'_, StudyDb>, ids: Vec<i64>) -> Result<Vec<AttachmentInfo>, String> {
    with_db(&app, &db, |c| {
        let mut stmt = c.prepare("SELECT id, kind, name, mime, size, text FROM attachment WHERE id = ?1")?;
        let mut out = Vec::new();
        for id in &ids {
            if let Some(a) = stmt
                .query_row([id], |r| {
                    Ok(AttachmentInfo { id: r.get(0)?, kind: r.get(1)?, name: r.get(2)?, mime: r.get(3)?, size: r.get(4)?, text: r.get(5)? })
                })
                .optional()?
            {
                out.push(a);
            }
        }
        Ok(out)
    })
}

/// The attachment as a `data:` URL, for `<img>` and downloads.
#[tauri::command]
pub fn attachment_data(app: AppHandle, db: State<'_, StudyDb>, id: i64) -> Result<String, String> {
    let row: Option<(String, Vec<u8>)> = with_db(&app, &db, |c| {
        c.query_row("SELECT mime, data FROM attachment WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional()
    })?;
    let (mime, data) = row.ok_or("Attachment not found.")?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(data)))
}

/// Name and bytes of each attachment, for copying into the Python sandbox.
pub fn attachment_files(app: &AppHandle, db: &StudyDb, ids: &[i64]) -> Result<Vec<(String, Vec<u8>)>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    with_db(app, db, |c| {
        let mut stmt = c.prepare("SELECT name, data FROM attachment WHERE id = ?1")?;
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

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        super::super::prepare(&c).unwrap();
        c
    }

    #[test]
    fn standalone_and_notebook_threads_stay_apart() {
        let c = mem();
        let s = super::super::create_subject(&c, "Calculus II").unwrap();
        let nb = super::super::create_notebook(&c, s, "Series", "").unwrap();
        let free = create(&c, None, "Scratch").unwrap();
        let bound = create(&c, Some(nb), "Ratio test").unwrap();
        add_message(&c, free.id, "user", "hi", &Value::Null).unwrap();
        assert_eq!(list(&c, None).unwrap().iter().map(|t| t.id).collect::<Vec<_>>(), [free.id]);
        assert_eq!(list(&c, Some(nb)).unwrap().iter().map(|t| t.id).collect::<Vec<_>>(), [bound.id]);
        assert_eq!(list(&c, None).unwrap()[0].message_count, 1);
    }

    #[test]
    fn messages_keep_order_and_meta() {
        let c = mem();
        let t = create(&c, None, "").unwrap();
        add_message(&c, t.id, "user", "plot sin", &Value::Null).unwrap();
        add_message(&c, t.id, "assistant", "done", &serde_json::json!({"figures": [3]})).unwrap();
        let m = messages(&c, t.id).unwrap();
        assert_eq!(m.iter().map(|x| x.role.as_str()).collect::<Vec<_>>(), ["user", "assistant"]);
        assert_eq!(m[1].meta["figures"][0], 3);
        assert!(m[0].meta.is_null());
    }

    #[test]
    fn clearing_keeps_the_thread_and_deleting_all_stays_in_scope() {
        let c = mem();
        let s = super::super::create_subject(&c, "Calc").unwrap();
        let nb = super::super::create_notebook(&c, s, "Series", "").unwrap();
        let a = create(&c, None, "A").unwrap();
        let b = create(&c, Some(nb), "B").unwrap();
        add_message(&c, a.id, "user", "hi", &Value::Null).unwrap();
        add_message(&c, b.id, "user", "hi", &Value::Null).unwrap();
        clear(&c, a.id).unwrap();
        assert!(messages(&c, a.id).unwrap().is_empty());
        assert_eq!(list(&c, None).unwrap()[0].title, "A");
        c.execute("DELETE FROM conversation WHERE notebook_id IS ?1", [None::<i64>]).unwrap();
        assert!(list(&c, None).unwrap().is_empty());
        assert_eq!(messages(&c, b.id).unwrap().len(), 1, "notebook chats are untouched");
    }

    #[test]
    fn truncating_drops_the_message_and_what_follows_only_in_its_thread() {
        let c = mem();
        let a = create(&c, None, "a").unwrap();
        let b = create(&c, None, "b").unwrap();
        let q1 = add_message(&c, a.id, "user", "q1", &Value::Null).unwrap();
        let r1 = add_message(&c, a.id, "assistant", "r1", &Value::Null).unwrap();
        add_message(&c, b.id, "user", "other", &Value::Null).unwrap();
        add_message(&c, a.id, "user", "q2", &Value::Null).unwrap();
        add_message(&c, a.id, "assistant", "r2", &Value::Null).unwrap();
        assert_eq!(truncate(&c, a.id, r1.id).unwrap(), 3);
        let left: Vec<_> = messages(&c, a.id).unwrap().into_iter().map(|m| m.id).collect();
        assert_eq!(left, vec![q1.id]);
        assert_eq!(messages(&c, b.id).unwrap().len(), 1);
    }

    #[test]
    fn decodes_data_urls_and_plain_base64() {
        assert_eq!(decode("data:text/plain;base64,aGk=").unwrap(), b"hi");
        assert_eq!(decode("aGk=").unwrap(), b"hi");
        assert!(decode("%%%").is_err());
    }
}
