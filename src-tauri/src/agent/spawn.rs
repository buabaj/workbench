//! SpawnPlan: everything needed to launch a prime-agent child for one task,
//! with the selected credential injected by the safest available mechanism.
//!
//! Modes, in preference order per auth kind:
//! - api_key / custom_provider → IsolatedConfig (verified PRIME_AGENT_CODING_AGENT_DIR):
//!   ephemeral config dir, auth.json carries the env-var NAME, exactly one
//!   secret env var in the child. No argv, no disk, no global mutation.
//! - oauth_host → OauthClean: spawn against the user's real config dir, inject
//!   nothing, never read tokens.
//! - EnvOnly / Argv exist as documented fallbacks but are not reachable without
//!   explicit consent wiring (Argv) — kept for the ladder, disabled by default.

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use super::config_dir::{CustomProviderSpec, IsolatedConfigDir, PROVIDER_KEY_VAR};
use crate::creds::keychain::{account_for, Keychain};
use crate::creds::store::{self, AuthKind};
use crate::secret::SecretString;

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InjectionMode {
    IsolatedConfig,
    OauthClean,
    EnvOnly,
    Argv,
}

pub enum EnvValue {
    Plain(String),
    Secret(SecretString),
}

impl std::fmt::Debug for EnvValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EnvValue::Plain(v) => write!(f, "{v:?}"),
            EnvValue::Secret(_) => f.write_str("<redacted>"),
        }
    }
}

pub struct SpawnPlan {
    pub program: PathBuf,
    /// NEVER contains a secret unless mode == Argv (consent-gated, unwired).
    pub args: Vec<String>,
    pub env_set: Vec<(String, EnvValue)>,
    pub env_remove: Vec<String>,
    /// Kept alive for the child's lifetime; shredded on drop.
    pub config_dir: Option<IsolatedConfigDir>,
    pub mode: InjectionMode,
    pub provider_slug: Option<String>,
    pub model_id: Option<String>,
}

impl std::fmt::Debug for SpawnPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Custom impl: a derived Debug would print secret env values, and spawn
        // plans DO get logged while debugging.
        f.debug_struct("SpawnPlan")
            .field("program", &self.program)
            .field("args", &self.args)
            .field("env_set", &self.env_set)
            .field("env_remove", &self.env_remove)
            .field("mode", &self.mode)
            .field("provider_slug", &self.provider_slug)
            .field("model_id", &self.model_id)
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SpawnPlanError {
    #[error("agent profile not found")]
    ProfileNotFound,
    #[error("credential missing from keychain — re-add it in settings")]
    CredentialUnavailable,
    #[error("db: {0}")]
    Db(String),
    #[error("config dir: {0}")]
    ConfigDir(#[from] super::config_dir::ConfigDirError),
    #[error("{0}")]
    Cred(#[from] crate::creds::store::CredError),
    #[error("keychain: {0}")]
    Keychain(#[from] crate::creds::keychain::KeychainError),
}

impl From<rusqlite::Error> for SpawnPlanError {
    fn from(e: rusqlite::Error) -> Self {
        SpawnPlanError::Db(crate::secret::redact(&e.to_string()))
    }
}

pub struct SpawnContext<'a> {
    pub app_cache: &'a Path,
    pub real_agent_dir: &'a Path,
    pub program: PathBuf,
    pub path_env: String,
    pub session_dir: &'a Path,
    /// The workspace the agent operates in — its working directory.
    pub workspace_root: &'a Path,
}

pub fn build_spawn_plan(
    conn: &Connection,
    kc: &dyn Keychain,
    agent_profile_id: &str,
    task_id: &str,
    ctx: &SpawnContext<'_>,
) -> Result<SpawnPlan, SpawnPlanError> {
    let (cred_id, model_id): (String, Option<String>) = conn
        .query_row(
            "SELECT credential_profile_id, model_id FROM agent_profiles WHERE id = ?1",
            [agent_profile_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| SpawnPlanError::ProfileNotFound)?;

    let cred = store::get(conn, &cred_id)?.ok_or(SpawnPlanError::ProfileNotFound)?;

    let mut args = vec!["--mode".to_string(), "rpc".to_string()];
    // Explicit --cwd as well as the process working directory: the documented
    // flag is what the agent's own tooling reads, and env_clear() drops PWD.
    args.push("--cwd".into());
    args.push(ctx.workspace_root.to_string_lossy().into_owned());
    args.push("--session-dir".into());
    args.push(ctx.session_dir.to_string_lossy().into_owned());
    if let Some(model) = &model_id {
        args.push("--model".into());
        args.push(model.clone());
    }

    let mut env_set: Vec<(String, EnvValue)> =
        super::env::base_child_env(std::env::vars(), &ctx.path_env)
            .into_iter()
            .map(|(k, v)| (k, EnvValue::Plain(v)))
            .collect();
    let env_remove: Vec<String> = super::env::known_provider_vars()
        .into_iter()
        .map(String::from)
        .collect();

    match cred.auth_kind {
        AuthKind::OauthHost => {
            // Clean spawn: real config dir, nothing injected, tokens never read.
            if let Some(slug) = &cred.provider_slug {
                args.push("--provider".into());
                args.push(slug.clone());
            }
            Ok(SpawnPlan {
                program: ctx.program.clone(),
                args,
                env_set,
                env_remove,
                config_dir: None,
                mode: InjectionMode::OauthClean,
                provider_slug: cred.provider_slug,
                model_id,
            })
        }
        AuthKind::ApiKey => {
            let slug = cred
                .provider_slug
                .clone()
                .ok_or(SpawnPlanError::ProfileNotFound)?;
            let secret = kc
                .get(&account_for(&cred.id))?
                .ok_or(SpawnPlanError::CredentialUnavailable)?;

            let dir = IsolatedConfigDir::create(
                ctx.app_cache,
                task_id,
                ctx.real_agent_dir,
                &slug,
                None,
            )?;
            env_set.push((
                "PRIME_AGENT_CODING_AGENT_DIR".into(),
                EnvValue::Plain(dir.agent_dir().to_string_lossy().into_owned()),
            ));
            env_set.push((PROVIDER_KEY_VAR.into(), EnvValue::Secret(secret)));
            args.push("--provider".into());
            args.push(slug.clone());

            Ok(SpawnPlan {
                program: ctx.program.clone(),
                args,
                env_set,
                env_remove,
                config_dir: Some(dir),
                mode: InjectionMode::IsolatedConfig,
                provider_slug: Some(slug),
                model_id,
            })
        }
        AuthKind::CustomProvider => {
            let custom_id = cred
                .custom_provider_id
                .clone()
                .ok_or(SpawnPlanError::ProfileNotFound)?;
            let secret = kc
                .get(&account_for(&cred.id))?
                .ok_or(SpawnPlanError::CredentialUnavailable)?;

            let spec = load_custom_spec(conn, &custom_id)?;
            let namespaced = spec.namespaced_id.clone();
            let dir = IsolatedConfigDir::create(
                ctx.app_cache,
                task_id,
                ctx.real_agent_dir,
                &namespaced,
                Some(&spec),
            )?;
            env_set.push((
                "PRIME_AGENT_CODING_AGENT_DIR".into(),
                EnvValue::Plain(dir.agent_dir().to_string_lossy().into_owned()),
            ));
            env_set.push((PROVIDER_KEY_VAR.into(), EnvValue::Secret(secret)));
            args.push("--provider".into());
            args.push(namespaced.clone());

            Ok(SpawnPlan {
                program: ctx.program.clone(),
                args,
                env_set,
                env_remove,
                config_dir: Some(dir),
                mode: InjectionMode::IsolatedConfig,
                provider_slug: Some(namespaced),
                model_id,
            })
        }
    }
}

fn load_custom_spec(
    conn: &Connection,
    custom_id: &str,
) -> Result<CustomProviderSpec, SpawnPlanError> {
    conn.query_row(
        "SELECT id, base_url, api, auth_header, headers_json, models_json
           FROM custom_providers WHERE id = ?1",
        [custom_id],
        |r| {
            let id: String = r.get(0)?;
            Ok(CustomProviderSpec {
                namespaced_id: format!("workbench-{id}"),
                base_url: r.get(1)?,
                api: r.get(2)?,
                auth_header: r.get::<_, i64>(3)? != 0,
                headers: serde_json::from_str(&r.get::<_, String>(4)?)
                    .unwrap_or(serde_json::json!({})),
                models: serde_json::from_str(&r.get::<_, String>(5)?)
                    .unwrap_or(serde_json::json!([])),
            })
        },
    )
    .map_err(|_| SpawnPlanError::ProfileNotFound)
}
