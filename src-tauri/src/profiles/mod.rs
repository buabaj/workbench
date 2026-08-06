//! Agent + capability profiles: CRUD and default resolution.
//!
//! Resolution order is explicit and never falls back to "any profile that
//! happens to exist": task override → workspace default → app default → Err.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::now_ms;

#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error("db: {0}")]
    Db(String),
    #[error("not found")]
    NotFound,
    #[error("no profile configured — set one up in settings")]
    NoneConfigured,
    #[error("validation: {0}")]
    Validation(String),
}

impl From<rusqlite::Error> for ProfileError {
    fn from(e: rusqlite::Error) -> Self {
        ProfileError::Db(crate::secret::redact(&e.to_string()))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileView {
    pub id: String,
    pub label: String,
    pub credential_profile_id: String,
    pub model_id: Option<String>,
    pub thinking_level: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileInput {
    pub id: Option<String>,
    pub label: String,
    pub credential_profile_id: String,
    pub model_id: Option<String>,
    pub thinking_level: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    Task,
    Workspace,
    App,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAgentProfile {
    pub profile: AgentProfileView,
    pub origin: Origin,
}

const THINKING: [&str; 6] = ["off", "minimal", "low", "medium", "high", "xhigh"];

pub fn upsert_agent_profile(
    conn: &Connection,
    input: AgentProfileInput,
) -> Result<AgentProfileView, ProfileError> {
    if input.label.trim().is_empty() {
        return Err(ProfileError::Validation("label must not be empty".into()));
    }
    if let Some(t) = &input.thinking_level {
        if !THINKING.contains(&t.as_str()) {
            return Err(ProfileError::Validation(format!("bad thinking level '{t}'")));
        }
    }
    let now = now_ms();
    let id = input.id.unwrap_or_else(|| ulid::Ulid::new().to_string());
    conn.execute(
        "INSERT INTO agent_profiles (id, label, credential_profile_id, model_id, thinking_level, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           credential_profile_id = excluded.credential_profile_id,
           model_id = excluded.model_id,
           thinking_level = excluded.thinking_level,
           updated_at = excluded.updated_at",
        rusqlite::params![id, input.label.trim(), input.credential_profile_id, input.model_id, input.thinking_level, now],
    )?;
    get_agent_profile(conn, &id)?.ok_or(ProfileError::NotFound)
}

pub fn get_agent_profile(
    conn: &Connection,
    id: &str,
) -> Result<Option<AgentProfileView>, ProfileError> {
    conn.query_row(
        "SELECT id, label, credential_profile_id, model_id, thinking_level
           FROM agent_profiles WHERE id = ?1",
        [id],
        |r| {
            Ok(AgentProfileView {
                id: r.get(0)?,
                label: r.get(1)?,
                credential_profile_id: r.get(2)?,
                model_id: r.get(3)?,
                thinking_level: r.get(4)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

pub fn list_agent_profiles(conn: &Connection) -> Result<Vec<AgentProfileView>, ProfileError> {
    let mut stmt = conn.prepare(
        "SELECT id, label, credential_profile_id, model_id, thinking_level
           FROM agent_profiles ORDER BY created_at",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(AgentProfileView {
                id: r.get(0)?,
                label: r.get(1)?,
                credential_profile_id: r.get(2)?,
                model_id: r.get(3)?,
                thinking_level: r.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete_agent_profile(conn: &Connection, id: &str) -> Result<(), ProfileError> {
    let n = conn.execute("DELETE FROM agent_profiles WHERE id = ?1", [id])?;
    if n == 0 {
        return Err(ProfileError::NotFound);
    }
    Ok(())
}

// ── defaults ──────────────────────────────────────────────────────────────

const DEFAULT_KEY: &str = "default_agent_profile_id";

pub fn set_default(
    conn: &Connection,
    workspace_id: Option<&str>,
    profile_id: Option<&str>,
) -> Result<(), ProfileError> {
    match (workspace_id, profile_id) {
        (None, Some(pid)) => {
            conn.execute(
                "INSERT INTO app_settings (key, value_json) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
                rusqlite::params![DEFAULT_KEY, serde_json::to_string(pid).unwrap()],
            )?;
        }
        (None, None) => {
            conn.execute("DELETE FROM app_settings WHERE key = ?1", [DEFAULT_KEY])?;
        }
        (Some(ws), Some(pid)) => {
            conn.execute(
                "INSERT INTO workspace_settings (workspace_id, key, value_json) VALUES (?1, ?2, ?3)
                 ON CONFLICT(workspace_id, key) DO UPDATE SET value_json = excluded.value_json",
                rusqlite::params![ws, DEFAULT_KEY, serde_json::to_string(pid).unwrap()],
            )?;
        }
        (Some(ws), None) => {
            conn.execute(
                "DELETE FROM workspace_settings WHERE workspace_id = ?1 AND key = ?2",
                rusqlite::params![ws, DEFAULT_KEY],
            )?;
        }
    }
    Ok(())
}

fn setting(conn: &Connection, workspace_id: Option<&str>) -> Result<Option<String>, ProfileError> {
    let raw: Option<String> = match workspace_id {
        Some(ws) => conn
            .query_row(
                "SELECT value_json FROM workspace_settings WHERE workspace_id = ?1 AND key = ?2",
                rusqlite::params![ws, DEFAULT_KEY],
                |r| r.get(0),
            )
            .optional()?,
        None => conn
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = ?1",
                [DEFAULT_KEY],
                |r| r.get(0),
            )
            .optional()?,
    };
    Ok(raw.and_then(|v| serde_json::from_str::<String>(&v).ok()))
}

/// task override → workspace default → app default → Err(NoneConfigured).
pub fn resolve_agent_profile(
    conn: &Connection,
    task_override: Option<&str>,
    workspace_id: Option<&str>,
) -> Result<ResolvedAgentProfile, ProfileError> {
    if let Some(id) = task_override {
        let profile = get_agent_profile(conn, id)?.ok_or(ProfileError::NotFound)?;
        return Ok(ResolvedAgentProfile { profile, origin: Origin::Task });
    }
    if let Some(ws) = workspace_id {
        if let Some(id) = setting(conn, Some(ws))? {
            if let Some(profile) = get_agent_profile(conn, &id)? {
                return Ok(ResolvedAgentProfile { profile, origin: Origin::Workspace });
            }
        }
    }
    if let Some(id) = setting(conn, None)? {
        if let Some(profile) = get_agent_profile(conn, &id)? {
            return Ok(ResolvedAgentProfile { profile, origin: Origin::App });
        }
    }
    Err(ProfileError::NoneConfigured)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::creds::keychain::MemKeychain;
    use crate::creds::store::{add, AddCredentialInput, AuthKind};
    use crate::secret::SecretString;

    fn setup() -> (rusqlite::Connection, String) {
        let conn = crate::db::open_in_memory().unwrap();
        let kc = MemKeychain::default();
        let cred = add(
            &conn,
            &kc,
            AddCredentialInput {
                label: "test anthropic".into(),
                auth_kind: AuthKind::ApiKey,
                provider_slug: Some("anthropic".into()),
                custom_provider_id: None,
                scope: "agent".into(),
                api_key: Some(SecretString::new("sk-ant-test1234567890".into())),
            },
        )
        .unwrap();
        (conn, cred.id)
    }

    #[test]
    fn resolution_order_task_workspace_app() {
        let (conn, cred_id) = setup();
        let p_app = upsert_agent_profile(&conn, AgentProfileInput {
            id: None, label: "app default".into(),
            credential_profile_id: cred_id.clone(), model_id: None, thinking_level: None,
        }).unwrap();
        let p_ws = upsert_agent_profile(&conn, AgentProfileInput {
            id: None, label: "ws default".into(),
            credential_profile_id: cred_id.clone(), model_id: None, thinking_level: None,
        }).unwrap();
        let p_task = upsert_agent_profile(&conn, AgentProfileInput {
            id: None, label: "task override".into(),
            credential_profile_id: cred_id, model_id: None, thinking_level: None,
        }).unwrap();

        // Nothing configured → NoneConfigured, never "whatever exists".
        assert!(matches!(
            resolve_agent_profile(&conn, None, None),
            Err(ProfileError::NoneConfigured)
        ));

        conn.execute(
            "INSERT INTO workspaces (id, name, root_path, root_real, kind, created_at)
             VALUES ('ws1', 'w', '/x', '/x', 'plain', 0)",
            [],
        ).unwrap();

        set_default(&conn, None, Some(&p_app.id)).unwrap();
        let r = resolve_agent_profile(&conn, None, Some("ws1")).unwrap();
        assert_eq!(r.origin, Origin::App);

        set_default(&conn, Some("ws1"), Some(&p_ws.id)).unwrap();
        let r = resolve_agent_profile(&conn, None, Some("ws1")).unwrap();
        assert_eq!(r.origin, Origin::Workspace);
        assert_eq!(r.profile.id, p_ws.id);

        let r = resolve_agent_profile(&conn, Some(&p_task.id), Some("ws1")).unwrap();
        assert_eq!(r.origin, Origin::Task);
        assert_eq!(r.profile.id, p_task.id);
    }

    #[test]
    fn bad_thinking_level_rejected() {
        let (conn, cred_id) = setup();
        let err = upsert_agent_profile(&conn, AgentProfileInput {
            id: None, label: "x".into(),
            credential_profile_id: cred_id, model_id: None,
            thinking_level: Some("ultra".into()),
        });
        assert!(matches!(err, Err(ProfileError::Validation(_))));
    }
}
