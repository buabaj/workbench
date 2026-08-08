use std::collections::HashMap;
use std::sync::Mutex;

use rusqlite::OptionalExtension;
use tauri::State;
use unicode_normalization::UnicodeNormalization;

use crate::db::now_ms;
use crate::error::AppError;
use crate::fsx::safe_path::{Intent, PathError, WorkspaceRoot};
use crate::fsx::walker::TreeNode;
use crate::fsx::watcher::WorkspaceWatcher;
use crate::fsx::{ops, walker};
use crate::AppState;

/// Open workspaces: root handles + watchers, keyed by workspace id.
#[derive(Default)]
pub struct OpenWorkspaces {
    pub roots: Mutex<HashMap<String, WorkspaceRoot>>,
    pub watchers: Mutex<HashMap<String, WorkspaceWatcher>>,
    /// Cached relative paths for fuzzy open. Rebuilt on demand; the watcher
    /// invalidates it so a new file shows up in ⌘P without a restart.
    pub index: Mutex<HashMap<String, Vec<String>>>,
}

impl From<PathError> for AppError {
    fn from(e: PathError) -> Self {
        match e {
            PathError::GitInternal | PathError::Escapes | PathError::Absolute => {
                AppError::Validation(format!("path rejected: {e}"))
            }
            PathError::Io(m) => AppError::Io(crate::secret::redact(&m)),
            other => AppError::Validation(other.to_string()),
        }
    }
}

impl From<ops::FsOpError> for AppError {
    fn from(e: ops::FsOpError) -> Self {
        match e {
            ops::FsOpError::NotFound => AppError::NotFound("file".into()),
            ops::FsOpError::Conflict { disk_hash } => AppError::FileConflict { disk_hash },
            ops::FsOpError::Binary => AppError::Validation("file is binary".into()),
            ops::FsOpError::TooLarge { size, limit } => {
                AppError::Validation(format!("file too large ({size} > {limit} bytes)"))
            }
            ops::FsOpError::Io(m) => AppError::Io(crate::secret::redact(&m)),
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceView {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub kind: String,
}

fn open_at(
    state: &State<'_, AppState>,
    open: &State<'_, OpenWorkspaces>,
    app: &tauri::AppHandle,
    path: &str,
) -> Result<WorkspaceView, AppError> {
    let root = WorkspaceRoot::open(std::path::Path::new(path))
        .map_err(|e| AppError::Validation(format!("cannot open workspace: {e}")))?;
    let real: String = root.real().to_string_lossy().nfc().collect();
    let kind = if root.real().join(".git").exists() { "git" } else { "plain" };
    let name = root
        .real()
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "workspace".into());

    let id = {
        let conn = state.db.lock().expect("db lock");
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM workspaces WHERE root_real = ?1",
                [&real],
                |r| r.get(0),
            )
            .optional()?;
        match existing {
            Some(id) => {
                conn.execute(
                    // Opening a forgotten workspace un-forgets it: the list is
                    // "where I work", and you just showed it still is.
                    "UPDATE workspaces SET last_opened_at = ?1, kind = ?2, forgotten_at = NULL
                       WHERE id = ?3",
                    rusqlite::params![now_ms(), kind, id],
                )?;
                id
            }
            None => {
                let id = ulid::Ulid::new().to_string();
                conn.execute(
                    "INSERT INTO workspaces (id, name, root_path, root_real, kind, created_at, last_opened_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                    rusqlite::params![id, name, path, real, kind, now_ms()],
                )?;
                id
            }
        }
    };

    // Start (or restart) the watcher.
    if let Ok(w) = WorkspaceWatcher::start(app.clone(), id.clone(), root.real().to_path_buf()) {
        open.watchers.lock().unwrap().insert(id.clone(), w);
    }
    open.roots.lock().unwrap().insert(id.clone(), root);

    Ok(WorkspaceView {
        id,
        name,
        root_path: real,
        kind: kind.into(),
    })
}

#[tauri::command]
pub fn workspace_open(
    state: State<'_, AppState>,
    open: State<'_, OpenWorkspaces>,
    app: tauri::AppHandle,
    path: String,
) -> Result<WorkspaceView, AppError> {
    open_at(&state, &open, &app, &path)
}

#[tauri::command]
pub async fn workspace_pick(
    state: State<'_, AppState>,
    open: State<'_, OpenWorkspaces>,
    app: tauri::AppHandle,
) -> Result<Option<WorkspaceView>, AppError> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().blocking_pick_folder();
    match picked {
        Some(folder) => {
            let path = folder
                .into_path()
                .map_err(|e| AppError::Io(e.to_string()))?;
            Ok(Some(open_at(&state, &open, &app, &path.to_string_lossy())?))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn workspace_recent(state: State<'_, AppState>) -> Result<Vec<WorkspaceView>, AppError> {
    let conn = state.db.lock().expect("db lock");
    let mut stmt = conn.prepare(
        "SELECT id, name, root_real, kind FROM workspaces
          WHERE forgotten_at IS NULL
          ORDER BY last_opened_at DESC NULLS LAST LIMIT 10",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(WorkspaceView {
                id: r.get(0)?,
                name: r.get(1)?,
                root_path: r.get(2)?,
                kind: r.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub(crate) fn root_for<'a>(
    open: &'a OpenWorkspaces,
    workspace_id: &str,
) -> Result<WorkspaceRoot, AppError> {
    open.roots
        .lock()
        .unwrap()
        .get(workspace_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound("workspace (not open)".into()))
}

#[tauri::command]
pub fn workspace_tree(
    open: State<'_, OpenWorkspaces>,
    workspace_id: String,
    subpath: Option<String>,
) -> Result<Vec<TreeNode>, AppError> {
    let root = root_for(&open, &workspace_id)?;
    Ok(walker::children(&root, subpath.as_deref())?)
}

#[tauri::command]
pub fn file_read(
    open: State<'_, OpenWorkspaces>,
    workspace_id: String,
    path: String,
) -> Result<ops::FileContents, AppError> {
    let root = root_for(&open, &workspace_id)?;
    let p = root.resolve(&path, Intent::Read)?;
    Ok(ops::read(&p)?)
}

#[tauri::command]
pub fn file_stat(
    open: State<'_, OpenWorkspaces>,
    workspace_id: String,
    path: String,
) -> Result<ops::FileStat, AppError> {
    let root = root_for(&open, &workspace_id)?;
    let p = root.resolve(&path, Intent::Read)?;
    Ok(ops::stat(&p)?)
}

#[tauri::command]
pub fn file_write(
    open: State<'_, OpenWorkspaces>,
    workspace_id: String,
    path: String,
    text: String,
    expected_hash: Option<String>,
) -> Result<ops::WriteOutcome, AppError> {
    let root = root_for(&open, &workspace_id)?;
    let p = root.resolve(&path, Intent::Write)?;
    Ok(ops::write(&p, &text, expected_hash.as_deref())?)
}

/// Create an empty file, failing if something is already there.
///
/// Never truncates: `file_write` is how you change a file's contents, and a
/// "new file" that silently emptied an existing one would be a data-loss bug
/// wearing a friendly name. Parent directories are created, so typing
/// `src/api/handlers.rs` in one go works the way it does in an editor.
#[tauri::command]
pub fn file_create(
    open: State<'_, OpenWorkspaces>,
    workspace_id: String,
    path: String,
) -> Result<(), AppError> {
    let root = root_for(&open, &workspace_id)?;
    let p = root.resolve(&path, Intent::Write)?;
    if p.abs().exists() {
        return Err(AppError::Validation("that name is already taken".into()));
    }
    if let Some(parent) = p.abs().parent() {
        std::fs::create_dir_all(parent)?;
    }
    // create_new: the existence check above races, this closes it.
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(p.abs())
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => {
                AppError::Validation("that name is already taken".into())
            }
            _ => AppError::Io(e.to_string()),
        })?;
    Ok(())
}

/// Create a directory, including any missing parents.
#[tauri::command]
pub fn dir_create(
    open: State<'_, OpenWorkspaces>,
    workspace_id: String,
    path: String,
) -> Result<(), AppError> {
    let root = root_for(&open, &workspace_id)?;
    let p = root.resolve(&path, Intent::Write)?;
    if p.abs().exists() {
        return Err(AppError::Validation("that name is already taken".into()));
    }
    std::fs::create_dir_all(p.abs())?;
    Ok(())
}

/// Everything uncommitted in the workspace repository, right now.
///
/// Read-only by design: there is deliberately no stage or commit here. The
/// user does that from the terminal, and a diff panel that could mutate the
/// repository would be a far bigger promise than it appears.
#[tauri::command]
pub fn worktree_changes(
    open: State<'_, OpenWorkspaces>,
    workspace_id: String,
) -> Result<Vec<crate::vcs::worktree::WorktreeChange>, AppError> {
    let root = root_for(&open, &workspace_id)?;
    Ok(crate::vcs::worktree::changes(root.real())?)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDoc {
    pub rel_path: String,
    pub text: String,
}

/// Raw bytes of a workspace file, for things text cannot represent.
///
/// Returned as `Response` so they arrive as an ArrayBuffer rather than a JSON
/// array of numbers — a 10MB PDF would otherwise become tens of megabytes of
/// JSON and stall the webview parsing it.
#[tauri::command]
pub fn file_read_bytes(
    open: State<'_, OpenWorkspaces>,
    workspace_id: String,
    path: String,
) -> Result<tauri::ipc::Response, AppError> {
    const MAX_BYTES: u64 = 128 * 1024 * 1024;
    let root = root_for(&open, &workspace_id)?;
    let p = root.resolve(&path, Intent::Read)?;
    if std::fs::metadata(p.abs()).map(|m| m.len()).unwrap_or(0) > MAX_BYTES {
        return Err(AppError::Validation("that file is too large to open here".into()));
    }
    Ok(tauri::ipc::Response::new(std::fs::read(p.abs())?))
}

/// Proceed with quitting, now that unsaved work has been dealt with.
///
/// The exit handler holds the first attempt and asks the window; this is the
/// answer. Setting the flag before exiting is what stops the handler from
/// preventing its own second attempt and trapping the app open.
#[tauri::command]
pub fn confirm_quit(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), AppError> {
    state
        .quit_confirmed
        .store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

/// Tell the exit handler a dialog is up, so its backstop does not fire.
#[tauri::command]
pub fn quit_ack(state: State<'_, AppState>) -> Result<(), AppError> {
    state
        .quit_acked
        .store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Rename or move a file or directory within the workspace.
///
/// Both paths go through `resolve`, so neither the source nor the destination
/// can point outside the workspace — a rename is a move, and a move is the
/// easiest way to write somewhere you should not.
#[tauri::command]
pub fn path_rename(
    open: State<'_, OpenWorkspaces>,
    workspace_id: String,
    from: String,
    to: String,
) -> Result<(), AppError> {
    let root = root_for(&open, &workspace_id)?;
    let src = root.resolve(&from, Intent::Write)?;
    let dst = root.resolve(&to, Intent::Write)?;
    if !src.abs().exists() {
        return Err(AppError::NotFound("that file no longer exists".into()));
    }
    // Never silently replace: a rename onto an existing name would destroy it,
    // and the caller cannot undo what it did not know it did.
    if dst.abs().exists() {
        return Err(AppError::Validation("something is already called that".into()));
    }
    if let Some(parent) = dst.abs().parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(src.abs(), dst.abs())?;
    Ok(())
}

/// Copy a file beside itself under a new name.
#[tauri::command]
pub fn path_duplicate(
    open: State<'_, OpenWorkspaces>,
    workspace_id: String,
    from: String,
    to: String,
) -> Result<(), AppError> {
    let root = root_for(&open, &workspace_id)?;
    let src = root.resolve(&from, Intent::Read)?;
    let dst = root.resolve(&to, Intent::Write)?;
    if dst.abs().exists() {
        return Err(AppError::Validation("something is already called that".into()));
    }
    if src.abs().is_dir() {
        return Err(AppError::Validation("duplicating a folder is not supported".into()));
    }
    std::fs::copy(src.abs(), dst.abs())?;
    Ok(())
}

/// Move a file or directory to the Trash.
///
/// The Trash rather than an unlink, so a mistake is recoverable in Finder.
/// Deleting work irrecoverably from a context menu is not a thing this should
/// be able to do.
#[tauri::command]
pub fn path_trash(
    open: State<'_, OpenWorkspaces>,
    workspace_id: String,
    path: String,
) -> Result<(), AppError> {
    let root = root_for(&open, &workspace_id)?;
    let p = root.resolve(&path, Intent::Write)?;
    trash::delete(p.abs()).map_err(|e| AppError::Io(e.to_string()))?;
    Ok(())
}

/// Show a path in Finder.
#[tauri::command]
pub fn path_reveal(
    open: State<'_, OpenWorkspaces>,
    workspace_id: String,
    path: String,
) -> Result<(), AppError> {
    let root = root_for(&open, &workspace_id)?;
    let p = root.resolve(&path, Intent::Read)?;
    std::process::Command::new("open")
        .arg("-R")
        .arg(p.abs())
        .spawn()
        .map_err(|e| AppError::Io(e.to_string()))?;
    Ok(())
}

/// Drop a workspace from the recents list, keeping everything it holds.
///
/// A flag rather than a delete. The row is the anchor for that project's
/// conversations, checkpoints and links, all of which cascade — so forgetting
/// a folder must not be a way to lose the work done in it. Opening it again
/// brings it back.
#[tauri::command]
pub fn workspace_forget(state: State<'_, AppState>, workspace_id: String) -> Result<(), AppError> {
    let conn = state.db.lock().expect("db lock");
    conn.execute(
        "UPDATE workspaces SET forgotten_at = ?1 WHERE id = ?2",
        rusqlite::params![crate::db::now_ms(), workspace_id],
    )?;
    Ok(())
}

/// Every markdown note in the workspace, with its text.
///
/// Backlinks need the whole vault at once: you cannot know what links to a
/// note by reading that note. Sending the text lets link resolution stay in
/// one tested place on the frontend rather than being reimplemented here.
///
/// Bounded on both counts — a vault is notes, and a repository that happens to
/// contain a large generated markdown tree should not be able to exhaust
/// memory through this door.
#[tauri::command]
pub fn notes_scan(
    open: State<'_, OpenWorkspaces>,
    workspace_id: String,
) -> Result<Vec<NoteDoc>, AppError> {
    const MAX_NOTES: usize = 5_000;
    const MAX_BYTES: usize = 32 * 1024 * 1024;
    const MAX_NOTE_BYTES: u64 = 2 * 1024 * 1024;

    let root = root_for(&open, &workspace_id)?;
    let real = root.real();
    let mut out = Vec::new();
    let mut total = 0usize;

    let walker = ignore::WalkBuilder::new(real)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build();

    for entry in walker.flatten() {
        if out.len() >= MAX_NOTES || total >= MAX_BYTES {
            break;
        }
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let path = entry.path();
        let is_md = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"));
        if !is_md {
            continue;
        }
        // A single enormous file is skipped rather than truncated: half a note
        // would silently lose the links in its second half.
        if entry.metadata().map(|m| m.len()).unwrap_or(0) > MAX_NOTE_BYTES {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(path) else {
            continue; // unreadable or not UTF-8
        };
        total += text.len();
        out.push(NoteDoc {
            rel_path: path
                .strip_prefix(real)
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned(),
            text,
        });
    }
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
}

/// Branch and upstream state, for the change list's header.
#[tauri::command]
pub fn worktree_branch(
    open: State<'_, OpenWorkspaces>,
    workspace_id: String,
) -> Result<crate::vcs::worktree::BranchState, AppError> {
    let root = root_for(&open, &workspace_id)?;
    Ok(crate::vcs::worktree::branch_state(root.real())?)
}

/// Unified patch for one uncommitted file.
#[tauri::command]
pub fn worktree_patch(
    open: State<'_, OpenWorkspaces>,
    workspace_id: String,
    rel_path: String,
) -> Result<String, AppError> {
    let root = root_for(&open, &workspace_id)?;
    // Through the guard even though this only reads: the path comes from the
    // frontend, and a pathspec is still a path.
    let p = root.resolve(&rel_path, Intent::Read);
    let rel = match p {
        Ok(_) => rel_path,
        // A deleted file cannot be resolved, but its diff is exactly what the
        // user wants to see, so fall back to the literal relative path after
        // rejecting anything that tries to escape.
        Err(_) if !rel_path.contains("..") && !rel_path.starts_with('/') => rel_path,
        Err(e) => return Err(e.into()),
    };
    Ok(crate::vcs::worktree::patch(root.real(), &rel)?)
}

/// Cap the index so a pathological tree can't exhaust memory. 20k paths is far
/// beyond what fuzzy-open stays useful at.
const MAX_INDEXED: usize = 20_000;

/// Every non-ignored file path in the workspace, for fuzzy open. Cached until
/// invalidated by a filesystem change.
#[tauri::command]
pub fn workspace_index(
    open: State<'_, OpenWorkspaces>,
    workspace_id: String,
    refresh: bool,
) -> Result<Vec<String>, AppError> {
    if !refresh {
        if let Some(cached) = open.index.lock().unwrap().get(&workspace_id) {
            return Ok(cached.clone());
        }
    }
    let root = root_for(&open, &workspace_id)?;
    let mut paths = Vec::new();
    let walker = ignore::WalkBuilder::new(root.real())
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build();
    for entry in walker.flatten() {
        if entry.file_type().is_some_and(|t| t.is_dir()) {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root.real()) else {
            continue;
        };
        let rel = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if !rel.is_empty() {
            paths.push(rel);
        }
        if paths.len() >= MAX_INDEXED {
            break;
        }
    }
    paths.sort();
    open.index
        .lock()
        .unwrap()
        .insert(workspace_id, paths.clone());
    Ok(paths)
}

/// Per-workspace settings (layout geometry, open tabs). The table exists from
/// migration 0001; these are the generic accessors.
#[tauri::command]
pub fn workspace_setting_get(
    state: State<'_, AppState>,
    workspace_id: String,
    key: String,
) -> Result<Option<serde_json::Value>, AppError> {
    let conn = state.db.lock().expect("db lock");
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM workspace_settings WHERE workspace_id = ?1 AND key = ?2",
            rusqlite::params![workspace_id, key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw.and_then(|v| serde_json::from_str(&v).ok()))
}

#[tauri::command]
pub fn workspace_setting_set(
    state: State<'_, AppState>,
    workspace_id: String,
    key: String,
    value: serde_json::Value,
) -> Result<(), AppError> {
    let conn = state.db.lock().expect("db lock");
    conn.execute(
        "INSERT INTO workspace_settings (workspace_id, key, value_json) VALUES (?1, ?2, ?3)
         ON CONFLICT(workspace_id, key) DO UPDATE SET value_json = excluded.value_json",
        rusqlite::params![workspace_id, key, serde_json::to_string(&value).unwrap_or_default()],
    )?;
    Ok(())
}
