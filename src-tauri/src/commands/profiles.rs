use tauri::State;

use crate::error::AppError;
use crate::profiles::{
    self, AgentProfileInput, AgentProfileView, ProfileError, ResolvedAgentProfile,
};
use crate::AppState;

impl From<ProfileError> for AppError {
    fn from(e: ProfileError) -> Self {
        match e {
            ProfileError::Validation(m) => AppError::Validation(m),
            ProfileError::NotFound => AppError::NotFound("profile".into()),
            ProfileError::NoneConfigured => AppError::NoProfileConfigured,
            ProfileError::Db(m) => AppError::Db(m),
        }
    }
}

#[tauri::command]
pub fn agent_profiles_list(state: State<'_, AppState>) -> Result<Vec<AgentProfileView>, AppError> {
    let conn = state.db.lock().expect("db lock");
    Ok(profiles::list_agent_profiles(&conn)?)
}

#[tauri::command]
pub fn agent_profiles_upsert(
    state: State<'_, AppState>,
    input: AgentProfileInput,
) -> Result<AgentProfileView, AppError> {
    let conn = state.db.lock().expect("db lock");
    Ok(profiles::upsert_agent_profile(&conn, input)?)
}

#[tauri::command]
pub fn agent_profiles_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let conn = state.db.lock().expect("db lock");
    Ok(profiles::delete_agent_profile(&conn, &id)?)
}

#[tauri::command]
pub fn profiles_set_default(
    state: State<'_, AppState>,
    workspace_id: Option<String>,
    profile_id: Option<String>,
) -> Result<(), AppError> {
    let conn = state.db.lock().expect("db lock");
    Ok(profiles::set_default(&conn, workspace_id.as_deref(), profile_id.as_deref())?)
}

#[tauri::command]
pub fn profiles_resolve(
    state: State<'_, AppState>,
    task_override: Option<String>,
    workspace_id: Option<String>,
) -> Result<ResolvedAgentProfile, AppError> {
    let conn = state.db.lock().expect("db lock");
    Ok(profiles::resolve_agent_profile(
        &conn,
        task_override.as_deref(),
        workspace_id.as_deref(),
    )?)
}

/// Point the agent profile that uses `credential_profile_id` at a model.
///
/// Model choice previously existed only when a credential was first added, and
/// the list in Settings was not clickable, so a profile saved without one could
/// never be corrected from the UI — it just kept auto-selecting.
#[tauri::command]
pub fn agent_profile_set_model(
    state: State<'_, AppState>,
    credential_profile_id: String,
    model_id: String,
) -> Result<(), AppError> {
    let conn = state.db.lock().expect("db lock");
    let changed = conn.execute(
        "UPDATE agent_profiles SET model_id = ?1 WHERE credential_profile_id = ?2",
        rusqlite::params![&model_id, &credential_profile_id],
    )?;
    if changed == 0 {
        return Err(AppError::NotFound("agent profile for that credential".into()));
    }
    Ok(())
}
