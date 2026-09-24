use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::study::{now_ms, with_db, StudyDb};

pub fn load_task(app: &AppHandle, db: &StudyDb, task_id: &str) -> Result<Value, String> {
    with_db(app, db, |c| {
        let row: Option<String> = c
            .query_row("SELECT state_json FROM salem_task WHERE task_id = ?1", params![task_id], |r| r.get(0))
            .optional()?;
        Ok(row)
    })
    .map(|row| row.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!({})))
}

pub fn save_task(app: &AppHandle, db: &StudyDb, task_id: &str, state: &Value) -> Result<Value, String> {
    let body = serde_json::to_string(state).map_err(|e| e.to_string())?;
    let now = now_ms();
    with_db(app, db, |c| {
        c.execute(
            "INSERT INTO salem_task (task_id, state_json, version, created_at, updated_at)
             VALUES (?1, ?2, 1, ?3, ?3)
             ON CONFLICT(task_id) DO UPDATE SET state_json = ?2, version = version + 1, updated_at = ?3",
            params![task_id, body, now],
        )?;
        let version: i64 = c.query_row("SELECT version FROM salem_task WHERE task_id = ?1", params![task_id], |r| r.get(0))?;
        Ok(json!({ "ok": true, "version": version }))
    })
}

pub fn clear_task(app: &AppHandle, db: &StudyDb, task_id: &str) -> Result<(), String> {
    with_db(app, db, |c| {
        c.execute("DELETE FROM salem_task WHERE task_id = ?1", params![task_id])?;
        Ok(())
    })
}

pub fn already_applied(app: &AppHandle, db: &StudyDb, idem: &str) -> Option<Value> {
    with_db(app, db, |c| {
        let row: Option<String> = c
            .query_row("SELECT result_json FROM salem_applied WHERE idem = ?1", params![idem], |r| r.get(0))
            .optional()?;
        Ok(row)
    })
    .ok()
    .flatten()
    .and_then(|s| serde_json::from_str(&s).ok())
}

pub fn remember_applied(app: &AppHandle, db: &StudyDb, idem: &str, tool: &str, result: &Value) {
    let Ok(body) = serde_json::to_string(result) else { return };
    let _ = with_db(app, db, |c| {
        c.execute(
            "INSERT OR REPLACE INTO salem_applied (idem, tool, result_json, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![idem, tool, body, now_ms()],
        )?;
        c.execute("DELETE FROM salem_applied WHERE created_at < ?1", params![now_ms() - 7 * 86_400_000])?;
        Ok(())
    });
}

pub fn record_run(app: &AppHandle, db: &StudyDb, t: &Value) -> Result<(), String> {
    let n = |key: &str| t.get(key).and_then(Value::as_i64).unwrap_or(0);
    let s = |key: &str| t.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    with_db(app, db, |c| {
        c.execute(
            "INSERT INTO salem_run (run_id, feature, state, duration_ms, steps, tool_calls, tool_failures,
                                    python_calls, python_failures, retrieval_failures, subagents, retries,
                                    input_tokens, output_tokens, created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![
                s("run"), s("feature"), s("state"), n("durationMs"), n("steps"), n("tool_calls"),
                n("tool_failures"), n("python_calls"), n("python_failures"), n("retrieval_failures"),
                n("subagents"), n("retries"), n("input_tokens"), n("output_tokens"), now_ms()
            ],
        )?;
        prune(c)?;
        Ok(())
    })
}

fn prune(c: &Connection) -> rusqlite::Result<()> {
    c.execute(
        "DELETE FROM salem_run WHERE id NOT IN (SELECT id FROM salem_run ORDER BY id DESC LIMIT 2000)",
        [],
    )?;
    Ok(())
}

pub fn summary(app: &AppHandle, db: &StudyDb, since: i64) -> Result<Value, String> {
    with_db(app, db, |c| {
        let total: Value = c.query_row(
            "SELECT COUNT(*), COALESCE(SUM(state = 'completed'), 0), COALESCE(SUM(state = 'failed'), 0),
                    COALESCE(SUM(state = 'cancelled'), 0), COALESCE(AVG(duration_ms), 0),
                    COALESCE(SUM(tool_calls), 0), COALESCE(SUM(tool_failures), 0),
                    COALESCE(SUM(python_calls), 0), COALESCE(SUM(python_failures), 0),
                    COALESCE(SUM(retrieval_failures), 0), COALESCE(SUM(retries), 0),
                    COALESCE(SUM(subagents), 0), COALESCE(SUM(input_tokens + output_tokens), 0)
             FROM salem_run WHERE created_at >= ?1",
            params![since],
            |r| {
                Ok(json!({
                    "runs": r.get::<_, i64>(0)?, "completed": r.get::<_, i64>(1)?,
                    "failed": r.get::<_, i64>(2)?, "cancelled": r.get::<_, i64>(3)?,
                    "avgDurationMs": r.get::<_, f64>(4)? as i64,
                    "toolCalls": r.get::<_, i64>(5)?, "toolFailures": r.get::<_, i64>(6)?,
                    "pythonCalls": r.get::<_, i64>(7)?, "pythonFailures": r.get::<_, i64>(8)?,
                    "retrievalFailures": r.get::<_, i64>(9)?, "retries": r.get::<_, i64>(10)?,
                    "subagents": r.get::<_, i64>(11)?, "tokens": r.get::<_, i64>(12)?,
                }))
            },
        )?;
        let mut stmt = c.prepare(
            "SELECT feature, COUNT(*), COALESCE(SUM(state = 'failed'), 0), COALESCE(AVG(duration_ms), 0)
             FROM salem_run WHERE created_at >= ?1 GROUP BY feature ORDER BY COUNT(*) DESC",
        )?;
        let by_feature: Vec<Value> = stmt
            .query_map(params![since], |r| {
                Ok(json!({ "feature": r.get::<_, String>(0)?, "runs": r.get::<_, i64>(1)?,
                           "failed": r.get::<_, i64>(2)?, "avgDurationMs": r.get::<_, f64>(3)? as i64 }))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(json!({ "total": total, "byFeature": by_feature, "since": since }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::study;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        study::prepare(&c).unwrap();
        c
    }

    #[test]
    fn a_task_state_round_trips_and_its_version_climbs() {
        let c = db();
        let now = 1;
        c.execute(
            "INSERT INTO salem_task (task_id, state_json, version, created_at, updated_at) VALUES ('t', '{\"a\":1}', 1, ?1, ?1)",
            params![now],
        )
        .unwrap();
        c.execute(
            "INSERT INTO salem_task (task_id, state_json, version, created_at, updated_at) VALUES ('t', '{\"a\":2}', 1, ?1, ?1)
             ON CONFLICT(task_id) DO UPDATE SET state_json = '{\"a\":2}', version = version + 1, updated_at = ?1",
            params![now],
        )
        .unwrap();
        let (body, version): (String, i64) = c
            .query_row("SELECT state_json, version FROM salem_task WHERE task_id = 't'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(body, "{\"a\":2}");
        assert_eq!(version, 2);
    }

    #[test]
    fn telemetry_rolls_up_by_feature() {
        let c = db();
        for (feature, state) in [("chat", "completed"), ("chat", "failed"), ("task", "completed")] {
            c.execute(
                "INSERT INTO salem_run (run_id, feature, state, duration_ms, tool_calls, created_at)
                 VALUES ('r', ?1, ?2, 100, 2, 5)",
                params![feature, state],
            )
            .unwrap();
        }
        let runs: i64 = c.query_row("SELECT COUNT(*) FROM salem_run WHERE created_at >= 0", [], |r| r.get(0)).unwrap();
        let failed: i64 = c
            .query_row("SELECT COALESCE(SUM(state = 'failed'), 0) FROM salem_run", [], |r| r.get(0))
            .unwrap();
        assert_eq!((runs, failed), (3, 1));
    }
}
