//! Workbench's own AI utilities — deliberately independent of the agent
//! runtime: separate module tree, separate credential scope, separate HTTP
//! client, separate error taxonomy. It never imports from `agent/`.

pub mod openrouter;
pub mod registry;

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppAiError {
    #[error("no capability profile configured for {0}")]
    NoCapabilityProfile(String),
    #[error("capability not implemented yet")]
    NotImplemented,
    #[error("credential missing from keychain — re-add it in settings")]
    NoCredential,
    #[error("offline")]
    Offline,
    #[error("timed out after {0}ms")]
    Timeout(u64),
    #[error("no model satisfies {0}")]
    ModelIncompatible(String),
    #[error("input too large: {actual} > {limit} bytes")]
    InputTooLarge { actual: usize, limit: usize },
    #[error("provider error {status}")]
    Http { status: u16, message: String },
    #[error("malformed response from provider")]
    Decode,
    #[error("{0}")]
    Other(String),
}

impl AppAiError {
    /// Stable machine-readable code for the frontend to switch on.
    pub fn code(&self) -> &'static str {
        match self {
            AppAiError::NoCapabilityProfile(_) => "no_capability_profile",
            AppAiError::NotImplemented => "not_implemented",
            AppAiError::NoCredential => "no_credential",
            AppAiError::Offline => "offline",
            AppAiError::Timeout(_) => "timeout",
            AppAiError::ModelIncompatible(_) => "model_incompatible",
            AppAiError::InputTooLarge { .. } => "input_too_large",
            AppAiError::Http { .. } => "http",
            AppAiError::Decode => "decode",
            AppAiError::Other(_) => "other",
        }
    }
}

impl Serialize for AppAiError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppAiError", 2)?;
        st.serialize_field("code", self.code())?;
        // Redacted at the construction boundary, so a later format! can't
        // un-redact it.
        st.serialize_field("message", &crate::secret::redact(&self.to_string()))?;
        st.end()
    }
}
