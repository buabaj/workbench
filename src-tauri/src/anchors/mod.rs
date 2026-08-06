//! Durable text anchors.
//!
//! Line numbers are the weakest possible anchor: any edit above the target
//! shifts them and an external editor invalidates them silently. An anchor here
//! is derived from CONTENT — a prefix/exact/suffix fingerprint — with the byte
//! offset kept only as a hint for disambiguation.
//!
//! Resolution ladder (each rung lowers confidence):
//!   1. file unchanged since creation      → exact offsets, confidence 1.0
//!   2. unique match of prefix+exact+suffix → 0.95
//!   3. unique match of exact alone         → 0.9
//!   4. nearest match of exact (ambiguous)  → 0.6, reported stale
//!   5. fuzzy match by similarity           → 0.5–0.85
//!   6. nothing above threshold             → broken
//!
//! A duplicated-text case MUST resolve as `stale`, never as a confidently wrong
//! match — silently pointing at the wrong place is the worst outcome.

pub mod resolve;

use serde::{Deserialize, Serialize};

pub const CONTEXT_LEN: usize = 64;
pub const MAX_EXACT: usize = 2048;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorFingerprint {
    pub exact_text: String,
    pub prefix_text: String,
    pub suffix_text: String,
    pub hint_from: usize,
    pub hint_to: usize,
    pub file_hash_at_create: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnchorStatus {
    Ok,
    Stale,
    Broken,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAnchor {
    pub status: AnchorStatus,
    pub from: usize,
    pub to: usize,
    pub confidence: f32,
    /// Kept so a broken anchor can still show what it pointed at.
    pub original_text: String,
}

/// Snap byte offsets to char boundaries so slicing never panics on UTF-8.
fn floor_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Build a fingerprint for a selection in `content`.
pub fn fingerprint(content: &str, from: usize, to: usize, file_hash: &str) -> AnchorFingerprint {
    let from = floor_boundary(content, from);
    let to = ceil_boundary(content, to.max(from));
    let exact_end = ceil_boundary(content, (from + MAX_EXACT).min(to));
    let exact_text = content[from..exact_end].to_string();

    let prefix_start = floor_boundary(content, from.saturating_sub(CONTEXT_LEN));
    let prefix_text = content[prefix_start..from].to_string();

    let suffix_end = ceil_boundary(content, (to + CONTEXT_LEN).min(content.len()));
    let suffix_text = content[to..suffix_end].to_string();

    AnchorFingerprint {
        exact_text,
        prefix_text,
        suffix_text,
        hint_from: from,
        hint_to: to,
        file_hash_at_create: file_hash.to_string(),
    }
}
