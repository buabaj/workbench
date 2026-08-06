//! Discover which credentials already exist on the host — by NAME only.
//!
//! Structural guarantee: `AuthEntryMeta` declares only `type`, so serde's
//! derived visitor skips the `key` field without ever materializing it into a
//! Rust value. The read buffer is `Zeroizing`. There is no code path in this
//! module that reads, copies, logs, or returns a key value.
//!
//! Two sources (verified on this machine 2026-08-06):
//! - `~/.prime/agent/auth.json` — per-provider API keys and OAuth tokens.
//! - `~/.prime/config.json` — the prime CLI's own config; an `api_key` here is
//!   an AMBIENT Prime Inference credential that reaches any prime-agent child
//!   even under config-dir isolation (it lives outside the agent dir).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Deserialize)]
struct AuthEntryMeta {
    // `key` is deliberately NOT declared here.
    #[serde(rename = "type", default)]
    kind: String,
}

#[derive(Deserialize)]
struct PrimeConfigMeta {
    // value skipped: we only care whether the field exists and is non-empty —
    // deserialize into a bool via a presence check on a String we drop inside
    // a Zeroizing buffer scope.
    #[serde(default)]
    api_key: Option<ZeroizedPresence>,
}

/// Deserializes any string into a presence marker; the transient String is
/// zeroized immediately.
struct ZeroizedPresence {
    present: bool,
}

impl<'de> Deserialize<'de> for ZeroizedPresence {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = Zeroizing::new(String::deserialize(deserializer)?);
        Ok(ZeroizedPresence {
            present: !s.is_empty(),
        })
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostAuthSummary {
    pub provider_slug: String,
    pub auth_type: String,
    pub is_oauth: bool,
    /// Ambient credentials (config.json) reach children even under isolation.
    pub is_ambient: bool,
}

pub fn prime_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".prime")
}

pub fn discover() -> Vec<HostAuthSummary> {
    discover_at(&prime_home())
}

pub fn discover_at(prime_dir: &Path) -> Vec<HostAuthSummary> {
    let mut out = Vec::new();

    // ~/.prime/agent/auth.json
    if let Ok(bytes) = std::fs::read(prime_dir.join("agent/auth.json")) {
        let bytes = Zeroizing::new(bytes);
        if let Ok(map) = serde_json::from_slice::<HashMap<String, AuthEntryMeta>>(&bytes) {
            for (slug, meta) in map {
                let is_oauth = meta.kind != "api_key";
                out.push(HostAuthSummary {
                    provider_slug: slug,
                    auth_type: if meta.kind.is_empty() {
                        "unknown".into()
                    } else {
                        meta.kind
                    },
                    is_oauth,
                    is_ambient: false,
                });
            }
        }
    }

    // ~/.prime/config.json — ambient Prime Inference key.
    if let Ok(bytes) = std::fs::read(prime_dir.join("config.json")) {
        let bytes = Zeroizing::new(bytes);
        if let Ok(cfg) = serde_json::from_slice::<PrimeConfigMeta>(&bytes) {
            if cfg.api_key.is_some_and(|p| p.present)
                && !out.iter().any(|s| s.provider_slug == "prime-inference")
            {
                out.push(HostAuthSummary {
                    provider_slug: "prime-inference".into(),
                    auth_type: "api_key".into(),
                    is_oauth: false,
                    is_ambient: true,
                });
            }
        }
    }

    out.sort_by(|a, b| a.provider_slug.cmp(&b.provider_slug));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_names_never_values() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("agent")).unwrap();
        std::fs::write(
            dir.path().join("agent/auth.json"),
            r#"{"anthropic":{"type":"api_key","key":"sk-WBTESTSENTINEL-9f3a2c8e1b"},
                "openai":{"type":"oauth","key":"SENTINEL-OAUTH-TOKEN"}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"api_key":"pit_WBTESTSENTINEL"}"#,
        )
        .unwrap();

        let found = discover_at(dir.path());
        assert_eq!(found.len(), 3);

        let serialized = serde_json::to_string(&found).unwrap();
        assert!(!serialized.contains("SENTINEL"), "secret leaked: {serialized}");

        let anthropic = found.iter().find(|s| s.provider_slug == "anthropic").unwrap();
        assert!(!anthropic.is_oauth);
        let openai = found.iter().find(|s| s.provider_slug == "openai").unwrap();
        assert!(openai.is_oauth);
        let prime = found
            .iter()
            .find(|s| s.provider_slug == "prime-inference")
            .unwrap();
        assert!(prime.is_ambient);
    }

    #[test]
    fn missing_files_yield_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(discover_at(dir.path()).is_empty());
    }
}
