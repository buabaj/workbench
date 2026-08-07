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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModel {
    pub id: String,
    pub provider: String,
    pub name: Option<String>,
}

/// Models the installed agent can actually reach for a given credential.
///
/// Spawns a short-lived agent under the same isolated config dir a task would
/// use, so the answer reflects the credential being asked about rather than
/// whatever happens to be configured on the host.
#[tauri::command]
pub async fn agent_list_models(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    credential_profile_id: String,
) -> Result<Vec<AgentModel>, AppError> {
    use tauri::Manager;

    let preflight = preflight::run(None).await;
    let resolved = preflight
        .resolved
        .ok_or_else(|| AppError::Validation("prime-agent is not installed".into()))?;
    let app_cache = app.path().app_cache_dir().map_err(|e| AppError::Io(e.to_string()))?;
    let data_dir = app.path().app_local_data_dir().map_err(|e| AppError::Io(e.to_string()))?;
    let sessions = data_dir.join("model-probe");
    std::fs::create_dir_all(&sessions)?;

    let (cred, keychain) = {
        let conn = state.db.lock().expect("db lock");
        (
            crate::creds::store::get(&conn, &credential_profile_id)
                .map_err(|e| AppError::Internal(e.to_string()))?
                .ok_or_else(|| AppError::NotFound("credential".into()))?,
            state.keychain.clone(),
        )
    };
    let slug = cred.provider_slug.clone().unwrap_or_default();

    let real_agent_dir = crate::agent::oauth_discovery::prime_home().join("agent");
    let probe_id = format!("probe-{}", ulid::Ulid::new());
    let dir = crate::agent::config_dir::IsolatedConfigDir::create(
        &app_cache, &probe_id, &real_agent_dir, &slug, None,
    )
    .map_err(|e| AppError::Internal(e.to_string()))?;

    let secret = keychain
        .get(&crate::creds::keychain::account_for(&cred.id))
        .map_err(|e| AppError::Internal(crate::secret::redact(&e.to_string())))?;

    let mut cmd = tokio::process::Command::new(&resolved.program);
    cmd.args(["--mode", "rpc", "--no-session", "--provider", &slug])
        .current_dir(&sessions)
        .env_clear();
    for (k, v) in crate::agent::env::base_child_env(std::env::vars(), &resolved.path_env) {
        cmd.env(k, v);
    }
    cmd.env("PRIME_AGENT_CODING_AGENT_DIR", dir.agent_dir());
    if let Some(s) = &secret {
        cmd.env(crate::agent::config_dir::PROVIDER_KEY_VAR, s.expose());
    }

    let (child, output) = crate::agent::child::TokioChild::spawn(cmd)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let (dispatcher, _stream) = crate::agent::dispatch::Dispatcher::start(Box::new(child), output);

    let result = dispatcher
        .request(
            "get_available_models",
            serde_json::json!({}),
            std::time::Duration::from_secs(30),
        )
        .await;
    dispatcher.kill();

    let data = result
        .map_err(|e| AppError::Internal(crate::secret::redact(&e.to_string())))?
        .data
        .unwrap_or(serde_json::Value::Null);

    let mut out: Vec<AgentModel> = data
        .get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    Some(AgentModel {
                        id: m.get("id")?.as_str()?.to_string(),
                        provider: m.get("provider")?.as_str()?.to_string(),
                        name: m.get("name").and_then(|n| n.as_str()).map(String::from),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    // The selected provider first — that is what this credential can pay for.
    out.sort_by_key(|m| (m.provider != slug, m.id.clone()));
    Ok(out)
}
