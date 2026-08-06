//! Secret handling.
//!
//! `SecretString` deliberately implements `Deserialize` but NOT `Serialize`,
//! `Clone`, `Deref`, or `AsRef<str>`. Consequences, all intentional:
//! - No Tauri command return type can contain a secret — it fails to compile.
//! - Every read of the value is a grep-auditable `.expose()` call site.
//! - The heap buffer is zeroized on drop.

use zeroize::Zeroizing;

pub struct SecretString(Zeroizing<String>);

impl SecretString {
    pub fn new(s: String) -> Self {
        Self(Zeroizing::new(s))
    }

    /// The ONLY way to read the secret.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretString(<redacted>)")
    }
}

impl std::fmt::Display for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

impl<'de> serde::Deserialize<'de> for SecretString {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        String::deserialize(deserializer).map(SecretString::new)
    }
}

/// Masks known secret shapes in any string bound for a log, an error, or the
/// webview. Applied at construction boundaries, not logging boundaries, so a
/// redacted string can never be un-redacted by a later `format!`.
pub fn redact(s: &str) -> String {
    let mut out = String::with_capacity(s.len());

    // Cheap scanner: mask runs that look like key material. Shapes covered:
    // sk-..., sk-ant-..., sk-or-v1-..., pit_..., ghp_/ghu_..., AIza..., Bearer <tok>.
    const PREFIXES: [&str; 8] = ["sk-", "pit_", "ghp_", "ghu_", "gho_", "AIza", "xoxb-", "xoxp-"];

    let mut i = 0;
    while i < s.len() {
        let rest = &s[i..];
        let matched = PREFIXES.iter().find(|p| rest.starts_with(**p));
        // Byte-level compare: slicing `rest[..7]` would panic on a multi-byte char.
        let bearer = rest.len() > 7 && rest.as_bytes()[..7].eq_ignore_ascii_case(b"bearer ");
        if let Some(p) = matched {
            let start = i + p.len();
            let end = s[start..]
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
                .map(|off| start + off)
                .unwrap_or(s.len());
            if end - start >= 8 {
                out.push_str(p);
                out.push_str("<redacted>");
                i = end;
                continue;
            }
        } else if bearer {
            let start = i + 7;
            let end = s[start..]
                .find(|c: char| c.is_whitespace())
                .map(|off| start + off)
                .unwrap_or(s.len());
            if end - start >= 8 {
                out.push_str(&s[i..start]);
                out.push_str("<redacted>");
                i = end;
                continue;
            }
        }
        // advance one char
        let ch_len = s[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        out.push_str(&s[i..i + ch_len]);
        i += ch_len;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_and_display_are_redacted() {
        let s = SecretString::new("sk-ant-supersecret123456".into());
        assert_eq!(format!("{s:?}"), "SecretString(<redacted>)");
        assert_eq!(format!("{s}"), "<redacted>");
    }

    #[test]
    fn redact_masks_known_shapes() {
        for (input, must_not_contain) in [
            ("error with key sk-ant-abc123def456ghi789", "abc123def456"),
            ("prime pit_a6c5b98579c6e37ccb8f5a267be04310", "a6c5b98579"),
            ("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9", "eyJhbGci"),
            ("github ghp_16chartokenXYZ123", "16chartoken"),
        ] {
            let r = redact(input);
            assert!(!r.contains(must_not_contain), "leak in: {r}");
            assert!(r.contains("<redacted>"), "no mask in: {r}");
        }
    }

    #[test]
    fn redact_leaves_normal_text_alone() {
        let t = "modified src/main.rs and ran cargo test — 14 passed";
        assert_eq!(redact(t), t);
    }
}
