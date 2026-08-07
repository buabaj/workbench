//! Checkpoint engine.
//!
//! Central decision: checkpoints live in a per-workspace **shadow ODB** under
//! app data — we never open the user's object database for writing, never
//! create refs in it, and never create an index file near it. Consequences:
//! `.git/index`, HEAD, refs, reflogs and hooks are untouched *by construction*
//! rather than by discipline, and a non-git workspace is not a special case —
//! it uses the identical code path.
//!
//! Blobs are written from raw bytes (`repo.blob`), never `blob_path`/`add_path`,
//! so clean filters (autocrlf, LFS) can't make restore non-round-tripping.

pub mod diff;
pub mod restore;
pub mod snapshot;
pub mod worktree;

use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum VcsError {
    #[error("git: {0}")]
    Git(String),
    #[error("io: {0}")]
    Io(String),
    #[error("checkpoint not found")]
    NotFound,
    #[error("refused: {0}")]
    Refused(String),
}

impl From<git2::Error> for VcsError {
    fn from(e: git2::Error) -> Self {
        VcsError::Git(e.message().to_string())
    }
}

impl From<std::io::Error> for VcsError {
    fn from(e: std::io::Error) -> Self {
        VcsError::Io(e.to_string())
    }
}

/// Open (creating if needed) the workspace's shadow object database.
pub fn open_odb(app_data: &Path, workspace_id: &str) -> Result<git2::Repository, VcsError> {
    let path = odb_path(app_data, workspace_id);
    if path.exists() {
        Ok(git2::Repository::open_bare(&path)?)
    } else {
        std::fs::create_dir_all(&path)?;
        Ok(git2::Repository::init_bare(&path)?)
    }
}

pub fn odb_path(app_data: &Path, workspace_id: &str) -> PathBuf {
    app_data
        .join("workspaces")
        .join(workspace_id)
        .join("checkpoints.git")
}

pub fn checkpoint_ref(task_id: &str, kind: &str) -> String {
    format!("refs/workbench/{kind}/{task_id}")
}
