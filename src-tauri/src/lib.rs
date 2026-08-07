pub mod agent;
pub mod pty;
pub mod search;
pub mod anchors;
pub mod appai;
pub mod commands;
pub mod creds;
pub mod db;
pub mod error;
pub mod fsx;
pub mod profiles;
pub mod secret;
pub mod vcs;
pub mod voice;

use std::sync::{Arc, Mutex};

use tauri::Manager;

use agent::supervisor::Supervisor;
use creds::keychain::Keychain;

pub struct AppState {
    pub db: Arc<Mutex<rusqlite::Connection>>,
    pub keychain: Arc<dyn Keychain>,
    pub supervisor: Arc<Supervisor>,
    /// User-owned shells. Separate from the agent's bash tool by design.
    pub ptys: Arc<crate::pty::PtyRegistry>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbHealth {
    pub schema_version: u32,
    pub path: String,
}

#[tauri::command]
fn db_health(state: tauri::State<'_, AppState>) -> Result<DbHealth, error::AppError> {
    let conn = state.db.lock().expect("db mutex poisoned");
    let version: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let path = conn.path().unwrap_or("<memory>").to_string();
    Ok(DbHealth {
        schema_version: version,
        path,
    })
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::workspace::OpenWorkspaces::default())
        .manage(voice::session::VoiceState::default())
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = db::open(&data_dir.join("workbench.db"))?;

            // Crash-safety sweep: stale isolated config dirs contain no secrets
            // but must not accumulate.
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                agent::config_dir::IsolatedConfigDir::sweep(&cache_dir);
                // Nothing in the voice dir is meant to outlive a session.
                app.state::<voice::session::VoiceState>()
                    .sweep_on_startup(&cache_dir);
            }

            app.manage(AppState {
                db: Arc::new(Mutex::new(conn)),
                keychain: Arc::new(creds::keychain::MacKeychain),
                supervisor: Arc::new(Supervisor::default()),
                ptys: Arc::new(crate::pty::PtyRegistry::default()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_health,
            commands::creds::creds_list,
            commands::creds::creds_add,
            commands::creds::creds_replace_secret,
            commands::creds::creds_usage,
            commands::creds::creds_reassign,
            commands::creds::creds_delete,
            commands::creds::creds_discover_host_auth,
            commands::profiles::agent_profiles_list,
            commands::profiles::agent_profiles_upsert,
            commands::profiles::agent_profiles_delete,
            commands::profiles::profiles_set_default,
            commands::profiles::agent_profile_set_model,
            commands::profiles::profiles_resolve,
            commands::workspace::workspace_open,
            commands::workspace::workspace_pick,
            commands::workspace::workspace_recent,
            commands::workspace::workspace_tree,
            commands::workspace::file_read,
            commands::workspace::file_stat,
            commands::workspace::file_write,
            commands::workspace::worktree_changes,
            commands::workspace::worktree_patch,
            commands::workspace::worktree_branch,
            commands::workspace::notes_scan,
            commands::workspace::file_create,
            commands::workspace::dir_create,
            commands::workspace::workspace_index,
            commands::workspace::workspace_setting_get,
            commands::workspace::workspace_setting_set,
            commands::agent_setup::agent_preflight,
            commands::agent_setup::agent_set_executable_path,
            commands::agent_setup::agent_list_models,
            commands::tasks::agent_start_task,
            commands::tasks::agent_stop_task,
            commands::tasks::agent_send,
            commands::tasks::agent_subscribe,
            commands::tasks::tasks_recent,
            commands::tasks::chat_append_turn,
            commands::tasks::chat_turns,
            commands::tasks::chat_sessions,
            commands::tasks::chat_delete_session,
            commands::tasks::agent_resume_task,
            commands::tasks::chat_title,
            commands::search::search_run,
            commands::search::search_replace,
            commands::pty::pty_open,
            commands::pty::pty_write,
            commands::pty::pty_resize,
            commands::pty::pty_close,
            commands::tasks::agent_commands,
            commands::tasks::agent_action,
            commands::review::review_task_diff,
            commands::review::review_file_patch,
            commands::review::review_keep,
            commands::review::review_restore,
            commands::review::review_note_user_edit,
            commands::links::link_create,
            commands::links::link_delete,
            commands::links::links_for_file,
            commands::links::link_kinds,
            commands::voice::voice_capability,
            commands::voice::voice_begin,
            commands::voice::voice_push,
            commands::voice::voice_cancel,
            commands::voice::voice_finish,
            commands::voice::voice_configure,
            commands::voice::models_for_capability,
            commands::voice::appai_capabilities,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Graceful, and worth the wait: a killed agent survives us
                // (it leaves our process group) and would keep running with a
                // Python kernel attached. Anything still stuck past the budget
                // is evicted when its conversation is next resumed.
                if let Some(state) = app.try_state::<AppState>() {
                    state
                        .supervisor
                        .shutdown_all(std::time::Duration::from_secs(6));
                    // No shell outlives the window it was opened in.
                    state.ptys.close_all();
                }
                // Drops every session, unlinking any in-flight recording.
                if let Some(voice) = app.try_state::<voice::session::VoiceState>() {
                    voice.cancel_all();
                }
            }
        });
}
