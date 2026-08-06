use serde::Serialize;

/// App-wide command error. Tagged so the frontend switches on `code`, never on
/// message strings. Every message that could carry upstream text must be
/// redacted at construction (see `secret::redact`).
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "code", content = "detail", rename_all = "snake_case")]
pub enum AppError {
    #[error("database error: {0}")]
    Db(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Db(crate::secret::redact(&e.to_string()))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(crate::secret::redact(&e.to_string()))
    }
}
