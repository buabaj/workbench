//! Find in files, and replace across them.

use tauri::ipc::Channel;
use tauri::State;

use crate::error::AppError;
use crate::fsx::safe_path::Intent;
use crate::search::{build_matcher, replace_all, search_file, Match, Query};

impl From<crate::search::SearchError> for AppError {
    fn from(e: crate::search::SearchError) -> Self {
        match e {
            crate::search::SearchError::Pattern(m) => AppError::Validation(m),
            crate::search::SearchError::Io(m) => AppError::Io(m),
        }
    }
}

/// Stop before a runaway pattern (`.` on a monorepo) exhausts memory or floods
/// the webview. The frontend says so rather than pretending the list is whole.
const MAX_MATCHES: usize = 5_000;

/// Send results in batches: one IPC message per match makes a common search
/// thousands of messages, which stalls the UI more than the search itself.
const BATCH: usize = 100;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProgress {
    pub matches: Vec<Match>,
    /// Set on the final message.
    pub done: bool,
    /// True when MAX_MATCHES cut the search short.
    pub truncated: bool,
}

/// Search the workspace, streaming matches as they are found.
///
/// Streamed rather than collected because the first result should appear
/// immediately: a large tree otherwise looks like a hang for several seconds.
#[tauri::command]
pub async fn search_run(
    open: State<'_, crate::commands::workspace::OpenWorkspaces>,
    workspace_id: String,
    query: Query,
    channel: Channel<SearchProgress>,
) -> Result<(), AppError> {
    if query.pattern.trim().is_empty() {
        channel
            .send(SearchProgress { matches: Vec::new(), done: true, truncated: false })
            .ok();
        return Ok(());
    }
    let root = crate::commands::workspace::root_for(&open, &workspace_id)?;
    let matcher = build_matcher(&query)?;
    let real = root.real().to_path_buf();

    // Blocking: walking and reading a tree has no async form, and holding a
    // runtime worker on it would stall every other command.
    tokio::task::spawn_blocking(move || {
        let mut batch: Vec<Match> = Vec::with_capacity(BATCH);
        let mut total = 0usize;
        let mut truncated = false;

        let walker = ignore::WalkBuilder::new(&real)
            .hidden(false)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .require_git(false)
            .filter_entry(|e| e.file_name() != ".git")
            .build();

        'outer: for entry in walker.flatten() {
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let path = entry.path();
            let rel = path
                .strip_prefix(&real)
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned();

            let mut hits: Vec<Match> = Vec::new();
            // A single unreadable file must not end the search.
            let _ = search_file(&matcher, path, &rel, |m| hits.push(m));

            for m in hits {
                batch.push(m);
                total += 1;
                if batch.len() >= BATCH {
                    let send = std::mem::take(&mut batch);
                    if channel
                        .send(SearchProgress { matches: send, done: false, truncated: false })
                        .is_err()
                    {
                        return; // panel closed
                    }
                }
                if total >= MAX_MATCHES {
                    truncated = true;
                    break 'outer;
                }
            }
        }
        let _ = channel.send(SearchProgress { matches: batch, done: true, truncated });
    });
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOutcome {
    pub files_changed: usize,
    pub replacements: usize,
}

/// Replace matches across the given files.
///
/// Takes an explicit file list rather than re-running the search: the user
/// acts on the results they were shown, so a file that changed underneath in
/// the meantime cannot be edited on the strength of a stale match.
#[tauri::command]
pub async fn search_replace(
    open: State<'_, crate::commands::workspace::OpenWorkspaces>,
    workspace_id: String,
    query: Query,
    replacement: String,
    rel_paths: Vec<String>,
) -> Result<ReplaceOutcome, AppError> {
    if query.pattern.trim().is_empty() {
        return Err(AppError::Validation("nothing to replace".into()));
    }
    let root = crate::commands::workspace::root_for(&open, &workspace_id)?;
    let matcher = build_matcher(&query)?;

    let mut files_changed = 0usize;
    let mut replacements = 0usize;

    for rel in rel_paths {
        // Through the same guard every write uses: a result row is untrusted
        // input by the time it comes back from the frontend.
        let p = root.resolve(&rel, Intent::Write)?;
        let text = match std::fs::read_to_string(p.abs()) {
            Ok(t) => t,
            Err(_) => continue, // binary or vanished; skip rather than abort
        };
        let before = count_matches(&matcher, &text);
        match replace_all(&matcher, &text, &replacement)? {
            // Unchanged content is not written back, so mtimes stay honest and
            // file watchers do not fire for nothing.
            Some(next) if next != text => {
                std::fs::write(p.abs(), next)?;
                files_changed += 1;
                replacements += before;
            }
            _ => {}
        }
    }
    Ok(ReplaceOutcome { files_changed, replacements })
}

fn count_matches(matcher: &grep_regex::RegexMatcher, text: &str) -> usize {
    use grep_matcher::Matcher;
    let mut n = 0usize;
    let mut at = 0usize;
    let bytes = text.as_bytes();
    while let Ok(Some(m)) = matcher.find_at(bytes, at) {
        n += 1;
        at = if m.end() > m.start() { m.end() } else { m.end() + 1 };
        if at > bytes.len() {
            break;
        }
    }
    n
}
