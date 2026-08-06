//! Agent runtime: JSONL framing, protocol types, process abstraction, dispatch.
//!
//! `framer` and `protocol` are pure (no tauri/tokio) by design — they carry the
//! protocol risk and must stay trivially testable.

pub mod child;
pub mod config_dir;
pub mod discovery;
pub mod dispatch;
pub mod env;
pub mod framer;
pub mod oauth_discovery;
pub mod preflight;
pub mod protocol;
pub mod spawn;
