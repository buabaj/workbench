pub mod agent;
pub mod commands;
pub mod creds;
pub mod db;
pub mod error;
pub mod fsx;
pub mod profiles;
pub mod secret;

use std::sync::Mutex;

use tauri::Manager;

use creds::keychain::Keychain;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub keychain: Box<dyn Keychain>,
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
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = db::open(&data_dir.join("workbench.db"))?;

            // Crash-safety sweep: stale isolated config dirs contain no secrets
            // but must not accumulate.
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                agent::config_dir::IsolatedConfigDir::sweep(&cache_dir);
            }

            app.manage(AppState {
                db: Mutex::new(conn),
                keychain: Box::new(creds::keychain::MacKeychain),
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
            commands::profiles::profiles_resolve,
            commands::workspace::workspace_open,
            commands::workspace::workspace_pick,
            commands::workspace::workspace_recent,
            commands::workspace::workspace_tree,
            commands::workspace::file_read,
            commands::workspace::file_stat,
            commands::workspace::file_write,
            commands::agent_setup::agent_preflight,
            commands::agent_setup::agent_set_executable_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
