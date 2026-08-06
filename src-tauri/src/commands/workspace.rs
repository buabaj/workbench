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
                    "UPDATE workspaces SET last_opened_at = ?1, kind = ?2 WHERE id = ?3",
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

fn root_for<'a>(
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
