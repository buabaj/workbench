//! Agent runtime: JSONL framing, protocol types, process abstraction, dispatch.
//!
//! `framer` and `protocol` are pure (no tauri/tokio) by design — they carry the
//! protocol risk and must stay trivially testable.

pub mod child;
pub mod dispatch;
pub mod framer;
pub mod protocol;
