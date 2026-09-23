//! Every DeepSeek call's token counts and cost, whatever made it (solver,
//! chat, notes, decks, quizzes, reading sources), for the Settings totals.

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};

use super::{now_ms, with_db, StudyDb};

/// USD per million tokens (off-peak): cache hit, cache miss, output.
fn rates(model: &str) -> (f64, f64, f64) {
    if model.to_lowercase().contains("pro") { (0.022, 0.66, 1.98) } else { (0.003, 0.15, 0.6) }
}

/// DeepSeek charges double on weekday peak hours (UTC 01–04 and 06–10).
fn is_peak(at_ms: i64) -> bool {
    let secs = at_ms / 1000;
    let days = secs.div_euclid(86_400);
    let hour = secs.rem_euclid(86_400) / 3600;
    // 1970-01-01 was a Thursday: 0 = Thursday … 3 = Sunday, 4 = Monday.
    let weekday = (days + 4).rem_euclid(7); // 0 = Sunday … 6 = Saturday
    (1..=5).contains(&weekday) && ((1..4).contains(&hour) || (6..10).contains(&hour))
}

pub fn cost(model: &str, hit: i64, miss: i64, completion: i64, at_ms: i64, price: Option<(f64, f64, f64)>) -> f64 {
    // The chosen model's own price from the catalogue; without one, the
    // DeepSeek rates the app has always used (with DeepSeek's peak hours).
    let ((h, m, o), mult) = match price {
        Some(p) => (p, 1.0),
        None => (rates(model), if is_peak(at_ms) { 2.0 } else { 1.0 }),
    };
    (hit as f64 * h + miss as f64 * m + completion as f64 * o) / 1e6 * mult
}

/// Token counts from a `usage` object: cache hits, misses, output. DeepSeek
/// reports cache hits in its own field; OpenAI-style providers under
/// `prompt_tokens_details.cached_tokens`.
fn counts(usage: &Value) -> (i64, i64, i64) {
    let n = |k: &str| usage.get(k).and_then(Value::as_i64).unwrap_or(0);
    let prompt = n("prompt_tokens");
    let hit = usage.get("prompt_cache_hit_tokens").and_then(Value::as_i64)
        .or_else(|| usage.pointer("/prompt_tokens_details/cached_tokens").and_then(Value::as_i64))
        .unwrap_or(0);
    let miss = usage.get("prompt_cache_miss_tokens").and_then(Value::as_i64).unwrap_or((prompt - hit).max(0));
    (hit, miss, n("completion_tokens"))
}

/// What one completion cost, from its `usage` object, in USD.
pub fn cost_of(model: &str, usage: &Value, at_ms: i64, price: Option<(f64, f64, f64)>) -> f64 {
    let (hit, miss, out) = counts(usage);
    cost(model, hit, miss, out, at_ms, price)
}

/// Log one completion from its `usage` object. Missing fields count as zero.
pub fn record(conn: &Connection, model: &str, feature: &str, usage: &Value, price: Option<(f64, f64, f64)>) -> rusqlite::Result<()> {
    let (hit, miss, completion) = counts(usage);
    if hit + miss == 0 && completion == 0 {
        return Ok(());
    }
    let at = now_ms();
    conn.execute(
        "INSERT INTO ai_usage (at, model, feature, prompt_hit, prompt_miss, completion, cost) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![at, model, feature, hit, miss, completion, cost(model, hit, miss, completion, at, price)],
    )?;
    Ok(())
}

#[derive(Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub key: String,
    pub calls: i64,
    pub tokens: i64,
    pub cost: f64,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub total: Bucket,
    pub last30: Bucket,
    pub by_feature: Vec<Bucket>,
    pub by_model: Vec<Bucket>,
    /// Last 30 days, one bucket per UTC day ("YYYY-MM-DD").
    pub by_day: Vec<Bucket>,
    pub since: Option<i64>,
}

fn buckets(conn: &Connection, group: &str, since: i64) -> rusqlite::Result<Vec<Bucket>> {
    conn.prepare(&format!(
        "SELECT {group}, COUNT(*), SUM(prompt_hit + prompt_miss + completion), SUM(cost)
         FROM ai_usage WHERE at >= ?1 GROUP BY 1 ORDER BY 4 DESC"
    ))?
    .query_map([since], |r| Ok(Bucket { key: r.get(0)?, calls: r.get(1)?, tokens: r.get(2)?, cost: r.get(3)? }))?
    .collect()
}

pub fn summary(conn: &Connection) -> rusqlite::Result<Summary> {
    let one = |since: i64| -> rusqlite::Result<Bucket> {
        conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(prompt_hit + prompt_miss + completion), 0), COALESCE(SUM(cost), 0) FROM ai_usage WHERE at >= ?1",
            [since],
            |r| Ok(Bucket { key: String::new(), calls: r.get(0)?, tokens: r.get(1)?, cost: r.get(2)? }),
        )
    };
    let from30 = now_ms() - 30 * 86_400_000;
    Ok(Summary {
        total: one(0)?,
        last30: one(from30)?,
        by_feature: buckets(conn, "feature", 0)?,
        by_model: buckets(conn, "model", 0)?,
        by_day: {
            let mut v = buckets(conn, "strftime('%Y-%m-%d', at / 1000, 'unixepoch')", from30)?;
            v.sort_by(|a, b| a.key.cmp(&b.key));
            v
        },
        since: conn.query_row("SELECT MIN(at) FROM ai_usage", [], |r| r.get(0))?,
    })
}

#[tauri::command]
pub fn usage_summary(app: AppHandle, db: State<'_, StudyDb>) -> Result<Summary, String> {
    with_db(&app, &db, summary)
}

#[tauri::command]
pub fn usage_reset(app: AppHandle, db: State<'_, StudyDb>) -> Result<(), String> {
    with_db(&app, &db, |c| c.execute("DELETE FROM ai_usage", []).map(|_| ()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peak_hours_and_costs() {
        // 2026-09-21 is a Monday. 02:00 UTC is peak, 12:00 UTC is not; Saturday never is.
        let monday = 1_789_948_800_000_i64; // 2026-09-21T00:00:00Z
        assert!(is_peak(monday + 2 * 3_600_000));
        assert!(!is_peak(monday + 12 * 3_600_000));
        assert!(!is_peak(monday - 2 * 86_400_000 + 2 * 3_600_000));
        let off = cost("deepseek-flash", 1_000_000, 1_000_000, 1_000_000, monday + 12 * 3_600_000, None);
        assert!((off - 0.753).abs() < 1e-9);
        assert!((cost("deepseek-flash", 0, 0, 1_000_000, monday + 2 * 3_600_000, None) - 1.2).abs() < 1e-9);
    }

    #[test]
    fn records_and_summarises_by_feature() {
        let c = Connection::open_in_memory().unwrap();
        super::super::prepare(&c).unwrap();
        let u = serde_json::json!({"prompt_tokens": 1000, "prompt_cache_hit_tokens": 400, "completion_tokens": 200});
        record(&c, "deepseek-flash", "chat", &u, None).unwrap();
        record(&c, "deepseek-flash", "chat", &u, None).unwrap();
        record(&c, "deepseek-v4-pro", "solver", &u, None).unwrap();
        record(&c, "deepseek-flash", "chat", &serde_json::json!({}), None).unwrap();
        let s = summary(&c).unwrap();
        assert_eq!((s.total.calls, s.total.tokens), (3, 3600));
        assert_eq!(s.by_feature[0].key, "solver", "pro costs more, so it sorts first");
        assert_eq!(s.by_feature.iter().find(|b| b.key == "chat").unwrap().calls, 2);
        assert_eq!(s.by_day.len(), 1);
    }

    #[test]
    fn a_catalogue_price_and_openai_style_cache_counts() {
        // 1M cached at 0.1, 1M fresh at 1, 1M out at 2 → 3.1 USD, no peak doubling.
        let u = serde_json::json!({ "prompt_tokens": 2_000_000, "completion_tokens": 1_000_000, "prompt_tokens_details": { "cached_tokens": 1_000_000 } });
        assert!((cost_of("gpt-x", &u, 0, Some((0.1, 1.0, 2.0))) - 3.1).abs() < 1e-9);
    }
}
