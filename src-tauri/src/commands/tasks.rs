use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{Manager, State};

use crate::agent::spawn::{build_spawn_plan, SpawnContext};
use crate::agent::supervisor::SupervisorError;
use crate::db::now_ms;
use crate::error::AppError;
use crate::AppState;

impl From<SupervisorError> for AppError {
    fn from(e: SupervisorError) -> Self {
        AppError::Internal(crate::secret::redact(&e.to_string()))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskView {
    pub id: String,
    pub workspace_id: String,
    pub status: String,
    pub prompt_text: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub profile_origin: Option<String>,
    pub created_at: i64,
}

#[tauri::command]
pub async fn agent_start_task(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    workspace_id: String,
    prompt: String,
    profile_override: Option<String>,
    channel: Channel<Value>,
) -> Result<TaskView, AppError> {
    let task_id = ulid::Ulid::new().to_string();
    let db = state.db.clone();
    let keychain = state.keychain.clone();

    // Resolve profile + workspace root, build the spawn plan (blocking:
    // Keychain read + DB).
    let app_cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| AppError::Io(e.to_string()))?;

    let preflight = crate::agent::preflight::run(None).await;
    let resolved = preflight
        .resolved
        .ok_or_else(|| AppError::Validation("prime-agent is not installed".into()))?;

    let session_dir = data_dir
        .join("workspaces")
        .join(&workspace_id)
        .join("agent-sessions");
    std::fs::create_dir_all(&session_dir)?;

    let (plan, task_row) = {
        let ws_id = workspace_id.clone();
        let t_id = task_id.clone();
        let prompt_clone = prompt.clone();
        let session_dir = session_dir.clone();
        tokio::task::spawn_blocking(move || -> Result<_, AppError> {
            let conn = db.lock().expect("db lock");
            let resolved_profile = crate::profiles::resolve_agent_profile(
                &conn,
                profile_override.as_deref(),
                Some(&ws_id),
            )?;
            let profile = &resolved_profile.profile;
            let origin = match resolved_profile.origin {
                crate::profiles::Origin::Task => "task",
                crate::profiles::Origin::Workspace => "workspace",
                crate::profiles::Origin::App => "app",
            };

            let real_agent_dir = crate::agent::oauth_discovery::prime_home().join("agent");
            let ctx = SpawnContext {
                app_cache: &app_cache,
                real_agent_dir: &real_agent_dir,
                program: resolved.program.clone(),
                path_env: resolved.path_env.clone(),
                session_dir: &session_dir,
            };
            let plan = build_spawn_plan(&conn, keychain.as_ref(), &profile.id, &t_id, &ctx)
                .map_err(|e| AppError::Internal(crate::secret::redact(&e.to_string())))?;

            conn.execute(
                "INSERT INTO tasks (id, workspace_id, agent_profile_id,
                    resolved_credential_profile_id, profile_origin, injection_mode,
                    provider, model, thinking_level, prompt_text, status, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'starting', ?11)",
                rusqlite::params![
                    t_id,
                    ws_id,
                    profile.id,
                    profile.credential_profile_id,
                    origin,
                    serde_json::to_value(plan.mode).unwrap().as_str(),
                    plan.provider_slug,
                    plan.model_id,
                    profile.thinking_level,
                    prompt_clone,
                    now_ms()
                ],
            )?;
            Ok((plan, ()))
        })
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??
    };
    let _ = task_row;

    // Workspace root as cwd.
    let cwd: String = {
        let conn = state.db.lock().expect("db lock");
        conn.query_row(
            "SELECT root_real FROM workspaces WHERE id = ?1",
            [&workspace_id],
            |r| r.get(0),
        )?
    };

    // Pre-task checkpoint — the safety net. A failure here aborts the task
    // rather than letting an agent loose with no way back.
    super::review::create_pre_task_checkpoint(
        &state,
        &data_dir,
        &workspace_id,
        &task_id,
        std::path::Path::new(&cwd),
    )
    .map_err(|e| {
        let conn = state.db.lock().expect("db lock");
        let _ = conn.execute(
            "UPDATE tasks SET status='failed', error_text=?1, ended_at=?2 WHERE id=?3",
            rusqlite::params![format!("checkpoint failed: {e}"), now_ms(), task_id],
        );
        e
    })?;

    // Spawn + handshake + register.
    let outcome = state
        .supervisor
        .start(
            state.db.clone(),
            task_id.clone(),
            plan,
            std::path::Path::new(&cwd),
            channel,
        )
        .await
        .map_err(|e| {
            // Mark the row failed so history is honest.
            let conn = state.db.lock().expect("db lock");
            let _ = conn.execute(
                "UPDATE tasks SET status='failed', error_text=?1, ended_at=?2 WHERE id=?3",
                rusqlite::params![
                    crate::secret::redact(&e.to_string()),
                    now_ms(),
                    task_id
                ],
            );
            AppError::from(e)
        })?;

    {
        let conn = state.db.lock().expect("db lock");
        conn.execute(
            "UPDATE tasks SET session_id = ?1, session_path = ?2 WHERE id = ?3",
            rusqlite::params![outcome.session_id, outcome.session_path, task_id],
        )?;
    }

    // Fire the prompt.
    state.supervisor.send(&task_id, "prompt", prompt.clone()).await?;

    let conn = state.db.lock().expect("db lock");
    let view = conn.query_row(
        "SELECT id, workspace_id, status, prompt_text, provider, model, profile_origin, created_at
           FROM tasks WHERE id = ?1",
        [&task_id],
        |r| {
            Ok(TaskView {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                status: r.get(2)?,
                prompt_text: r.get(3)?,
                provider: r.get(4)?,
                model: r.get(5)?,
                profile_origin: r.get(6)?,
                created_at: r.get(7)?,
            })
        },
    )?;
    Ok(view)
}

#[tauri::command]
pub async fn agent_stop_task(
    state: State<'_, AppState>,
    task_id: String,
    force: bool,
) -> Result<(), AppError> {
    state.supervisor.stop(&task_id, force).await?;
    let conn = state.db.lock().expect("db lock");
    conn.execute(
        "UPDATE tasks SET status = 'cancelled', ended_at = ?1
          WHERE id = ?2 AND status IN ('starting','running')",
        rusqlite::params![now_ms(), task_id],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn agent_send(
    state: State<'_, AppState>,
    task_id: String,
    command: String,
    message: String,
) -> Result<(), AppError> {
    if !["prompt", "steer", "follow_up"].contains(&command.as_str()) {
        return Err(AppError::Validation(format!("command '{command}' not allowed")));
    }
    state.supervisor.send(&task_id, &command, message).await?;
    Ok(())
}

#[tauri::command]
pub fn agent_subscribe(
    state: State<'_, AppState>,
    task_id: String,
    from_seq: u64,
    channel: Channel<Value>,
) -> Result<(), AppError> {
    state.supervisor.subscribe(&task_id, from_seq, channel)?;
    Ok(())
}

#[tauri::command]
pub fn tasks_recent(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<TaskView>, AppError> {
    let conn = state.db.lock().expect("db lock");
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, status, prompt_text, provider, model, profile_origin, created_at
           FROM tasks WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT 20",
    )?;
    let rows = stmt
        .query_map([&workspace_id], |r| {
            Ok(TaskView {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                status: r.get(2)?,
                prompt_text: r.get(3)?,
                provider: r.get(4)?,
                model: r.get(5)?,
                profile_origin: r.get(6)?,
                created_at: r.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
