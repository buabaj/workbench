pub mod agent;
mod db;
mod error;
pub mod secret;

use std::sync::Mutex;

use tauri::Manager;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
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
        .setup(|app| {
            let data_dir = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = db::open(&data_dir.join("workbench.db"))?;
            app.manage(AppState { db: Mutex::new(conn) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![db_health])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
