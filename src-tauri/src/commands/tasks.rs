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
            "UPDATE tasks SET session_id = ?1, session_path = ?2,
                              model = COALESCE(?3, model) WHERE id = ?4",
            rusqlite::params![outcome.session_id, outcome.session_path, outcome.model, task_id],
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurn {
    pub id: String,
    pub seq: i64,
    pub role: String,
    pub text: String,
    pub error_text: Option<String>,
    pub created_at: i64,
}

/// Append (or update) a turn. Called as turns complete, so history survives a
/// reload without waiting for the whole conversation to finish.
#[tauri::command]
pub fn chat_append_turn(
    state: State<'_, AppState>,
    task_id: String,
    seq: i64,
    role: String,
    text: String,
    error_text: Option<String>,
) -> Result<(), AppError> {
    if role != "user" && role != "assistant" {
        return Err(AppError::Validation("bad role".into()));
    }
    let conn = state.db.lock().expect("db lock");
    conn.execute(
        "INSERT INTO chat_turns (id, task_id, seq, role, text, error_text, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(task_id, seq) DO UPDATE SET
           text = excluded.text, error_text = excluded.error_text",
        rusqlite::params![
            ulid::Ulid::new().to_string(),
            task_id,
            seq,
            role,
            text,
            error_text,
            now_ms()
        ],
    )?;
    Ok(())
}

#[tauri::command]
pub fn chat_turns(state: State<'_, AppState>, task_id: String) -> Result<Vec<ChatTurn>, AppError> {
    let conn = state.db.lock().expect("db lock");
    let mut stmt = conn.prepare(
        "SELECT id, seq, role, text, error_text, created_at
           FROM chat_turns WHERE task_id = ?1 ORDER BY seq",
    )?;
    let rows = stmt
        .query_map([&task_id], |r| {
            Ok(ChatTurn {
                id: r.get(0)?,
                seq: r.get(1)?,
                role: r.get(2)?,
                text: r.get(3)?,
                error_text: r.get(4)?,
                created_at: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub task_id: String,
    pub title: String,
    pub status: String,
    pub turn_count: i64,
    pub created_at: i64,
}

/// Past conversations in this workspace, newest first.
#[tauri::command]
pub fn chat_sessions(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<SessionSummary>, AppError> {
    let conn = state.db.lock().expect("db lock");
    let mut stmt = conn.prepare(
        "SELECT t.id, t.prompt_text, t.status, t.created_at,
                (SELECT count(*) FROM chat_turns c WHERE c.task_id = t.id)
           FROM tasks t
          WHERE t.workspace_id = ?1
          ORDER BY t.created_at DESC
          LIMIT 50",
    )?;
    let rows = stmt
        .query_map([&workspace_id], |r| {
            let prompt: String = r.get(1)?;
            Ok(SessionSummary {
                task_id: r.get(0)?,
                title: prompt.chars().take(80).collect(),
                status: r.get(2)?,
                created_at: r.get(3)?,
                turn_count: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Delete a conversation and its turns. `chat_turns` cascades from `tasks`.
/// A running agent for that task is stopped first so the process doesn't
/// outlive the record that points at it.
#[tauri::command]
pub async fn chat_delete_session(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<(), AppError> {
    let _ = state.supervisor.stop(&task_id, true).await;
    let conn = state.db.lock().expect("db lock");
    conn.execute("DELETE FROM tasks WHERE id = ?1", [&task_id])?;
    Ok(())
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommand {
    pub name: String,
    pub description: String,
    /// "action" runs immediately over RPC; "skill" is inserted into the prompt
    /// for the agent to interpret.
    pub kind: String,
}

/// Actions Workbench can drive directly over the RPC protocol. These are
/// verified command names from the agent's RPC surface, not guesses.
fn builtin_commands() -> Vec<AgentCommand> {
    let a = |name: &str, description: &str| AgentCommand {
        name: name.into(),
        description: description.into(),
        kind: "action".into(),
    };
    vec![
        a("compact", "Summarise the conversation so far to free up context"),
        a("new", "Start a fresh conversation (ends the current agent session)"),
        a("stop", "Abort what the agent is currently doing"),
        a("thinking", "Set reasoning effort: off, minimal, low, medium, high, xhigh"),
        a("model", "Switch the model for this conversation"),
        a("stats", "Show token usage and cost for this session"),
        a("export", "Export this conversation as HTML"),
        a("fork", "Branch this conversation into a new one"),
    ]
}

/// Slash commands available right now. Built-in actions always; the agent's own
/// skills only when a session is live, since that is the only place the real
/// list exists — hardcoding it would drift the moment a skill is added.
#[tauri::command]
pub async fn agent_commands(
    state: State<'_, AppState>,
    task_id: Option<String>,
) -> Result<Vec<AgentCommand>, AppError> {
    let mut out = builtin_commands();

    if let Some(id) = task_id {
        if let Some(running) = state.supervisor.get(&id) {
            if let Ok(resp) = running
                .dispatcher
                .request(
                    "get_commands",
                    serde_json::json!({}),
                    std::time::Duration::from_secs(10),
                )
                .await
            {
                if let Some(arr) = resp
                    .data
                    .as_ref()
                    .and_then(|d| d.get("commands"))
                    .and_then(|c| c.as_array())
                {
                    for c in arr {
                        let (Some(name), desc) = (
                            c.get("name").and_then(|n| n.as_str()),
                            c.get("description").and_then(|d| d.as_str()).unwrap_or(""),
                        ) else {
                            continue;
                        };
                        out.push(AgentCommand {
                            name: name.to_string(),
                            description: desc.chars().take(120).collect(),
                            kind: "skill".into(),
                        });
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Run one of the built-in actions against the live session.
#[tauri::command]
pub async fn agent_action(
    state: State<'_, AppState>,
    task_id: String,
    action: String,
    argument: Option<String>,
) -> Result<Option<serde_json::Value>, AppError> {
    let running = state
        .supervisor
        .get(&task_id)
        .ok_or_else(|| AppError::NotFound("running agent".into()))?;
    let timeout = std::time::Duration::from_secs(60);

    let (command, params) = match action.as_str() {
        "compact" => ("compact", serde_json::json!({})),
        "stop" => ("abort", serde_json::json!({})),
        "stats" => ("get_session_stats", serde_json::json!({})),
        "export" => ("export_html", serde_json::json!({})),
        "fork" => ("fork", serde_json::json!({})),
        "thinking" => (
            "set_thinking_level",
            serde_json::json!({ "level": argument.unwrap_or_else(|| "medium".into()) }),
        ),
        other => {
            return Err(AppError::Validation(format!("unknown action '{other}'")));
        }
    };

    let resp = running
        .dispatcher
        .request(command, params, timeout)
        .await
        .map_err(|e| AppError::Internal(crate::secret::redact(&e.to_string())))?;
    Ok(resp.data)
}
