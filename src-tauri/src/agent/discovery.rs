//! Locate a runnable prime-agent from a GUI-launched app.
//!
//! A Finder-launched .app gets PATH=/usr/bin:/bin:/usr/sbin:/sbin — the npm
//! global shim is invisible, and the shim itself is `#!/usr/bin/env node`, so
//! the child's PATH must also contain node. Discovery therefore produces a
//! resolved ENVIRONMENT, not just a path.
//!
//! Tiers: user override → login-shell env capture → static probes.

use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAgent {
    pub program: PathBuf,
    pub path_env: String,
    pub source: String, // "override" | "login-shell" | "static-probe" | "app-path"
    pub version: Option<String>,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

/// Static probe dirs, in order.
fn probe_dirs() -> Vec<PathBuf> {
    let h = home();
    vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        h.join(".npm-global/bin"),
        h.join(".local/bin"),
        h.join(".volta/bin"),
        h.join(".bun/bin"),
        h.join("Library/pnpm"),
    ]
}

/// Capture the user's login-shell PATH: `$SHELL -lc 'env -0'`, non-interactive,
/// 4s timeout. Login (not interactive) picks up .zprofile/.zshenv where
/// nvm/homebrew put things, without hanging on prompt frameworks.
pub async fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = tokio::process::Command::new(&shell);
    cmd.args(["-lc", "/usr/bin/env -0"])
        .env("TERM", "dumb")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null());
    let child = cmd.output();
    let out = tokio::time::timeout(Duration::from_secs(4), child).await.ok()?.ok()?;
    for pair in out.stdout.split(|&b| b == 0) {
        let pair = String::from_utf8_lossy(pair);
        if let Some(path) = pair.strip_prefix("PATH=") {
            return Some(path.to_string());
        }
    }
    None
}

fn find_in_path(path_env: &str, name: &str) -> Option<PathBuf> {
    path_env.split(':').map(Path::new).find_map(|dir| {
        let candidate = dir.join(name);
        candidate.is_file().then_some(candidate)
    })
}

pub async fn version_of(program: &Path, path_env: &str) -> Option<String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.arg("--version")
        .env("PATH", path_env)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null());
    let out = tokio::time::timeout(Duration::from_secs(10), cmd.output())
        .await
        .ok()?
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // First semver-looking token.
    text.split_whitespace()
        .find(|t| {
            let parts: Vec<&str> = t.split('.').collect();
            parts.len() == 3 && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit()))
        })
        .map(String::from)
}

pub async fn discover(override_path: Option<&str>) -> Option<ResolvedAgent> {
    // Tier 0: explicit override.
    if let Some(p) = override_path {
        let program = PathBuf::from(p);
        if program.is_file() {
            let path_env = login_shell_path()
                .await
                .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
            let version = version_of(&program, &path_env).await;
            return Some(ResolvedAgent {
                program,
                path_env,
                source: "override".into(),
                version,
            });
        }
    }

    // Tier 1: login-shell PATH.
    if let Some(path_env) = login_shell_path().await {
        if let Some(program) = find_in_path(&path_env, "prime-agent") {
            let version = version_of(&program, &path_env).await;
            return Some(ResolvedAgent {
                program,
                path_env,
                source: "login-shell".into(),
                version,
            });
        }
    }

    // Tier 2: static probes appended to the app's own PATH.
    let mut path_env = std::env::var("PATH").unwrap_or_default();
    for dir in probe_dirs() {
        if dir.is_dir() {
            path_env.push(':');
            path_env.push_str(&dir.to_string_lossy());
        }
    }
    if let Some(program) = find_in_path(&path_env, "prime-agent") {
        let version = version_of(&program, &path_env).await;
        return Some(ResolvedAgent {
            program,
            path_env,
            source: "static-probe".into(),
            version,
        });
    }

    None
}

/// Kernel readiness: prime-agent's tool layer needs an IPython kernel.
pub fn kernel_status() -> (bool, String) {
    let venv_python = home().join(".prime/agent/kernel-venv/bin/python");
    if let Ok(explicit) = std::env::var("PRIME_AGENT_KERNEL_PYTHON") {
        return (true, format!("using PRIME_AGENT_KERNEL_PYTHON ({explicit})"));
    }
    if venv_python.is_file() {
        (true, "kernel-venv present".into())
    } else {
        (false, "kernel venv not bootstrapped — run prime-agent once in a terminal".into())
    }
}
