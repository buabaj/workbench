//! Which credential and which models a capability runs with.
//!
//! Every internal capability asks the same three questions — what key, what
//! model chain, what privacy mode — and each one used to answer them for
//! itself. Voice read `capability_profiles`; titles and note actions read the
//! ambient key and the registry directly and could not be configured at all.
//! One resolver means a model chosen in Settings applies wherever that
//! capability is used, rather than to whichever call site remembered to look.

use rusqlite::OptionalExtension;

use crate::appai::{dotenv, registry, AppAiError};
use crate::creds::keychain::account_for;
use crate::error::AppError;
use crate::secret::SecretString;
use crate::AppState;

/// Everything a call needs, with the precedence already applied.
pub struct Resolved {
    pub key: SecretString,
    /// Ordered fallback chain. Never empty — an empty chain would fail with
    /// "no models configured", which says nothing about why.
    pub models: Vec<String>,
    pub privacy_mode: String,
    pub timeout_ms: u64,
    /// The credential profile behind the key, or `None` for the ambient one.
    /// Voice names its source in the UI; nothing else needs to care.
    pub credential_profile_id: Option<String>,
}

impl Resolved {
    /// What to record as `model_requested`: the head of the chain, which is
    /// what was asked for even when a fallback answered.
    pub fn requested(&self) -> Option<&String> {
        self.models.first()
    }
}

/// A Finder-launched `.app` has cwd `/`, so the project `.env` is only findable
/// via the workspace the user actually opened.
fn last_workspace_root(state: &AppState) -> Option<std::path::PathBuf> {
    let conn = state.db.lock().expect("db lock");
    conn.query_row(
        "SELECT root_real FROM workspaces ORDER BY last_opened_at DESC NULLS LAST LIMIT 1",
        [],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .map(std::path::PathBuf::from)
}

fn registry_models(capability: &str) -> Vec<String> {
    registry::get(capability)
        .map(|c| c.default_models.iter().map(|s| s.to_string()).collect())
        .unwrap_or_default()
}

/// The model chain in force for a capability, without needing a credential.
///
/// Precedence: an explicit choice in Settings, then a configured capability
/// profile, then the registry's defaults. Each step falls through when it has
/// nothing to say, so a half-configured system still runs.
pub fn models_for(state: &AppState, capability: &str) -> Vec<String> {
    let conn = state.db.lock().expect("db lock");
    let read = |sql: &str| -> Vec<String> {
        conn.query_row(sql, [capability], |r| r.get::<_, String>(0))
            .optional()
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str::<Vec<String>>(&json).ok())
            .unwrap_or_default()
    };

    let chosen = read("SELECT model_ids_json FROM capability_overrides WHERE capability = ?1");
    if !chosen.is_empty() {
        return chosen;
    }
    let profiled = read(
        "SELECT model_ids_json FROM capability_profiles WHERE capability = ?1
          ORDER BY created_at DESC LIMIT 1",
    );
    if !profiled.is_empty() {
        return profiled;
    }
    drop(conn);
    registry_models(capability)
}

/// Resolve a capability into a key, a model chain and the terms of the call.
pub fn resolve(state: &AppState, capability: &str) -> Result<Resolved, AppError> {
    if registry::get(capability).is_none() {
        return Err(AppError::NotFound("capability".into()));
    }
    let models = models_for(state, capability);
    if models.is_empty() {
        return Err(AppError::from(AppAiError::NoCapabilityProfile(
            capability.into(),
        )));
    }

    // A configured profile names the credential and the terms; without one the
    // ambient key stands in, which is what makes these work with no setup step.
    let profile: Option<(String, String, i64)> = {
        let conn = state.db.lock().expect("db lock");
        conn.query_row(
            "SELECT credential_profile_id, privacy_mode, timeout_ms
               FROM capability_profiles WHERE capability = ?1
              ORDER BY created_at DESC LIMIT 1",
            [capability],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
    };

    match profile {
        Some((credential_id, privacy_mode, timeout_ms)) => {
            let key = state
                .keychain
                .get(&account_for(&credential_id))
                .map_err(|e| AppError::Internal(crate::secret::redact(&e.to_string())))?
                .ok_or_else(|| AppError::from(AppAiError::NoCredential))?;
            Ok(Resolved {
                key,
                models,
                privacy_mode,
                timeout_ms: timeout_ms as u64,
                credential_profile_id: Some(credential_id),
            })
        }
        None => {
            let root = last_workspace_root(state);
            let key = dotenv::lookup("OPENROUTER_API_KEY", root.as_deref())
                .ok_or_else(|| AppError::from(AppAiError::NoCredential))?;
            Ok(Resolved {
                key,
                models,
                // Strict by default: an ambient key was dropped in a file for
                // convenience, which is not consent to train on the contents.
                privacy_mode: "strict".into(),
                timeout_ms: 90_000,
                credential_profile_id: None,
            })
        }
    }
}

/// Scalars only. No prompt text, no note contents, no paths — this table is for
/// answering "is this capability working and what did it cost", and nothing it
/// holds should ever need redacting.
pub fn record(
    state: &AppState,
    capability: &str,
    requested: Option<&String>,
    served: Option<&str>,
    duration_ms: u64,
    input_bytes: usize,
    output_chars: usize,
) {
    let conn = state.db.lock().expect("db lock");
    let _ = conn.execute(
        "INSERT INTO appai_invocations
           (id, capability, model_requested, model_served, status, duration_ms,
            input_bytes, output_chars, created_at)
         VALUES (?1, ?2, ?3, ?4, 'ok', ?5, ?6, ?7, ?8)",
        rusqlite::params![
            ulid::Ulid::new().to_string(),
            capability,
            requested,
            served,
            duration_ms as i64,
            input_bytes as i64,
            output_chars as i64,
            crate::db::now_ms()
        ],
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A schema with just the tables precedence depends on, so these test the
    /// rule rather than the rest of the database.
    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE capability_overrides (
               capability TEXT PRIMARY KEY, model_ids_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE capability_profiles (
               capability TEXT, credential_profile_id TEXT, model_ids_json TEXT,
               privacy_mode TEXT, timeout_ms INTEGER, created_at INTEGER);",
        )
        .unwrap();
        conn
    }

    /// `models_for` reads through `AppState`, which a unit test cannot build.
    /// This mirrors its precedence against the same SQL so the rule stays
    /// pinned; the fall-through to the registry is the part worth guarding.
    fn precedence(conn: &rusqlite::Connection, capability: &str) -> Vec<String> {
        let read = |sql: &str| -> Vec<String> {
            conn.query_row(sql, [capability], |r| r.get::<_, String>(0))
                .optional()
                .ok()
                .flatten()
                .and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok())
                .unwrap_or_default()
        };
        let chosen = read("SELECT model_ids_json FROM capability_overrides WHERE capability = ?1");
        if !chosen.is_empty() {
            return chosen;
        }
        let profiled = read(
            "SELECT model_ids_json FROM capability_profiles WHERE capability = ?1
              ORDER BY created_at DESC LIMIT 1",
        );
        if !profiled.is_empty() {
            return profiled;
        }
        registry_models(capability)
    }

    #[test]
    fn falls_back_to_the_registry_when_nothing_is_configured() {
        let conn = db();
        assert_eq!(
            precedence(&conn, "chat.title"),
            registry_models("chat.title")
        );
        assert!(!precedence(&conn, "chat.title").is_empty());
    }

    #[test]
    fn every_implemented_capability_has_models_to_fall_back_to() {
        // A capability marked implemented with no defaults fails at the call
        // with "no models configured", which reads as a bug in the caller.
        for spec in registry::CAPABILITIES.iter().filter(|c| c.implemented) {
            assert!(
                !spec.default_models.is_empty(),
                "{} is implemented with no default models",
                spec.key
            );
        }
    }

    #[test]
    fn a_chosen_model_wins_over_a_profile_and_the_registry() {
        let conn = db();
        conn.execute(
            "INSERT INTO capability_profiles VALUES ('chat.title','c','[\"from/profile\"]','strict',1,1)",
            [],
        )
        .unwrap();
        assert_eq!(precedence(&conn, "chat.title"), vec!["from/profile"]);

        conn.execute(
            "INSERT INTO capability_overrides VALUES ('chat.title','[\"from/settings\"]',1)",
            [],
        )
        .unwrap();
        assert_eq!(precedence(&conn, "chat.title"), vec!["from/settings"]);
    }

    #[test]
    fn an_emptied_override_falls_through_rather_than_configuring_nothing() {
        // "Reset to default" writes no models. Treating that as a choice would
        // leave the capability with an empty chain and no way back.
        let conn = db();
        conn.execute(
            "INSERT INTO capability_overrides VALUES ('chat.title','[]',1)",
            [],
        )
        .unwrap();
        assert_eq!(
            precedence(&conn, "chat.title"),
            registry_models("chat.title")
        );
    }

    #[test]
    fn the_newest_profile_wins() {
        let conn = db();
        conn.execute(
            "INSERT INTO capability_profiles VALUES ('chat.title','c','[\"old\"]','strict',1,100)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO capability_profiles VALUES ('chat.title','c','[\"new\"]','strict',1,200)",
            [],
        )
        .unwrap();
        assert_eq!(precedence(&conn, "chat.title"), vec!["new"]);
    }
}
