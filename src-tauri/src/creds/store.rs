//! Credential CRUD. Order of operations is chosen so a crash can only leave a
//! harmless orphaned Keychain item (swept implicitly on replace/delete), never
//! a DB row pointing at a missing secret mid-add, and never a secret without
//! its metadata.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::Digest;

use super::keychain::{account_for, Keychain};
use crate::db::now_ms;
use crate::secret::SecretString;

#[derive(Debug, thiserror::Error)]
pub enum CredError {
    #[error("keychain: {0}")]
    Keychain(#[from] super::keychain::KeychainError),
    #[error("db: {0}")]
    Db(String),
    #[error("validation: {0}")]
    Validation(String),
    #[error("credential is in use and cannot be deleted")]
    InUse,
    #[error("not found")]
    NotFound,
}

impl From<rusqlite::Error> for CredError {
    fn from(e: rusqlite::Error) -> Self {
        CredError::Db(crate::secret::redact(&e.to_string()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthKind {
    ApiKey,
    OauthHost,
    CustomProvider,
}

impl AuthKind {
    fn as_str(&self) -> &'static str {
        match self {
            AuthKind::ApiKey => "api_key",
            AuthKind::OauthHost => "oauth_host",
            AuthKind::CustomProvider => "custom_provider",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "oauth_host" => AuthKind::OauthHost,
            "custom_provider" => AuthKind::CustomProvider,
            _ => AuthKind::ApiKey,
        }
    }
}

/// Input for add. THE ONLY SECRET-BEARING TYPE IN THE COMMAND SURFACE.
/// Deserialize-only by virtue of `SecretString`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCredentialInput {
    pub label: String,
    pub auth_kind: AuthKind,
    pub provider_slug: Option<String>,
    pub custom_provider_id: Option<String>,
    #[serde(default = "default_scope")]
    pub scope: String,
    pub api_key: Option<SecretString>,
}

fn default_scope() -> String {
    "agent".into()
}

/// Metadata view. NO secret field exists on this type.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialProfileView {
    pub id: String,
    pub label: String,
    pub auth_kind: AuthKind,
    pub provider_slug: Option<String>,
    pub custom_provider_id: Option<String>,
    pub scope: String,
    pub key_fingerprint: Option<String>,
    pub has_secret: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRef {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub agent_profiles: Vec<ProfileRef>,
    pub capability_profiles: Vec<ProfileRef>,
    pub is_default_in: Vec<String>,
    pub blocked: bool,
}

pub fn fingerprint(secret: &SecretString) -> String {
    let hash = sha2::Sha256::digest(secret.expose().as_bytes());
    hash.iter().take(6).map(|b| format!("{b:02x}")).collect()
}

fn validate(input: &AddCredentialInput) -> Result<(), CredError> {
    if input.label.trim().is_empty() {
        return Err(CredError::Validation("label must not be empty".into()));
    }
    match input.auth_kind {
        AuthKind::ApiKey => {
            let slug = input
                .provider_slug
                .as_deref()
                .ok_or_else(|| CredError::Validation("provider_slug required".into()))?;
            if !super::is_known_slug(slug) {
                return Err(CredError::Validation(format!("unknown provider slug '{slug}'")));
            }
            let key = input
                .api_key
                .as_ref()
                .ok_or_else(|| CredError::Validation("api_key required".into()))?;
            if key.is_empty() || key.expose().chars().any(|c| c.is_whitespace()) {
                return Err(CredError::Validation(
                    "api_key must be non-empty with no whitespace".into(),
                ));
            }
        }
        AuthKind::CustomProvider => {
            if input.custom_provider_id.is_none() {
                return Err(CredError::Validation("custom_provider_id required".into()));
            }
            if input.api_key.is_none() {
                return Err(CredError::Validation("api_key required".into()));
            }
        }
        AuthKind::OauthHost => {
            if input.api_key.is_some() {
                return Err(CredError::Validation(
                    "oauth_host profiles carry no key — the host session is used".into(),
                ));
            }
            if input.provider_slug.is_none() {
                return Err(CredError::Validation("provider_slug required".into()));
            }
        }
    }
    Ok(())
}

pub fn add(
    conn: &Connection,
    kc: &dyn Keychain,
    input: AddCredentialInput,
) -> Result<CredentialProfileView, CredError> {
    validate(&input)?;
    let id = ulid::Ulid::new().to_string();
    let now = now_ms();

    let (account, fp) = match &input.api_key {
        Some(key) => {
            let account = account_for(&id);
            // Keychain first: a crash after this leaves an orphaned item
            // (harmless), never a row without its secret.
            kc.set(&account, key)?;
            (Some(account), Some(fingerprint(key)))
        }
        None => (None, None),
    };

    let inserted = conn.execute(
        "INSERT INTO credential_profiles
           (id, label, auth_kind, provider_slug, custom_provider_id,
            keychain_account, scope, key_fingerprint, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        rusqlite::params![
            id,
            input.label.trim(),
            input.auth_kind.as_str(),
            input.provider_slug,
            input.custom_provider_id,
            account,
            input.scope,
            fp,
            now
        ],
    );
    if let Err(e) = inserted {
        // Compensating delete so a failed insert leaves nothing behind.
        if let Some(acct) = &account {
            let _ = kc.delete(acct);
        }
        return Err(e.into());
    }

    get(conn, &id)?.ok_or(CredError::NotFound)
}

pub fn replace_secret(
    conn: &Connection,
    kc: &dyn Keychain,
    id: &str,
    api_key: SecretString,
) -> Result<CredentialProfileView, CredError> {
    let view = get(conn, id)?.ok_or(CredError::NotFound)?;
    if view.auth_kind == AuthKind::OauthHost {
        return Err(CredError::Validation("oauth_host profiles carry no key".into()));
    }
    // Overwrite in place — same account, preserving the Keychain ACL. Never
    // delete-then-add (that re-triggers the allow prompt).
    let account = account_for(id);
    kc.set(&account, &api_key)?;
    conn.execute(
        "UPDATE credential_profiles
           SET key_fingerprint = ?1, last_tested_at = NULL, last_test_status = NULL,
               last_test_detail = NULL, updated_at = ?2
         WHERE id = ?3",
        rusqlite::params![fingerprint(&api_key), now_ms(), id],
    )?;
    get(conn, id)?.ok_or(CredError::NotFound)
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<CredentialProfileView>, CredError> {
    conn.query_row(
        "SELECT id, label, auth_kind, provider_slug, custom_provider_id, scope,
                key_fingerprint, keychain_account, created_at, updated_at
           FROM credential_profiles WHERE id = ?1",
        [id],
        row_to_view,
    )
    .optional()
    .map_err(Into::into)
}

pub fn list(conn: &Connection) -> Result<Vec<CredentialProfileView>, CredError> {
    let mut stmt = conn.prepare(
        "SELECT id, label, auth_kind, provider_slug, custom_provider_id, scope,
                key_fingerprint, keychain_account, created_at, updated_at
           FROM credential_profiles ORDER BY created_at",
    )?;
    let rows = stmt
        .query_map([], row_to_view)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn row_to_view(row: &rusqlite::Row<'_>) -> rusqlite::Result<CredentialProfileView> {
    Ok(CredentialProfileView {
        id: row.get(0)?,
        label: row.get(1)?,
        auth_kind: AuthKind::parse(&row.get::<_, String>(2)?),
        provider_slug: row.get(3)?,
        custom_provider_id: row.get(4)?,
        scope: row.get(5)?,
        key_fingerprint: row.get(6)?,
        has_secret: row.get::<_, Option<String>>(7)?.is_some(),
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

pub fn usage(conn: &Connection, id: &str) -> Result<UsageReport, CredError> {
    let collect = |sql: &str| -> Result<Vec<ProfileRef>, CredError> {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map([id], |r| {
                Ok(ProfileRef {
                    id: r.get(0)?,
                    label: r.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    };
    let agent_profiles = collect(
        "SELECT id, label FROM agent_profiles WHERE credential_profile_id = ?1",
    )?;
    let capability_profiles = collect(
        "SELECT id, label FROM capability_profiles WHERE credential_profile_id = ?1",
    )?;

    let mut is_default_in = Vec::new();
    let default_agent: Option<String> = conn
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = 'default_agent_profile_id'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(v) = default_agent {
        if agent_profiles
            .iter()
            .any(|p| v.trim_matches('"') == p.id)
        {
            is_default_in.push("app:default_agent_profile_id".to_string());
        }
    }

    let blocked = !agent_profiles.is_empty() || !capability_profiles.is_empty();
    Ok(UsageReport {
        agent_profiles,
        capability_profiles,
        is_default_in,
        blocked,
    })
}

pub fn reassign(
    conn: &mut Connection,
    from_id: &str,
    to_id: &str,
) -> Result<UsageReport, CredError> {
    if get(conn, to_id)?.is_none() {
        return Err(CredError::NotFound);
    }
    let tx = conn.transaction().map_err(CredError::from)?;
    tx.execute(
        "UPDATE agent_profiles SET credential_profile_id = ?1 WHERE credential_profile_id = ?2",
        [to_id, from_id],
    )?;
    tx.execute(
        "UPDATE capability_profiles SET credential_profile_id = ?1 WHERE credential_profile_id = ?2",
        [to_id, from_id],
    )?;
    tx.commit().map_err(CredError::from)?;
    usage(conn, from_id)
}

pub fn delete(conn: &Connection, kc: &dyn Keychain, id: &str) -> Result<(), CredError> {
    let view = get(conn, id)?.ok_or(CredError::NotFound)?;
    let report = usage(conn, id)?;
    if report.blocked {
        return Err(CredError::InUse);
    }
    // FK RESTRICT is the backstop if usage() missed something.
    conn.execute("DELETE FROM credential_profiles WHERE id = ?1", [id])
        .map_err(|e| {
            if e.to_string().contains("FOREIGN KEY") {
                CredError::InUse
            } else {
                e.into()
            }
        })?;
    if view.has_secret {
        // After the row is gone; idempotent, so a crash between leaves only a
        // harmless orphan.
        kc.delete(&account_for(id))?;
    }
    Ok(())
}
