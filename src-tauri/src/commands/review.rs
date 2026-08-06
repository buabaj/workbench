//! Review commands: whole-task diff, per-file patch, Keep, Restore.
//!
//! Attribution: Workbench's own editor records `user_editor` touches in
//! `file_touches`. A changed file with a user touch is `Both` (the user also
//! edited it) — those are unchecked by default in the restore UI. Files changed
//! with no user touch during the task are `AgentOnly`.

use rusqlite::OptionalExtension;
use tauri::{Manager, State};

use crate::db::now_ms;
use crate::error::AppError;
use crate::vcs::{self, diff, restore, snapshot, VcsError};
use crate::AppState;

impl From<VcsError> for AppError {
    fn from(e: VcsError) -> Self {
        match e {
            VcsError::NotFound => AppError::NotFound("checkpoint".into()),
            VcsError::Refused(m) => AppError::Validation(m),
            other => AppError::Internal(crate::secret::redact(&other.to_string())),
        }
    }
}

struct TaskCtx {
    workspace_id: String,
    root: std::path::PathBuf,
    pre_tree: git2::Oid,
}

fn task_ctx(state: &State<'_, AppState>, task_id: &str) -> Result<TaskCtx, AppError> {
    let conn = state.db.lock().expect("db lock");
    let (workspace_id, root): (String, String) = conn
        .query_row(
            "SELECT t.workspace_id, w.root_real FROM tasks t
               JOIN workspaces w ON w.id = t.workspace_id
              WHERE t.id = ?1",
            [task_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| AppError::NotFound("task".into()))?;
    let tree_hex: String = conn
        .query_row(
            "SELECT tree_oid FROM checkpoints WHERE task_id = ?1 AND kind = 'pre_task'",
            [task_id],
            |r| r.get(0),
        )
        .map_err(|_| AppError::NotFound("pre-task checkpoint".into()))?;
    Ok(TaskCtx {
        workspace_id,
        root: std::path::PathBuf::from(root),
        pre_tree: git2::Oid::from_str(&tree_hex)
            .map_err(|e| AppError::Internal(e.message().to_string()))?,
    })
}

/// Take the pre-task checkpoint. Called by agent_start_task.
pub fn create_pre_task_checkpoint(
    state: &State<'_, AppState>,
    app_data: &std::path::Path,
    workspace_id: &str,
    task_id: &str,
    root: &std::path::Path,
) -> Result<(), AppError> {
    let odb = vcs::open_odb(app_data, workspace_id)?;
    let ref_name = vcs::checkpoint_ref(task_id, "checkpoints");
    let result = snapshot::snapshot(&odb, root, &ref_name, "pre-task checkpoint")?;

    let conn = state.db.lock().expect("db lock");
    conn.execute(
        "INSERT INTO checkpoints (id, workspace_id, task_id, kind, tree_oid, commit_oid,
                                  ref_name, file_count, total_bytes, skipped_json, created_at)
         VALUES (?1, ?2, ?3, 'pre_task', ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            ulid::Ulid::new().to_string(),
            workspace_id,
            task_id,
            result.tree.to_string(),
            result.commit.to_string(),
            ref_name,
            result.file_count as i64,
            result.total_bytes as i64,
            serde_json::to_string(&result.skipped).unwrap_or_else(|_| "[]".into()),
            now_ms()
        ],
    )?;
    Ok(())
}

#[tauri::command]
pub fn review_task_diff(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<diff::TaskDiff, AppError> {
    let ctx = task_ctx(&state, &task_id)?;
    let app_data = app.path().app_local_data_dir().map_err(|e| AppError::Io(e.to_string()))?;
    let odb = vcs::open_odb(&app_data, &ctx.workspace_id)?;

    // Snapshot the current worktree and diff against the pre-task tree.
    let after = snapshot::snapshot(
        &odb,
        &ctx.root,
        &vcs::checkpoint_ref(&task_id, "post"),
        "post-task snapshot",
    )?;
    let mut files = diff::tree_to_tree(&odb, ctx.pre_tree, after.tree)?;

    // Attribution from the user-edit ledger.
    let user_touched: std::collections::HashSet<String> = {
        let conn = state.db.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT DISTINCT rel_path FROM file_touches
              WHERE task_id = ?1 AND origin = 'user_editor'",
        )?;
        let rows: Vec<String> = stmt
            .query_map([&task_id], |r| r.get::<_, String>(0))?
            .filter_map(Result::ok)
            .collect();
        rows.into_iter().collect()
    };
    for f in &mut files {
        f.attribution = if user_touched.contains(&f.rel_path) {
            diff::Attribution::Both
        } else {
            diff::Attribution::AgentOnly
        };
    }

    {
        let conn = state.db.lock().expect("db lock");
        conn.execute(
            "UPDATE tasks SET review_state = 'pending'
              WHERE id = ?1 AND review_state = 'none'",
            [&task_id],
        )?;
    }

    Ok(diff::TaskDiff {
        files,
        skipped: after.skipped,
        attribution_degraded: false,
    })
}

#[tauri::command]
pub fn review_file_patch(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    rel_path: String,
) -> Result<String, AppError> {
    let ctx = task_ctx(&state, &task_id)?;
    let app_data = app.path().app_local_data_dir().map_err(|e| AppError::Io(e.to_string()))?;
    let odb = vcs::open_odb(&app_data, &ctx.workspace_id)?;
    let after = snapshot::snapshot(
        &odb,
        &ctx.root,
        &vcs::checkpoint_ref(&task_id, "post"),
        "post-task snapshot",
    )?;
    Ok(diff::file_patch(&odb, ctx.pre_tree, after.tree, &rel_path)?)
}

#[tauri::command]
pub fn review_keep(state: State<'_, AppState>, task_id: String) -> Result<(), AppError> {
    let conn = state.db.lock().expect("db lock");
    conn.execute(
        "UPDATE tasks SET review_state = 'kept' WHERE id = ?1",
        [&task_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn review_restore(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    paths: Vec<String>,
) -> Result<restore::RestoreResult, AppError> {
    let ctx = task_ctx(&state, &task_id)?;
    let app_data = app.path().app_local_data_dir().map_err(|e| AppError::Io(e.to_string()))?;
    let odb = vcs::open_odb(&app_data, &ctx.workspace_id)?;

    // Restore is itself undoable: a pre-restore checkpoint is always taken.
    let undo_ref = vcs::checkpoint_ref(&task_id, "restores");
    let result = restore::restore(&odb, &ctx.root, ctx.pre_tree, &paths, Some(&undo_ref))?;

    let conn = state.db.lock().expect("db lock");
    conn.execute(
        "UPDATE tasks SET review_state = 'restored' WHERE id = ?1",
        [&task_id],
    )?;
    Ok(result)
}

/// Record that the user edited a file through Workbench's editor while a task
/// was running — the signal that turns AgentOnly into Both.
#[tauri::command]
pub fn review_note_user_edit(
    state: State<'_, AppState>,
    workspace_id: String,
    rel_path: String,
) -> Result<(), AppError> {
    let conn = state.db.lock().expect("db lock");
    let running: Option<String> = conn
        .query_row(
            "SELECT id FROM tasks WHERE workspace_id = ?1 AND status IN ('starting','running')
              ORDER BY created_at DESC LIMIT 1",
            [&workspace_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(task_id) = running {
        conn.execute(
            "INSERT INTO file_touches (task_id, rel_path, origin, ts)
             VALUES (?1, ?2, 'user_editor', ?3)",
            rusqlite::params![task_id, rel_path, now_ms()],
        )?;
    }
    Ok(())
}
