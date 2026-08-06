//! Credential command surface. Deliberately NON-async: Tauri runs sync commands
//! on a blocking pool, which is exactly right for Keychain calls (they block)
//! and keeps DB access simple. No return type here can contain a secret —
//! `SecretString: !Serialize` makes that a compile error.

use tauri::State;

use crate::agent::oauth_discovery::{self, HostAuthSummary};
use crate::creds::store::{
    self, AddCredentialInput, CredError, CredentialProfileView, UsageReport,
};
use crate::error::AppError;
use crate::secret::SecretString;
use crate::AppState;

impl From<CredError> for AppError {
    fn from(e: CredError) -> Self {
        match e {
            CredError::Validation(m) => AppError::Validation(m),
            CredError::NotFound => AppError::NotFound("credential".into()),
            CredError::InUse => AppError::CredentialInUse,
            other => AppError::Internal(crate::secret::redact(&other.to_string())),
        }
    }
}

#[tauri::command]
pub fn creds_list(state: State<'_, AppState>) -> Result<Vec<CredentialProfileView>, AppError> {
    let conn = state.db.lock().expect("db lock");
    Ok(store::list(&conn)?)
}

#[tauri::command]
pub fn creds_add(
    state: State<'_, AppState>,
    input: AddCredentialInput,
) -> Result<CredentialProfileView, AppError> {
    let conn = state.db.lock().expect("db lock");
    Ok(store::add(&conn, state.keychain.as_ref(), input)?)
}

#[tauri::command]
pub fn creds_replace_secret(
    state: State<'_, AppState>,
    id: String,
    api_key: SecretString,
) -> Result<CredentialProfileView, AppError> {
    let conn = state.db.lock().expect("db lock");
    Ok(store::replace_secret(&conn, state.keychain.as_ref(), &id, api_key)?)
}

#[tauri::command]
pub fn creds_usage(state: State<'_, AppState>, id: String) -> Result<UsageReport, AppError> {
    let conn = state.db.lock().expect("db lock");
    Ok(store::usage(&conn, &id)?)
}

#[tauri::command]
pub fn creds_reassign(
    state: State<'_, AppState>,
    from_id: String,
    to_id: String,
) -> Result<UsageReport, AppError> {
    let mut conn = state.db.lock().expect("db lock");
    Ok(store::reassign(&mut conn, &from_id, &to_id)?)
}

#[tauri::command]
pub fn creds_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let conn = state.db.lock().expect("db lock");
    Ok(store::delete(&conn, state.keychain.as_ref(), &id)?)
}

#[tauri::command]
pub fn creds_discover_host_auth() -> Result<Vec<HostAuthSummary>, AppError> {
    Ok(oauth_discovery::discover())
}
