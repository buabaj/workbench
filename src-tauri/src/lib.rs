pub mod agent;
pub mod pty;
pub mod scholar;
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
    /// Set once the frontend has dealt with unsaved work and agreed to quit.
    ///
    /// Without it the exit handler would prevent its own second attempt and
    /// the app could never close.
    pub quit_confirmed: Arc<std::sync::atomic::AtomicBool>,
    /// Set when the frontend says it is showing the unsaved-work dialog.
    ///
    /// A guard that can hold the exit must be able to prove someone is going
    /// to answer. Without this, a window that never registered the listener —
    /// a failed load, a crashed renderer — would make the app unquittable.
    pub quit_acked: Arc<std::sync::atomic::AtomicBool>,
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

            // macOS's default menu quits the app directly — no ExitRequested,
            // no CloseRequested, nothing to intercept. Verified by logging
            // every RunEvent through a quit: only `Exit` arrives, and that
            // cannot be prevented. So the Quit item is ours.
            //
            // Replacing the menu means rebuilding the standard items too:
            // without an Edit submenu, macOS stops delivering ⌘C/⌘V/⌘Z to the
            // webview at all.
            {
                use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
                let quit = MenuItem::with_id(app, "quit", "Quit Workbench", true, Some("CmdOrCtrl+Q"))?;
                let app_menu = Submenu::with_items(
                    app,
                    "Workbench",
                    true,
                    &[
                        &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::hide(app, None)?,
                        &PredefinedMenuItem::hide_others(app, None)?,
                        &PredefinedMenuItem::show_all(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &quit,
                    ],
                )?;
                let edit = Submenu::with_items(
                    app,
                    "Edit",
                    true,
                    &[
                        &PredefinedMenuItem::undo(app, None)?,
                        &PredefinedMenuItem::redo(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::cut(app, None)?,
                        &PredefinedMenuItem::copy(app, None)?,
                        &PredefinedMenuItem::paste(app, None)?,
                        &PredefinedMenuItem::select_all(app, None)?,
                    ],
                )?;
                let window = Submenu::with_items(
                    app,
                    "Window",
                    true,
                    &[
                        &PredefinedMenuItem::minimize(app, None)?,
                        &PredefinedMenuItem::maximize(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::close_window(app, None)?,
                    ],
                )?;
                app.set_menu(Menu::with_items(app, &[&app_menu, &edit, &window])?)?;
            }

            app.manage(AppState {
                db: Arc::new(Mutex::new(conn)),
                keychain: Arc::new(creds::keychain::MacKeychain),
                supervisor: Arc::new(Supervisor::default()),
                ptys: Arc::new(crate::pty::PtyRegistry::default()),
                quit_confirmed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                quit_acked: Arc::new(std::sync::atomic::AtomicBool::new(false)),
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
            commands::workspace::workspace_forget,
            commands::workspace::workspace_tree,
            commands::workspace::file_read,
            commands::workspace::file_stat,
            commands::workspace::file_write,
            commands::workspace::worktree_changes,
            commands::workspace::worktree_patch,
            commands::workspace::worktree_branch,
            commands::workspace::notes_scan,
            commands::workspace::file_read_bytes,
            commands::scholar::scholar_search,
            commands::scholar::paper_import,
            commands::workspace::file_create,
            commands::workspace::dir_create,
            commands::workspace::confirm_quit,
            commands::workspace::quit_ack,
            commands::workspace::path_rename,
            commands::workspace::path_duplicate,
            commands::workspace::path_trash,
            commands::workspace::path_reveal,
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
            commands::tasks::note_action,
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
            commands::appai::transcript_cleanup,
            commands::appai::research_summarize,
            commands::appai::links_suggest,
            commands::appai::capability_status,
            commands::appai::capability_choose_models,
        ])
        .on_menu_event(|app, event| {
            if event.id() == "quit" && !request_quit(app) {
                app.exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Which shutdown events macOS delivers is not something to reason
            // about — the first version of this guard hung off one that never
            // fires. `RUST_LOG=debug` answers it directly.
            if !matches!(event, tauri::RunEvent::MainEventsCleared) {
                tracing::debug!(?event, "run event");
            }
            match event {
                // The one shutdown event every quit path delivers, which is
                // why cleanup lives here and asking happens earlier.
                //
                // Measured, not assumed. Quitting through NSApplication (Dock →
                // Quit, logout, `osascript quit`) emits `Exit` and nothing
                // else — no `ExitRequested`, no `CloseRequested`. This teardown
                // originally hung off `ExitRequested` and so had never once run.
                //
                // The same measurement is why ⌘Q is a menu item of our own
                // (see `setup`) and not `PredefinedMenuItem::quit`: only that
                // gives the guard something to intercept. Known gap — a quit
                // from the Dock or a logout still discards unsaved work
                // silently, because `Exit` cannot be prevented and macOS offers
                // nothing earlier without swizzling the app delegate.
                tauri::RunEvent::Exit => {
                    tracing::info!("shutting down: stopping agents and shells");
                    // Graceful, and worth the wait: a killed agent survives us
                    // (it leaves our process group) and would keep running with
                    // a Python kernel attached. Anything still stuck past the
                    // budget is evicted when its conversation is next resumed.
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
                // Closing the only window is quitting, so the X button and ⌘W
                // get the same question as ⌘Q rather than a silent discard.
                tauri::RunEvent::WindowEvent {
                    event: tauri::WindowEvent::CloseRequested { api, .. },
                    ..
                } => {
                    if request_quit(app) {
                        api.prevent_close();
                    }
                }
                _ => {}
            }
        });
}

/// Ask the window about unsaved work before quitting.
///
/// Returns whether the caller should hold the exit. Only the frontend knows
/// which buffers are dirty, so the decision needs a round trip: hold, tell the
/// window, and let `confirm_quit` come back when the user has chosen.
fn request_quit(app: &tauri::AppHandle) -> bool {
    use std::sync::atomic::Ordering::SeqCst;
    use tauri::Emitter;

    let Some(state) = app.try_state::<AppState>() else {
        return false;
    };
    // The answer already came back — this is the quit it asked for.
    if state.quit_confirmed.load(SeqCst) {
        return false;
    }
    // Each attempt stands alone. Left set from a previous prompt that was
    // dismissed, this would disarm the backstop for every quit after it.
    state.quit_acked.store(false, SeqCst);
    // If the window cannot be told, there is nobody to ask and holding the
    // exit would trap the app open.
    if app.emit("app://quit-requested", ()).is_err() {
        return false;
    }

    // Backstop. If nothing answers, quit anyway: a guard that can hold the
    // exit open forever is worse than the unsaved work it protects.
    let confirmed = state.quit_confirmed.clone();
    let acked = state.quit_acked.clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        if confirmed.load(SeqCst) || acked.load(SeqCst) {
            return; // answered, or a dialog is up
        }
        tracing::warn!("no answer to the quit prompt; exiting");
        confirmed.store(true, SeqCst);
        handle.exit(0);
    });
    true
}
