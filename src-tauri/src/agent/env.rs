//! Child environment construction — allowlist, never inheritance.
//!
//! Invariants (enforced by the security tests):
//! 1. The child env is built from an allowlist; the parent env never passes
//!    through wholesale.
//! 2. Any inherited name matching a secret-ish pattern is dropped even if it
//!    made the allowlist somehow.
//! 3. At most ONE secret-valued variable exists in any child env.

/// Parent vars worth keeping, by exact name.
const KEEP: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
];

/// Known provider key vars — explicitly stripped so a stray var in Workbench's
/// own environment can never reach a child (defense in depth on top of the
/// allowlist).
pub fn known_provider_vars() -> Vec<&'static str> {
    let mut v: Vec<&str> = crate::creds::PROVIDER_ENV_VARS.iter().map(|(_, e)| *e).collect();
    v.push("AZURE_OPENAI_API_KEY");
    v.push("AI_GATEWAY_API_KEY");
    v.push("HF_TOKEN");
    v
}

fn is_secretish(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["api_key", "apikey", "token", "secret", "password", "passwd", "credential"]
        .iter()
        .any(|p| lower.contains(p))
}

/// Build the non-secret portion of a child env from the parent environment.
/// PATH is set explicitly by the caller (discovery owns it).
pub fn base_child_env(
    parent: impl Iterator<Item = (String, String)>,
    path: &str,
) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = parent
        .filter(|(k, _)| KEEP.contains(&k.as_str()) && !is_secretish(k))
        .collect();
    env.push(("PATH".into(), path.to_string()));
    env.push(("TERM".into(), "dumb".into()));
    env.push(("NO_COLOR".into(), "1".into()));
    env.push(("PRIME_WORKBENCH".into(), "1".into()));
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_drops_everything_unexpected() {
        let parent = vec![
            ("HOME".to_string(), "/Users/x".to_string()),
            ("OPENAI_API_KEY".to_string(), "sk-SENTINEL".to_string()),
            ("MY_APP_TOKEN".to_string(), "SENTINEL".to_string()),
            ("RANDOM_VAR".to_string(), "hello".to_string()),
            ("LANG".to_string(), "en_US.UTF-8".to_string()),
        ];
        let env = base_child_env(parent.into_iter(), "/usr/bin");
        let names: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert!(names.contains(&"HOME"));
        assert!(names.contains(&"LANG"));
        assert!(names.contains(&"PATH"));
        assert!(!names.contains(&"OPENAI_API_KEY"));
        assert!(!names.contains(&"MY_APP_TOKEN"));
        assert!(!names.contains(&"RANDOM_VAR"));
        let joined = env.iter().map(|(_, v)| v.clone()).collect::<String>();
        assert!(!joined.contains("SENTINEL"));
    }
}
