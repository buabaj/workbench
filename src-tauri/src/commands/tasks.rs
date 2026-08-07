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

    let cwd: String = {
        let conn = state.db.lock().expect("db lock");
        conn.query_row(
            "SELECT root_real FROM workspaces WHERE id = ?1",
            [&workspace_id],
            |r| r.get(0),
        )?
    };

    let ws_context = {
        let conn = state.db.lock().expect("db lock");
        workspace_context(&conn, &workspace_id)
    };

    let (plan, task_row) = {
        let ws_id = workspace_id.clone();
        let cwd_for_plan = cwd.clone();
        let ws_context = ws_context.clone();
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
                workspace_root: std::path::Path::new(&cwd_for_plan),
                workspace_context: &ws_context,
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
            None,
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
        // Write an auto-selected model back to the profile. Without this the
        // choice was re-made on every launch and never shown anywhere, so the
        // Agent panel said "No model configured" while the agent was quietly
        // running on whatever the provider happened to list first.
        if let Some(model) = &outcome.model {
            conn.execute(
                "UPDATE agent_profiles SET model_id = ?1
                  WHERE id = (SELECT agent_profile_id FROM tasks WHERE id = ?2)
                    AND (model_id IS NULL OR model_id = '')",
                rusqlite::params![model, task_id],
            )?;
        }
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
    // Prefer the generated title; then the first thing the USER typed, which
    // is stored raw in chat_turns; and only then prompt_text, which holds the
    // composed message and is identical across conversations sharing a mode.
    let mut stmt = conn.prepare(
        "SELECT t.id,
                COALESCE(
                  NULLIF(t.title, ''),
                  (SELECT c.text FROM chat_turns c
                    WHERE c.task_id = t.id AND c.role = 'user' AND TRIM(c.text) <> ''
                    ORDER BY c.seq LIMIT 1),
                  t.prompt_text
                ),
                t.status, t.created_at,
                (SELECT count(*) FROM chat_turns c WHERE c.task_id = t.id)
           FROM tasks t
          WHERE t.workspace_id = ?1
          ORDER BY t.created_at DESC
          LIMIT 50",
    )?;
    let rows = stmt
        .query_map([&workspace_id], |r| {
            let label: String = r.get(1)?;
            Ok(SessionSummary {
                task_id: r.get(0)?,
                title: label.chars().take(80).collect(),
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

/// Reattach to a stored conversation so a follow-up CONTINUES it.
///
/// Without this, sending into a conversation loaded from history started a
/// brand-new task: the agent process for the old one had long exited, and the
/// frontend had no way to bring it back. The stored session file is the
/// agent's own transcript, and `switch_session` is its documented resume
/// mechanism — reattaching gives the model its full prior context, not just
/// the text we replayed into the UI.
#[tauri::command]
pub async fn agent_resume_task(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    channel: Channel<Value>,
) -> Result<TaskView, AppError> {
    use tauri::Manager;

    // Already running? Just attach the new channel to the live stream.
    if state.supervisor.get(&task_id).is_some() {
        state.supervisor.subscribe(&task_id, 0, channel)?;
        return task_view(&state, &task_id);
    }

    let (workspace_id, profile_id, session_path, cwd) = {
        let conn = state.db.lock().expect("db lock");
        conn.query_row(
            "SELECT t.workspace_id, t.agent_profile_id, t.session_path, w.root_real
               FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
              WHERE t.id = ?1",
            [&task_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|_| AppError::NotFound("task".into()))?
    };

    let preflight = crate::agent::preflight::run(None).await;
    let resolved = preflight
        .resolved
        .ok_or_else(|| AppError::Validation("prime-agent is not installed".into()))?;
    let app_cache = app.path().app_cache_dir().map_err(|e| AppError::Io(e.to_string()))?;
    let data_dir = app.path().app_local_data_dir().map_err(|e| AppError::Io(e.to_string()))?;
    let session_dir = data_dir.join("workspaces").join(&workspace_id).join("agent-sessions");
    std::fs::create_dir_all(&session_dir)?;

    let ws_context = {
        let conn = state.db.lock().expect("db lock");
        workspace_context(&conn, &workspace_id)
    };
    let db = state.db.clone();
    let keychain = state.keychain.clone();
    let t_id = task_id.clone();
    let cwd_plan = cwd.clone();
    let plan = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        let conn = db.lock().expect("db lock");
        // Fall back to the current default if the original profile is gone.
        let profile_id = match profile_id {
            Some(p) if crate::profiles::get_agent_profile(&conn, &p)
                .map_err(|e| AppError::Internal(e.to_string()))?
                .is_some() => p,
            _ => crate::profiles::resolve_agent_profile(&conn, None, Some(&workspace_id))
                .map_err(|e| AppError::Internal(e.to_string()))?
                .profile
                .id,
        };
        let real_agent_dir = crate::agent::oauth_discovery::prime_home().join("agent");
        let ctx = SpawnContext {
            app_cache: &app_cache,
            real_agent_dir: &real_agent_dir,
            program: resolved.program.clone(),
            path_env: resolved.path_env.clone(),
            session_dir: &session_dir,
            workspace_root: std::path::Path::new(&cwd_plan),
            workspace_context: &ws_context,
        };
        build_spawn_plan(&conn, keychain.as_ref(), &profile_id, &t_id, &ctx)
            .map_err(|e| AppError::Internal(crate::secret::redact(&e.to_string())))
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))??;

    state
        .supervisor
        .start(
            state.db.clone(),
            task_id.clone(),
            plan,
            std::path::Path::new(&cwd),
            session_path,
            channel,
        )
        .await?;

    {
        let conn = state.db.lock().expect("db lock");
        conn.execute(
            "UPDATE tasks SET status = 'running', ended_at = NULL WHERE id = ?1",
            [&task_id],
        )?;
    }
    task_view(&state, &task_id)
}

fn task_view(state: &State<'_, AppState>, task_id: &str) -> Result<TaskView, AppError> {
    let conn = state.db.lock().expect("db lock");
    Ok(conn.query_row(
        "SELECT id, workspace_id, status, prompt_text, provider, model, profile_origin, created_at
           FROM tasks WHERE id = ?1",
        [task_id],
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
    )?)
}

/// Orientation for the agent: what this project is and where it lives.
///
/// Appended to the SYSTEM PROMPT at spawn, not sent as a first message. The
/// agent runs with the workspace as its working directory but was never told
/// so, and will not run `pwd` unprompted — asked to "review this project" it
/// had nothing to resolve "this" against. Putting it in the system prompt is
/// what makes it true on every turn and after a resume, rather than for a
/// single message that later turns forget.
pub fn workspace_context(conn: &rusqlite::Connection, workspace_id: &str) -> String {
    let row: rusqlite::Result<(String, String, String)> = conn.query_row(
        "SELECT name, root_real, kind FROM workspaces WHERE id = ?1",
        [workspace_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    );
    let Ok((name, root, kind)) = row else {
        return String::new();
    };

    let mut lines = vec![
        format!("You are running inside Workbench, working on the project \"{name}\"."),
        format!("Its root directory is: {root}"),
        "That directory is your working directory. When the user says \"this project\", \
         \"this workspace\", \"the codebase\", \"this repo\", or \"here\", they mean it, \
         and relative paths resolve from it."
            .to_string(),
    ];
    if kind == "git" {
        lines.push(format!(
            "It is a git repository, so `git -C {root} status` and similar commands work."
        ));
    }
    lines.push(
        "Answer questions about the code by reading the actual files there first, \
         rather than assuming a layout."
            .to_string(),
    );
    lines.join("\n")
}

/// Tidy a model-written title into something that fits a 300px list row.
///
/// Small models like to answer with a full sentence, wrap the title in quotes,
/// or prefix it with "Title:" no matter how firmly the prompt says otherwise,
/// so the output is treated as untrusted text rather than a value.
pub fn clean_title(raw: &str) -> String {
    let mut s = raw.trim().lines().next().unwrap_or("").trim().to_string();
    for prefix in ["title:", "Title:", "TITLE:"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest.trim().to_string();
        }
    }
    s = s
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`' || c == '*')
        .trim()
        .to_string();
    // A trailing full stop reads oddly in a list; other punctuation is fine.
    s = s.trim_end_matches('.').trim().to_string();
    if s.chars().count() > 60 {
        s = s.chars().take(59).collect::<String>().trim_end().to_string();
        s.push('…');
    }
    s
}

const TITLE_SYSTEM: &str = "You name conversations. Reply with a title of 3 to 6 words \
naming the specific subject discussed. No quotes, no punctuation at the end, no preamble, \
no filler like \"discussion about\" or \"help with\". Use the concrete nouns from the \
conversation. Reply with the title alone.";

/// Name a conversation from what was actually said in it.
///
/// Titles used to be the first 80 characters of `tasks.prompt_text`, which is
/// the COMPOSED message — mode template included — so every conversation
/// started in the same mode was labelled identically. Generation is best
/// effort: without a key, or offline, the list falls back to the first thing
/// the user typed, which is still specific to that conversation.
#[tauri::command]
pub async fn chat_title(state: State<'_, AppState>, task_id: String) -> Result<String, AppError> {
    let (workspace_root, transcript) = {
        let conn = state.db.lock().expect("db lock");
        let root: String = conn
            .query_row(
                "SELECT w.root_real FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
                  WHERE t.id = ?1",
                [&task_id],
                |r| r.get(0),
            )
            .map_err(|_| AppError::NotFound("task".into()))?;

        // The opening exchange is what a title should describe; later turns
        // wander, and sending the whole conversation costs tokens for nothing.
        let mut stmt = conn.prepare(
            "SELECT role, text FROM chat_turns WHERE task_id = ?1 ORDER BY seq LIMIT 4",
        )?;
        let rows: Vec<(String, String)> = stmt
            .query_map([&task_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        let text = rows
            .iter()
            .filter(|(_, t)| !t.trim().is_empty())
            .map(|(role, t)| {
                let body: String = t.chars().take(600).collect();
                format!("{role}: {body}")
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        (root, text)
    };

    if transcript.trim().is_empty() {
        return Err(AppError::Validation("conversation is empty".into()));
    }

    let key = crate::appai::dotenv::lookup("OPENROUTER_API_KEY", Some(std::path::Path::new(&workspace_root)))
        .ok_or_else(|| AppError::from(crate::appai::AppAiError::NoCredential))?;

    let models: Vec<String> = crate::appai::registry::get("chat.title")
        .map(|s| s.default_models.iter().map(|m| m.to_string()).collect())
        .unwrap_or_default();

    let raw = crate::appai::openrouter::complete(
        &key,
        &models,
        TITLE_SYSTEM,
        &transcript,
        32,
        crate::appai::openrouter::PrivacyMode::parse("balanced"),
        20_000,
    )
    .await?;

    let title = clean_title(&raw);
    if title.is_empty() {
        return Err(AppError::Internal("model returned an empty title".into()));
    }
    {
        let conn = state.db.lock().expect("db lock");
        conn.execute(
            "UPDATE tasks SET title = ?1 WHERE id = ?2",
            rusqlite::params![&title, &task_id],
        )?;
    }
    Ok(title)
}

#[cfg(test)]
mod title_tests {
    use super::clean_title;

    #[test]
    fn strips_the_wrappers_small_models_add() {
        assert_eq!(clean_title("\"Session resume bug\""), "Session resume bug");
        assert_eq!(clean_title("Title: Session resume bug"), "Session resume bug");
        assert_eq!(clean_title("**Session resume bug**"), "Session resume bug");
        assert_eq!(clean_title("Session resume bug."), "Session resume bug");
    }

    #[test]
    fn keeps_only_the_first_line() {
        assert_eq!(
            clean_title("Session resume bug\n\nThis conversation was about…"),
            "Session resume bug"
        );
    }

    #[test]
    fn truncates_to_something_a_list_row_can_show() {
        let out = clean_title(&"word ".repeat(40));
        assert!(out.chars().count() <= 60, "got {} chars", out.chars().count());
        assert!(out.ends_with('…'));
    }

    #[test]
    fn empty_stays_empty_so_the_caller_can_fall_back() {
        assert_eq!(clean_title("   "), "");
        assert_eq!(clean_title("\"\""), "");
    }
}


const NOTE_ACTION_SYSTEM: &str = "You are writing directly into someone's notes. \
Produce only the requested text — no preamble, no sign-off, no restating the request, \
and no code fence unless the request is for code. Match the surrounding document's voice \
and markdown conventions. If the request cannot be answered from the note, say so in one \
short line rather than inventing content.";

/// Run an `@agent[...]` directive written inside a note.
///
/// Answered by the internal model rather than the coding agent: this is a
/// request/response with no session, no tools and no file access — it writes
/// its result exactly where the directive stood and nowhere else. Handing a
/// tool-using agent the ability to rewrite the document you are typing in is a
/// much larger promise, and the chat is already there for that.
#[tauri::command]
pub async fn note_action(
    state: State<'_, AppState>,
    workspace_id: String,
    instruction: String,
    context: String,
) -> Result<String, AppError> {
    if instruction.trim().is_empty() {
        return Err(AppError::Validation("nothing was asked".into()));
    }
    let workspace_root: String = {
        let conn = state.db.lock().expect("db lock");
        conn.query_row(
            "SELECT root_real FROM workspaces WHERE id = ?1",
            [&workspace_id],
            |r| r.get(0),
        )
        .map_err(|_| AppError::NotFound("workspace".into()))?
    };

    let key = crate::appai::dotenv::lookup(
        "OPENROUTER_API_KEY",
        Some(std::path::Path::new(&workspace_root)),
    )
    .ok_or_else(|| AppError::from(crate::appai::AppAiError::NoCredential))?;

    let models: Vec<String> = crate::appai::registry::get("note.action")
        .map(|s| s.default_models.iter().map(|m| m.to_string()).collect())
        .unwrap_or_default();

    // The note is the context; a long paper is truncated rather than refused,
    // since the instruction usually concerns what has been written so far.
    const MAX_CONTEXT: usize = 60_000;
    let context: String = context.chars().take(MAX_CONTEXT).collect();
    let user = format!("The document so far:\n\n{context}\n\n---\n\nRequest: {instruction}");

    let out = crate::appai::openrouter::complete(
        &key,
        &models,
        NOTE_ACTION_SYSTEM,
        &user,
        2_000,
        crate::appai::openrouter::PrivacyMode::parse("balanced"),
        90_000,
    )
    .await?;
    Ok(out.trim().to_string())
}
