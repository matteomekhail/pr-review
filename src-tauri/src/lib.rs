use serde::Deserialize;
use std::path::Path;
use std::sync::OnceLock;
use tokio::process::Command;

const QUEUE_FIELDS: &str = r#"
... on PullRequest {
  id number title url isDraft
  createdAt updatedAt additions deletions changedFiles
  headRefName baseRefName reviewDecision
  mergeQueueEntry { position state }
  author { login avatarUrl }
  repository { nameWithOwner }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state contexts(first: 100) { nodes { ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login avatarUrl } ... on Team { name combinedSlug } } } }
  reviews(last: 20) { nodes { state submittedAt author { login avatarUrl __typename } } }
  comments(last: 20) { nodes { createdAt author { login avatarUrl __typename } } }
}"#;

const MAX_MERGE_STATE_IDS: usize = 25;

const MAX_DIFF_FALLBACK_FILES: usize = 3000;
const GH_TIMEOUT_SECS: u64 = 45;
const SYSTEM_ONE_URL: &str = "https://api.typesafe.ai/v1/systemone";
const MAX_READINESS_STATE_BYTES: usize = 600_000;

static TYPESAFE_KEY: OnceLock<Option<String>> = OnceLock::new();

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum QueueKind {
    Review,
    Mine,
    Involved,
    Reviewed,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum MergeMethod {
    Squash,
    Merge,
    Rebase,
}

#[derive(Deserialize)]
struct PullFile {
    filename: String,
    previous_filename: Option<String>,
    status: String,
    patch: Option<String>,
}

fn gh_binary() -> &'static str {
    ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]
        .into_iter()
        .find(|candidate| Path::new(candidate).exists())
        .unwrap_or("gh")
}

async fn gh(args: &[&str]) -> Result<String, String> {
    let child = Command::new(gh_binary())
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(std::time::Duration::from_secs(GH_TIMEOUT_SECS), child)
        .await
        .map_err(|_| format!("gh timed out after {GH_TIMEOUT_SECS}s"))?
        .map_err(|error| format!("could not run gh: {error}"))?;
    if output.status.success() {
        return String::from_utf8(output.stdout).map_err(|error| error.to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let message = if stderr.is_empty() { format!("gh exited with {}", output.status) } else { stderr };
    eprintln!("[gh] {} -> {}", args.iter().take(3).cloned().collect::<Vec<_>>().join(" "), message.lines().next().unwrap_or(""));
    Err(message)
}

fn is_safe_segment(segment: &str) -> bool {
    !segment.is_empty()
        && !segment.starts_with('-')
        && segment.len() <= 100
        && segment.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.'))
}

fn validate_repo(repo: &str) -> Result<(), String> {
    match repo.split_once('/') {
        Some((owner, name)) if is_safe_segment(owner) && is_safe_segment(name) => Ok(()),
        _ => Err(format!("invalid repository: {repo}")),
    }
}

fn search_query(kind: QueueKind) -> &'static str {
    match kind {
        QueueKind::Review => "is:pr is:open archived:false review-requested:@me sort:updated-desc",
        QueueKind::Mine => "is:pr is:open archived:false author:@me sort:updated-desc",
        QueueKind::Involved => "is:pr is:open archived:false involves:@me sort:updated-desc",
        QueueKind::Reviewed => "is:pr is:open archived:false reviewed-by:@me -author:@me sort:updated-desc",
    }
}

/// PRs per search page. GitHub aborts GraphQL queries after about 10s; with review activity and check runs per PR,
/// a 100-PR page runs past that, while 25 stays near 4s (and costs 1 point).
const QUEUE_PAGE_SIZE: u64 = 25;
/// GitHub search never returns more than this many results.
const MAX_SEARCH_RESULTS: u64 = 1_000;
const SEARCH_PAGE_CONCURRENCY: usize = 6;

fn base64(input: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.as_bytes().chunks(3) {
        let bits = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..4 {
            encoded.push(if index <= chunk.len() { char::from(ALPHABET[(bits >> (18 - 6 * index)) as usize & 63]) } else { '=' });
        }
    }
    encoded
}

/// GitHub search cursors are base64 `cursor:<offset>`.
fn search_cursor(offset: u64) -> String {
    base64(&format!("cursor:{offset}"))
}

async fn search_page(query: &str, q: &str, after: Option<&str>) -> Result<serde_json::Value, String> {
    let mut args = vec!["api".to_string(), "graphql".to_string(), "-f".to_string(), format!("query={query}"), "-f".to_string(), format!("q={q}")];
    if let Some(cursor) = after {
        args.push("-f".to_string());
        args.push(format!("endCursor={cursor}"));
    }
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let page: serde_json::Value = serde_json::from_str(&gh(&borrowed).await?).map_err(|error| error.to_string())?;
    if page["data"]["search"].is_null() {
        let message = page["errors"][0]["message"].as_str().unwrap_or("Empty response");
        return Err(message.to_string());
    }
    Ok(page)
}

fn spawn_page(query: &str, q: &str, offset: u64) -> tauri::async_runtime::JoinHandle<Result<serde_json::Value, String>> {
    let (query, q, cursor) = (query.to_string(), q.to_string(), search_cursor(offset));
    tauri::async_runtime::spawn(async move { search_page(&query, &q, Some(&cursor)).await })
}

async fn join_pages(handles: Vec<tauri::async_runtime::JoinHandle<Result<serde_json::Value, String>>>) -> Result<Vec<serde_json::Value>, String> {
    let mut pages = Vec::with_capacity(handles.len());
    for handle in handles {
        pages.push(handle.await.map_err(|error| error.to_string())??);
    }
    Ok(pages)
}

/// Every page of a search. `expected` is how many results it had last time: that many pages are asked for at once,
/// beside the first, then any the search has since grown by. This leans on GitHub's cursors being base64
/// `cursor:<offset>`; when the first page's cursor is not, the guesses are dropped and pages follow `endCursor`.
async fn search_pages(query: String, q: String, expected: u64) -> Result<Vec<serde_json::Value>, String> {
    let guessed: Vec<u64> = (1..SEARCH_PAGE_CONCURRENCY as u64).map(|page| page * QUEUE_PAGE_SIZE).take_while(|offset| *offset < expected.min(MAX_SEARCH_RESULTS)).collect();
    let speculative: Vec<_> = guessed.iter().map(|offset| spawn_page(&query, &q, *offset)).collect();
    let first = search_page(&query, &q, None).await?;
    let info = &first["data"]["search"];
    let has_next = info["pageInfo"]["hasNextPage"].as_bool().unwrap_or(false);
    let end_cursor = info["pageInfo"]["endCursor"].as_str().map(str::to_string);
    let total = info["issueCount"].as_u64().unwrap_or(0).min(MAX_SEARCH_RESULTS);
    let mut pages = vec![first];
    if !has_next {
        return Ok(pages);
    }
    if end_cursor.as_deref() == Some(search_cursor(QUEUE_PAGE_SIZE).as_str()) {
        pages.extend(join_pages(speculative).await?.into_iter().zip(&guessed).filter(|(_, offset)| **offset < total).map(|(page, _)| page));
        let offsets: Vec<u64> = (1..).map(|page| page * QUEUE_PAGE_SIZE).take_while(|offset| *offset < total).filter(|offset| !guessed.contains(offset)).collect();
        for batch in offsets.chunks(SEARCH_PAGE_CONCURRENCY) {
            pages.extend(join_pages(batch.iter().map(|offset| spawn_page(&query, &q, *offset)).collect()).await?);
        }
        return Ok(pages);
    }
    speculative.iter().for_each(|handle| handle.abort());
    let mut cursor = end_cursor;
    while let Some(after) = cursor {
        let page = search_page(&query, &q, Some(&after)).await?;
        let info = &page["data"]["search"]["pageInfo"];
        cursor = if info["hasNextPage"].as_bool().unwrap_or(false) { info["endCursor"].as_str().map(str::to_string) } else { None };
        pages.push(page);
    }
    Ok(pages)
}

#[tauri::command]
async fn queue(kind: QueueKind, expected: Option<u64>) -> Result<String, String> {
    let query = format!(
        "query($q: String!, $endCursor: String) {{ search(query: $q, type: ISSUE, first: {QUEUE_PAGE_SIZE}, after: $endCursor) {{ issueCount pageInfo {{ hasNextPage endCursor }} nodes {{ {QUEUE_FIELDS} }} }} }}"
    );
    let pages = search_pages(query, search_query(kind).to_string(), expected.unwrap_or(0)).await?;
    serde_json::to_string(&pages).map_err(|error| error.to_string())
}

fn is_node_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '='))
}

async fn nodes_query(query: &str, ids: &[String]) -> Result<String, String> {
    if ids.is_empty() || ids.len() > MAX_MERGE_STATE_IDS || !ids.iter().all(|id| is_node_id(id)) {
        return Err("invalid pull request ids".to_string());
    }
    let mut args: Vec<String> = vec!["api".into(), "graphql".into(), "-f".into(), format!("query={query}")];
    for id in ids {
        args.push("-f".into());
        args.push(format!("ids[]={id}"));
    }
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    gh(&borrowed).await
}

#[tauri::command]
async fn merge_states(ids: Vec<String>) -> Result<String, String> {
    nodes_query("query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest { id mergeable mergeStateStatus } } }", &ids).await
}

/// The same fields as a queue row, for a few pull requests by id: how one PR refreshes without its whole queue.
#[tauri::command]
async fn pulls(ids: Vec<String>) -> Result<String, String> {
    nodes_query(&format!("query($ids: [ID!]!) {{ nodes(ids: $ids) {{ {QUEUE_FIELDS} }} }}"), &ids).await
}

#[tauri::command]
async fn conversation(repo: String, number: u64) -> Result<String, String> {
    validate_repo(&repo)?;
    let (owner, name) = repo.split_once('/').ok_or("invalid repository")?;
    let query = "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { comments(last: 50) { totalCount nodes { id bodyHTML createdAt url author { login avatarUrl __typename } } } reviews(last: 30) { totalCount nodes { id state bodyHTML submittedAt url author { login avatarUrl __typename } comments { totalCount } } } } } }";
    gh(&[
        "api", "graphql",
        "-f", &format!("query={query}"),
        "-F", &format!("owner={owner}"),
        "-F", &format!("name={name}"),
        "-F", &format!("number={number}"),
    ])
    .await
}

#[tauri::command]
async fn body(repo: String, number: u64) -> Result<String, String> {
    validate_repo(&repo)?;
    let (owner, name) = repo.split_once('/').ok_or("invalid repository")?;
    let query = "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { bodyHTML } } }";
    gh(&[
        "api", "graphql",
        "-f", &format!("query={query}"),
        "-F", &format!("owner={owner}"),
        "-F", &format!("name={name}"),
        "-F", &format!("number={number}"),
        "--jq", ".data.repository.pullRequest.bodyHTML",
    ])
    .await
}

#[tauri::command]
async fn diff(repo: String, number: u64) -> Result<String, String> {
    validate_repo(&repo)?;
    let path = format!("repos/{repo}/pulls/{number}");
    match gh(&["api", &path, "-H", "Accept: application/vnd.github.v3.diff"]).await {
        Ok(patch) => Ok(patch),
        Err(error) if error.contains("too_large") || error.contains("406") || error.contains("exceeded") => {
            diff_from_files(&repo, number).await
        }
        Err(error) => Err(error),
    }
}

async fn diff_from_files(repo: &str, number: u64) -> Result<String, String> {
    let path = format!("repos/{repo}/pulls/{number}/files?per_page=100");
    let raw = gh(&["api", "--paginate", "--slurp", &path]).await?;
    let pages: Vec<Vec<PullFile>> = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let patch = pages
        .into_iter()
        .flatten()
        .take(MAX_DIFF_FALLBACK_FILES)
        .map(|file| file_patch(&file))
        .collect::<Vec<_>>()
        .join("");
    Ok(patch)
}

fn file_patch(file: &PullFile) -> String {
    let old_name = file.previous_filename.as_deref().unwrap_or(&file.filename);
    let (old_path, new_path) = match file.status.as_str() {
        "added" => ("/dev/null".to_string(), format!("b/{}", file.filename)),
        "removed" => (format!("a/{old_name}"), "/dev/null".to_string()),
        _ => (format!("a/{old_name}"), format!("b/{}", file.filename)),
    };
    let body = file.patch.as_deref().unwrap_or("");
    let rename = if file.status == "renamed" {
        format!("rename from {old_name}\nrename to {}\n", file.filename)
    } else {
        String::new()
    };
    let hunks = if body.is_empty() { String::new() } else { format!("--- {old_path}\n+++ {new_path}\n{body}\n") };
    format!("diff --git a/{old_name} b/{}\n{rename}{hunks}", file.filename)
}

#[tauri::command]
async fn approve(repo: String, number: u64) -> Result<String, String> {
    validate_repo(&repo)?;
    gh(&["pr", "review", &number.to_string(), "-R", &repo, "--approve"]).await
}

const MAX_COMMENT_BYTES: usize = 65_000;

#[tauri::command]
async fn comment(repo: String, number: u64, body: String) -> Result<String, String> {
    validate_repo(&repo)?;
    if body.trim().is_empty() || body.len() > MAX_COMMENT_BYTES {
        return Err("comment must be between 1 and 65000 bytes".to_string());
    }
    let path = format!("repos/{repo}/issues/{number}/comments");
    gh(&["api", &path, "-X", "POST", "-f", &format!("body={body}"), "--jq", ".html_url"]).await.map(|url| url.trim().to_string())
}

#[tauri::command]
async fn viewer() -> Result<String, String> {
    gh(&["api", "user", "--jq", ".login"]).await.map(|login| login.trim().to_string())
}

/// Teams I belong to, one `org/slug` per line, to tell team review requests from ones addressed to me.
#[tauri::command]
async fn viewer_teams() -> Result<String, String> {
    gh(&["api", "user/teams", "--paginate", "--jq", ".[] | .organization.login + \"/\" + .slug"]).await
}

#[tauri::command]
async fn merge_queue(repo: String, base: String) -> Result<String, String> {
    validate_repo(&repo)?;
    if base.is_empty() || base.len() > 255 || base.starts_with('-') || base.chars().any(|character| character.is_whitespace() || character.is_control()) {
        return Err("invalid base branch".to_string());
    }
    let (owner, name) = repo.split_once('/').ok_or("invalid repository")?;
    let query = "query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { mergeQueue(branch: $branch) { url configuration { mergeMethod } } } }";
    gh(&[
        "api", "graphql",
        "-f", &format!("query={query}"),
        "-F", &format!("owner={owner}"),
        "-F", &format!("name={name}"),
        "-f", &format!("branch={base}"),
    ])
    .await
}

#[tauri::command]
async fn merge(repo: String, number: u64, method: MergeMethod, queued: bool, node_id: Option<String>) -> Result<String, String> {
    validate_repo(&repo)?;
    let number = number.to_string();
    if queued {
        let id = node_id.filter(|id| is_node_id(id)).ok_or("missing pull request id")?;
        let mutation = "mutation($id: ID!) { enqueuePullRequest(input: { pullRequestId: $id }) { mergeQueueEntry { position state } } }";
        let output = gh(&["api", "graphql", "-f", &format!("query={mutation}"), "-f", &format!("id={id}")]).await?;
        let parsed: serde_json::Value = serde_json::from_str(&output).map_err(|error| error.to_string())?;
        if let Some(message) = parsed["errors"][0]["message"].as_str() {
            return Err(message.to_string());
        }
        let position = parsed["data"]["enqueuePullRequest"]["mergeQueueEntry"]["position"].as_i64();
        return Ok(match position {
            Some(position) => format!("#{number} queued at position {}", position + 1),
            None => format!("#{number} added to the merge queue"),
        });
    }
    let flag = match method {
        MergeMethod::Squash => "--squash",
        MergeMethod::Merge => "--merge",
        MergeMethod::Rebase => "--rebase",
    };
    let output = gh(&["pr", "merge", &number, "-R", &repo, flag]).await?;
    Ok(if output.trim().is_empty() { "Merge requested".to_string() } else { output })
}

fn usable_key(key: &str) -> Option<String> {
    let key = key.trim();
    (!key.is_empty() && !key.contains(char::is_whitespace)).then(|| key.to_string())
}

/// TypeSafe API key: the environment, then the macOS Keychain (service `TYPESAFE_API_KEY`), then the login shell.
fn resolve_typesafe_key() -> Option<String> {
    if let Some(key) = std::env::var("TYPESAFE_API_KEY").ok().as_deref().and_then(usable_key) {
        return Some(key);
    }
    let keychain = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "TYPESAFE_API_KEY", "-w"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    if let Some(key) = keychain.ok().filter(|output| output.status.success()).and_then(|output| String::from_utf8(output.stdout).ok()).as_deref().and_then(usable_key) {
        return Some(key);
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = std::process::Command::new(shell)
        .args(["-l", "-i", "-c", "printf %s \"$TYPESAFE_API_KEY\""])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    usable_key(&String::from_utf8(output.stdout).ok()?)
}

fn typesafe_key() -> Option<&'static str> {
    TYPESAFE_KEY.get_or_init(resolve_typesafe_key).as_deref()
}

#[tauri::command]
async fn review_context(repo: String, number: u64) -> Result<String, String> {
    validate_repo(&repo)?;
    let (owner, name) = repo.split_once('/').ok_or("invalid repository")?;
    let query = "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { body files(first: 100) { totalCount nodes { path additions deletions } } reviews(last: 20) { nodes { state bodyText author { login __typename } } } comments(last: 25) { nodes { bodyText author { login __typename } } } reviewThreads(last: 100) { nodes { isResolved isOutdated } } } } }";
    gh(&[
        "api", "graphql",
        "-f", &format!("query={query}"),
        "-F", &format!("owner={owner}"),
        "-F", &format!("name={name}"),
        "-F", &format!("number={number}"),
    ])
    .await
}

#[tauri::command]
async fn readiness_available() -> bool {
    tauri::async_runtime::spawn_blocking(|| typesafe_key().is_some()).await.unwrap_or(false)
}

#[tauri::command]
async fn readiness(request: String) -> Result<String, String> {
    if request.len() > MAX_READINESS_STATE_BYTES {
        return Err("readiness request too large".to_string());
    }
    let key = tauri::async_runtime::spawn_blocking(typesafe_key)
        .await
        .map_err(|error| error.to_string())?
        .ok_or("TYPESAFE_API_KEY not configured")?;
    let response = http_client()
        .post(SYSTEM_ONE_URL)
        .bearer_auth(key)
        .header("Content-Type", "application/json")
        .body(request)
        .send()
        .await
        .map_err(|error| error.without_url().to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|error| error.without_url().to_string())?;
    if status.is_success() {
        return Ok(text);
    }
    Err(format!("Jev {status}: {}", text.chars().take(300).collect::<String>()))
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("http client")
    })
}

#[tauri::command]
async fn open_in_browser(url: String) -> Result<(), String> {
    let is_safe = url.starts_with("https://")
        && url.len() <= 4_096
        && !url.chars().any(|character| character.is_whitespace() || character.is_control());
    if !is_safe {
        return Err("only https links can be opened".to_string());
    }
    let chrome = Command::new("/usr/bin/open").args(["-b", "com.google.Chrome", "--", &url]).status().await;
    if matches!(chrome, Ok(status) if status.success()) {
        return Ok(());
    }
    let fallback = Command::new("/usr/bin/open").args(["--", &url]).status().await.map_err(|error| error.to_string())?;
    if fallback.success() { Ok(()) } else { Err(format!("could not open {url}")) }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![queue, pulls, viewer, viewer_teams, comment, merge_queue, merge_states, conversation, body, diff, approve, merge, open_in_browser, review_context, readiness_available, readiness])
        .run(tauri::generate_context!())
        .expect("error while running PR Review");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_cursors_match_github() {
        assert_eq!(search_cursor(25), "Y3Vyc29yOjI1");
        assert_eq!(base64("a"), "YQ==");
        assert_eq!(base64("ab"), "YWI=");
        assert_eq!(base64("abc"), "YWJj");
    }
}
