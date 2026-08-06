use rusqlite::OptionalExtension;
use tauri::State;

use crate::agent::preflight::{self, PreflightReport};
use crate::error::AppError;
use crate::AppState;

const OVERRIDE_KEY: &str = "agent.executable_path";

#[tauri::command]
pub async fn agent_preflight(state: State<'_, AppState>) -> Result<PreflightReport, AppError> {
    let override_path: Option<String> = {
        let conn = state.db.lock().expect("db lock");
        conn.query_row(
            "SELECT value_json FROM app_settings WHERE key = ?1",
            [OVERRIDE_KEY],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .and_then(|v| serde_json::from_str(&v).ok())
    };
    Ok(preflight::run(override_path).await)
}

#[tauri::command]
pub async fn agent_set_executable_path(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<PreflightReport, AppError> {
    {
        let conn = state.db.lock().expect("db lock");
        match &path {
            Some(p) => {
                conn.execute(
                    "INSERT INTO app_settings (key, value_json) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
                    rusqlite::params![OVERRIDE_KEY, serde_json::to_string(p).unwrap()],
                )?;
            }
            None => {
                conn.execute("DELETE FROM app_settings WHERE key = ?1", [OVERRIDE_KEY])?;
            }
        }
    }
    Ok(preflight::run(path).await)
}
