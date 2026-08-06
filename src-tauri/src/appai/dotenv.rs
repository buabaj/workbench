//! Ambient credentials for Workbench's own AI processes.
//!
//! Deliberate, narrow exception to the Keychain-first rule: keys the user drops
//! in a `.env` are for *internal* capabilities (voice transcription and the
//! like), so the app configures itself instead of prompting. Constraints kept:
//!
//! - Read only. Workbench never writes a `.env`.
//! - The value is loaded into a `SecretString` and never persisted to SQLite,
//!   never logged, never returned through a command.
//! - Only an explicit allowlist of variable names is read, so an unrelated
//!   secret sitting in the same file is not slurped up.
//! - The agent runtime does NOT use this path — its credentials still come from
//!   the Keychain via a per-task isolated config dir.

use std::path::{Path, PathBuf};

use zeroize::Zeroizing;

use crate::secret::SecretString;

/// The only names read out of a `.env`.
const ALLOWED: &[&str] = &["OPENROUTER_API_KEY"];

/// Search order for a `.env`, nearest-wins:
/// 1. `WORKBENCH_ENV_FILE` (explicit override)
/// 2. the workspace root, if one is open
/// 3. `~/.config/workbench/.env`
/// 4. the current working directory (covers `npm run tauri dev`)
fn candidates(workspace_root: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(explicit) = std::env::var_os("WORKBENCH_ENV_FILE") {
        out.push(PathBuf::from(explicit));
    }
    if let Some(root) = workspace_root {
        out.push(root.join(".env"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        out.push(PathBuf::from(home).join(".config/workbench/.env"));
    }
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join(".env"));
    }
    out
}

/// Minimal `KEY=VALUE` parser: ignores blanks and `#` comments, tolerates
/// `export ` prefixes, strips one layer of matching quotes. Deliberately not a
/// full dotenv implementation — this reads a handful of known names, not a
/// configuration language.
fn parse(contents: &str, want: &str) -> Option<String> {
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != want {
            continue;
        }
        let v = value.trim();
        let v = v
            .strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
            .or_else(|| v.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
            .unwrap_or(v);
        if v.is_empty() {
            return None;
        }
        return Some(v.to_string());
    }
    None
}

/// Look up an allowlisted variable: real process environment first, then a
/// `.env`. Returns `None` for anything not on the allowlist.
pub fn lookup(name: &str, workspace_root: Option<&Path>) -> Option<SecretString> {
    if !ALLOWED.contains(&name) {
        return None;
    }
    if let Ok(v) = std::env::var(name) {
        if !v.is_empty() {
            return Some(SecretString::new(v));
        }
    }
    for path in candidates(workspace_root) {
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        // Zeroized: the whole file may contain other secrets we don't want
        // lingering in memory.
        let bytes = Zeroizing::new(bytes);
        let Ok(text) = std::str::from_utf8(&bytes) else {
            continue;
        };
        if let Some(v) = parse(text, name) {
            tracing::info!(name, path = %path.display(), "using ambient credential from .env");
            return Some(SecretString::new(v));
        }
    }
    None
}

/// Is an ambient OpenRouter key available? Used to decide whether the UI needs
/// to ask for one. Never exposes the value.
pub fn has_openrouter(workspace_root: Option<&Path>) -> bool {
    lookup("OPENROUTER_API_KEY", workspace_root).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_common_shapes() {
        let f = "# comment\n\nexport OPENROUTER_API_KEY=\"sk-or-v1-abc\"\nOTHER=1\n";
        assert_eq!(parse(f, "OPENROUTER_API_KEY").unwrap(), "sk-or-v1-abc");
        assert_eq!(parse("OPENROUTER_API_KEY=sk-plain", "OPENROUTER_API_KEY").unwrap(), "sk-plain");
        assert_eq!(parse("OPENROUTER_API_KEY='sk-sq'", "OPENROUTER_API_KEY").unwrap(), "sk-sq");
        assert!(parse("OPENROUTER_API_KEY=", "OPENROUTER_API_KEY").is_none());
        assert!(parse("# OPENROUTER_API_KEY=sk-commented", "OPENROUTER_API_KEY").is_none());
    }

    #[test]
    fn only_allowlisted_names_are_readable() {
        // A neighbouring secret in the same file must not be reachable.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".env"),
            "OPENROUTER_API_KEY=sk-or-allowed\nAWS_SECRET_ACCESS_KEY=sk-NOT-ALLOWED\n",
        )
        .unwrap();
        std::env::set_var("WORKBENCH_ENV_FILE", dir.path().join(".env"));

        assert!(lookup("OPENROUTER_API_KEY", None).is_some());
        assert!(
            lookup("AWS_SECRET_ACCESS_KEY", None).is_none(),
            "non-allowlisted variable was read"
        );
        std::env::remove_var("WORKBENCH_ENV_FILE");
    }

    #[test]
    fn secret_never_renders_in_debug_or_display() {
        let s = SecretString::new("sk-or-v1-sentinel".into());
        assert!(!format!("{s:?}").contains("sentinel"));
        assert!(!format!("{s}").contains("sentinel"));
    }
}
