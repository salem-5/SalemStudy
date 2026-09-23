//! Web search and page reading for the chats.
//!
//! Search goes through DuckDuckGo's HTML endpoint, which needs no API key, and
//! the results are parsed with plain string scanning (no HTML crate). Reading a
//! page strips the markup down to the readable text the model can use.
//!
//! Both refuse private/loopback hosts, like `fetch_image_any`, so a crafted
//! page or question cannot turn the app into a local-network probe.

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::{is_private_host, AppState};

const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

// ---------------------------------------------------------------------------
// Small HTML helpers
// ---------------------------------------------------------------------------

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let hex = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => match (hex(b[i + 1]), hex(b[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h << 4 | l);
                    i += 3;
                }
                _ => {
                    out.push(b[i]);
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The handful of entities that actually show up in page text.
pub fn unescape_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let end = tail.find(';').filter(|e| *e <= 10);
        let Some(end) = end else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let name = &tail[1..end];
        let replacement = match name {
            "amp" => Some("&".to_string()),
            "lt" => Some("<".to_string()),
            "gt" => Some(">".to_string()),
            "quot" => Some("\"".to_string()),
            "apos" | "#39" => Some("'".to_string()),
            "nbsp" => Some(" ".to_string()),
            "hellip" => Some("…".to_string()),
            "mdash" => Some("—".to_string()),
            "ndash" => Some("–".to_string()),
            _ => name
                .strip_prefix('#')
                .and_then(|n| {
                    if let Some(h) = n.strip_prefix('x').or_else(|| n.strip_prefix('X')) {
                        u32::from_str_radix(h, 16).ok()
                    } else {
                        n.parse::<u32>().ok()
                    }
                })
                .and_then(char::from_u32)
                .map(String::from),
        };
        match replacement {
            Some(r) => {
                out.push_str(&r);
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Drop every tag, and the whole of `<script>`/`<style>`/`<svg>`, leaving the
/// text with block elements turned into line breaks.
pub fn html_to_text(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len() / 2);
    let bytes = html.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            let next = html[i..].find('<').map_or(bytes.len(), |n| i + n);
            out.push_str(&html[i..next]);
            i = next;
            continue;
        }
        let Some(close) = html[i..].find('>').map(|n| i + n) else { break };
        let tag = &lower[i + 1..close];
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        if matches!(name.as_str(), "script" | "style" | "svg" | "noscript" | "head") && !tag.starts_with('/') {
            let end_tag = format!("</{name}");
            match lower[close..].find(&end_tag) {
                Some(n) => {
                    let from = close + n;
                    i = lower[from..].find('>').map_or(bytes.len(), |m| from + m + 1);
                }
                None => i = bytes.len(),
            }
            continue;
        }
        if matches!(
            name.as_str(),
            "p" | "br" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "section" | "article" | "header" | "footer" | "blockquote" | "pre" | "table"
        ) {
            out.push('\n');
        } else if matches!(name.as_str(), "td" | "th") {
            out.push('\t');
        }
        i = close + 1;
    }
    let text = unescape_entities(&out);
    // Collapse runs of blank lines and trailing spaces; keep paragraph breaks.
    let mut lines: Vec<String> = Vec::new();
    for raw in text.lines() {
        let line = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            if lines.last().map_or(true, |l: &String| l.is_empty()) {
                continue;
            }
            lines.push(String::new());
        } else {
            lines.push(line);
        }
    }
    lines.join("\n").trim().to_string()
}

fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let key = format!("{name}=\"");
    let at = lower.find(&key)? + key.len();
    let end = tag[at..].find('"')? + at;
    Some(&tag[at..end])
}

/// A DuckDuckGo redirect (`//duckduckgo.com/l/?uddg=…`) unwrapped to the real URL.
fn real_url(href: &str) -> Option<String> {
    let href = unescape_entities(href);
    if let Some(at) = href.find("uddg=") {
        let rest = &href[at + 5..];
        let end = rest.find('&').unwrap_or(rest.len());
        let url = percent_decode(&rest[..end]);
        return url.starts_with("http").then_some(url);
    }
    if href.starts_with("http") {
        return Some(href);
    }
    if let Some(rest) = href.strip_prefix("//") {
        return Some(format!("https://{rest}"));
    }
    None
}

/// Pull `{title, url, snippet}` triples out of DuckDuckGo's HTML results page.
pub fn parse_results(html: &str, limit: usize) -> Vec<SearchResult> {
    let mut out: Vec<SearchResult> = Vec::new();
    let lower = html.to_ascii_lowercase();
    let mut i = 0;
    // Each result is a `result__a` link followed by a `result__snippet` block.
    while out.len() < limit {
        let Some(at) = lower[i..].find("result__a").map(|n| i + n) else { break };
        let Some(open) = lower[..at].rfind('<') else { break };
        let Some(close) = html[open..].find('>').map(|n| n + open) else { break };
        let tag = &html[open..=close];
        i = close + 1;
        let Some(url) = attr(tag, "href").and_then(real_url) else { continue };
        let Some(end) = lower[close..].find("</a>").map(|n| n + close) else { continue };
        let title = html_to_text(&html[close + 1..end]);
        if title.is_empty() {
            continue;
        }
        let snippet = lower[end..]
            .find("result__snippet")
            .map(|n| n + end)
            .and_then(|s| {
                let body = html[s..].find('>')? + s + 1;
                let stop = lower[body..].find("</a>").map(|n| n + body)?;
                Some(html_to_text(&html[body..stop]))
            })
            .unwrap_or_default();
        if out.iter().any(|r| r.url == url) {
            continue;
        }
        out.push(SearchResult { title, url, snippet });
    }
    out
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Search, as both the `web_search` command and the Salem tool of the same
/// name use it. Taking the client rather than the whole app state is what lets
/// the AI runtime call it without going through the webview.
pub async fn search(http: &reqwest::Client, query: String, count: Option<usize>) -> Result<Vec<SearchResult>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("empty search".into());
    }
    let limit = count.unwrap_or(6).clamp(1, 15);
    let resp = http
        .post("https://html.duckduckgo.com/html/")
        .header(reqwest::header::USER_AGENT, UA)
        .form(&[("q", q), ("kl", "wt-wt")])
        .send()
        .await
        .map_err(|e| format!("search failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("search failed: HTTP {}", resp.status()));
    }
    let body = resp.text().await.map_err(|e| format!("search failed: {e}"))?;
    let hits = parse_results(&body, limit);
    if hits.is_empty() {
        return Err("no results".into());
    }
    Ok(hits)
}

/// Read a page down to its text, for the `web_fetch` command and the Salem
/// tool of the same name.
pub async fn fetch(http: &reqwest::Client, url: String, max_chars: Option<usize>) -> Result<Value, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|e| format!("bad url: {e}"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("only http(s) pages can be read".into());
    }
    if is_private_host(parsed.host_str().unwrap_or("")) {
        return Err("refusing to fetch a private address".into());
    }
    let resp = http
        .get(parsed.clone())
        .header(reqwest::header::USER_AGENT, UA)
        .send()
        .await
        .map_err(|e| format!("could not open the page: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let final_url = resp.url().to_string();
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("text/html")
        .split(';')
        .next()
        .unwrap_or("text/html")
        .trim()
        .to_ascii_lowercase();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_PAGE_BYTES {
        return Err("that page is too large to read".into());
    }
    let body = String::from_utf8_lossy(&bytes);
    if !mime.starts_with("text/") && !mime.contains("html") && !mime.contains("xml") && !mime.contains("json") {
        return Err(format!("that link is a {mime} file, not a web page"));
    }
    let title = body
        .to_ascii_lowercase()
        .find("<title")
        .and_then(|at| {
            let open = body[at..].find('>')? + at + 1;
            let end = body.to_ascii_lowercase()[open..].find("</title>")? + open;
            Some(html_to_text(&body[open..end]))
        })
        .unwrap_or_default();
    let text = if mime.contains("html") || mime.contains("xml") { html_to_text(&body) } else { body.to_string() };
    let cap = max_chars.unwrap_or(12_000).clamp(500, 60_000);
    let truncated = text.chars().count() > cap;
    let text: String = text.chars().take(cap).collect();
    Ok(serde_json::json!({ "url": final_url, "title": title, "text": text, "truncated": truncated }))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn web_search(state: State<'_, AppState>, query: String, count: Option<usize>) -> Result<Vec<SearchResult>, String> {
    search(&state.http, query, count).await
}

#[tauri::command]
pub async fn web_fetch(state: State<'_, AppState>, url: String, max_chars: Option<usize>) -> Result<Value, String> {
    fetch(&state.http, url, max_chars).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_markup_scripts_and_entities() {
        let html = "<html><head><title>T</title></head><body><script>var a = 1 < 2;</script><h1>Cell &amp; Wall</h1><p>Line one</p><p>Line&nbsp;two &#8212; end</p></body></html>";
        // Block elements keep their paragraph break; runs of them collapse to one.
        assert_eq!(html_to_text(html), "Cell & Wall\n\nLine one\n\nLine two — end");
    }

    #[test]
    fn unwraps_duckduckgo_links_and_snippets() {
        let html = r##"
          <div class="result">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FGolgi&amp;rut=x">Golgi apparatus</a>
            <a class="result__snippet" href="#">The <b>Golgi</b> packages proteins.</a>
          </div>
          <div class="result">
            <a class="result__a" href="https://example.com/a">Second</a>
          </div>"##;
        let hits = parse_results(html, 5);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "https://en.wikipedia.org/wiki/Golgi");
        assert_eq!(hits[0].title, "Golgi apparatus");
        assert_eq!(hits[0].snippet, "The Golgi packages proteins.");
        assert_eq!(hits[1].url, "https://example.com/a");
        assert_eq!(parse_results(html, 1).len(), 1);
    }

    #[test]
    fn ignores_results_without_a_usable_link() {
        assert!(parse_results(r#"<a class="result__a" href="/ads">Ad</a>"#, 5).is_empty());
    }
}
