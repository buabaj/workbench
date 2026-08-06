//! Per-task isolated agent config dir (injection mode: IsolatedConfig).
//!
//! Verified 2026-08-06: `PRIME_AGENT_CODING_AGENT_DIR` relocates prime-agent's
//! `.prime/agent` directory wholesale. We build an ephemeral dir containing:
//! - `auth.json` (0600) with EXACTLY ONE provider entry whose `key` is the
//!   env-var NAME `WORKBENCH_PROVIDER_KEY` — zero secret bytes on disk;
//! - `models.json` for custom providers (also env-var-name only);
//! - symlinks to everything else in the user's real `~/.prime/agent` (settings,
//!   extensions, skills, kernel-venv, …) so the agent behaves identically.
//!
//! `auth.json` is never symlinked and never copied — that is what keeps the
//! user's other credentials and OAuth tokens out of the child.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// The single, constant env var that carries the one selected credential.
pub const PROVIDER_KEY_VAR: &str = "WORKBENCH_PROVIDER_KEY";

/// Entries that must NEVER be linked into the isolated dir.
const NEVER_LINK: &[&str] = &[
    "auth.json",
    "models.json",
    "sessions",
    "session-artifacts",
    "session-leases",
    "logs",
];

#[derive(Debug, thiserror::Error)]
pub enum ConfigDirError {
    #[error("io: {0}")]
    Io(String),
    #[error("invalid custom provider config: {0}")]
    Invalid(String),
}

impl From<std::io::Error> for ConfigDirError {
    fn from(e: std::io::Error) -> Self {
        ConfigDirError::Io(e.to_string())
    }
}

/// RAII: the directory tree is removed on drop and swept at startup.
pub struct IsolatedConfigDir {
    root: PathBuf,
    agent_dir: PathBuf,
}

pub struct CustomProviderSpec {
    pub namespaced_id: String, // "workbench-<ULID>"
    pub base_url: String,
    pub api: String,
    pub auth_header: bool,
    pub headers: serde_json::Value,
    pub models: serde_json::Value,
}

impl IsolatedConfigDir {
    /// Base directory for all isolated configs (per-app cache, 0700).
    pub fn base_dir(app_cache: &Path) -> PathBuf {
        app_cache.join("agent-conf")
    }

    /// Remove every leftover tree — crash safety. Contains no secrets, but
    /// stale symlink farms are noise.
    pub fn sweep(app_cache: &Path) {
        let base = Self::base_dir(app_cache);
        if base.exists() {
            let _ = std::fs::remove_dir_all(&base);
        }
    }

    pub fn create(
        app_cache: &Path,
        task_id: &str,
        real_agent_dir: &Path,
        provider_slug: &str,
        custom: Option<&CustomProviderSpec>,
    ) -> Result<Self, ConfigDirError> {
        let root = Self::base_dir(app_cache).join(task_id);
        let agent_dir = root.join("agent");
        std::fs::create_dir_all(&agent_dir)?;
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;

        // auth.json: one provider entry, env-var NAME as the key value.
        let auth = serde_json::json!({
            provider_slug: { "type": "api_key", "key": PROVIDER_KEY_VAR }
        });
        let auth_path = agent_dir.join("auth.json");
        std::fs::write(&auth_path, serde_json::to_vec_pretty(&auth).unwrap())?;
        std::fs::set_permissions(&auth_path, std::fs::Permissions::from_mode(0o600))?;

        // models.json for custom providers — a fresh file in the isolated dir,
        // so the user's real models.json is untouched entirely.
        if let Some(spec) = custom {
            validate_custom(spec)?;
            let models = serde_json::json!({
                "providers": {
                    &spec.namespaced_id: {
                        "baseUrl": spec.base_url,
                        "api": spec.api,
                        "apiKey": PROVIDER_KEY_VAR,
                        "authHeader": spec.auth_header,
                        "headers": spec.headers,
                        "models": spec.models,
                    }
                }
            });
            let models_path = agent_dir.join("models.json");
            std::fs::write(&models_path, serde_json::to_vec_pretty(&models).unwrap())?;
            std::fs::set_permissions(&models_path, std::fs::Permissions::from_mode(0o600))?;
        }

        // Symlink the rest of the user's real agent dir.
        if real_agent_dir.is_dir() {
            for entry in std::fs::read_dir(real_agent_dir)? {
                let entry = entry?;
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if NEVER_LINK.contains(&name_str.as_ref()) {
                    continue;
                }
                let link = agent_dir.join(&name);
                if !link.exists() {
                    std::os::unix::fs::symlink(entry.path(), &link)?;
                }
            }
        }

        Ok(IsolatedConfigDir { root, agent_dir })
    }

    /// Value for `PRIME_AGENT_CODING_AGENT_DIR`.
    pub fn agent_dir(&self) -> &Path {
        &self.agent_dir
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

impl Drop for IsolatedConfigDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn validate_custom(spec: &CustomProviderSpec) -> Result<(), ConfigDirError> {
    const APIS: [&str; 4] = [
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
        "google-generative-ai",
    ];
    if !APIS.contains(&spec.api.as_str()) {
        return Err(ConfigDirError::Invalid(format!("api '{}' not supported", spec.api)));
    }
    if spec.base_url.is_empty() {
        return Err(ConfigDirError::Invalid("baseUrl required".into()));
    }
    if !spec.namespaced_id.starts_with("workbench-") {
        return Err(ConfigDirError::Invalid("provider id must be workbench-namespaced".into()));
    }
    // Headers must not smuggle secrets: values that look like key material are
    // rejected — the one secret always travels via the env-var indirection.
    if let Some(obj) = spec.headers.as_object() {
        for (k, v) in obj {
            let val = v.as_str().unwrap_or("");
            let looks_secret = ["sk-", "pit_", "ghp_", "Bearer ", "AIza"]
                .iter()
                .any(|p| val.contains(p));
            if looks_secret {
                return Err(ConfigDirError::Invalid(format!(
                    "header '{k}' appears to contain a secret; use the credential instead"
                )));
            }
        }
    }
    Ok(())
}
