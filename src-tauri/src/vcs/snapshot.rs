//! Worktree → tree OID, via the shadow ODB.

use std::path::Path;

use git2::{IndexEntry, IndexTime, Oid, Repository, Signature, Time};

use super::VcsError;

/// Files larger than this are recorded as skipped rather than checkpointed.
pub const MAX_BLOB_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct SnapEntry {
    pub rel_path: String,
    pub blob: Oid,
    pub mode: u32,
    pub size: u64,
}

#[derive(Debug)]
pub struct SnapshotResult {
    pub tree: Oid,
    pub commit: Oid,
    pub file_count: usize,
    pub total_bytes: u64,
    pub skipped: Vec<String>,
}

/// Walk the worktree honoring .gitignore (also in non-git workspaces), writing
/// raw bytes as blobs into the shadow ODB.
pub fn collect(odb: &Repository, root: &Path) -> Result<(Vec<SnapEntry>, Vec<String>), VcsError> {
    let mut entries = Vec::new();
    let mut skipped = Vec::new();

    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build();

    for entry in walker.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(path) else {
            continue;
        };
        if meta.is_dir() {
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let rel_path = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if rel_path.is_empty() {
            continue;
        }

        if meta.is_symlink() {
            // Store the link target as the blob; never follow it.
            let target = std::fs::read_link(path)?;
            let blob = odb.blob(target.to_string_lossy().as_bytes())?;
            entries.push(SnapEntry {
                rel_path,
                blob,
                mode: 0o120000,
                size: meta.len(),
            });
            continue;
        }

        if meta.len() > MAX_BLOB_BYTES {
            skipped.push(rel_path);
            continue;
        }

        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => {
                skipped.push(rel_path);
                continue;
            }
        };
        // Raw bytes — no clean filters, so restore round-trips exactly.
        let blob = odb.blob(&bytes)?;
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            meta.permissions().mode() & 0o111 != 0
        };
        #[cfg(not(unix))]
        let executable = false;

        entries.push(SnapEntry {
            rel_path,
            blob,
            mode: if executable { 0o100755 } else { 0o100644 },
            size: meta.len(),
        });
    }

    Ok((entries, skipped))
}

/// Build a tree from entries using an in-memory index (never a file on disk).
pub fn write_tree(odb: &Repository, entries: &[SnapEntry]) -> Result<Oid, VcsError> {
    let mut index = git2::Index::new()?;
    for e in entries {
        index.add(&IndexEntry {
            ctime: IndexTime::new(0, 0),
            mtime: IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: e.mode,
            uid: 0,
            gid: 0,
            file_size: e.size.min(u32::MAX as u64) as u32,
            id: e.blob,
            flags: 0,
            flags_extended: 0,
            path: e.rel_path.as_bytes().to_vec(),
        })?;
    }
    // Index::new() has no backing file, so write_tree_to(odb) is required.
    Ok(index.write_tree_to(odb)?)
}

/// Snapshot the worktree and record it under a Workbench-namespaced ref.
/// Parentless commit, `None` ref target on commit() — HEAD is never consulted.
pub fn snapshot(
    odb: &Repository,
    root: &Path,
    ref_name: &str,
    message: &str,
) -> Result<SnapshotResult, VcsError> {
    let (entries, skipped) = collect(odb, root)?;
    let tree_oid = write_tree(odb, &entries)?;
    let tree = odb.find_tree(tree_oid)?;
    let sig = Signature::new(
        "Workbench",
        "workbench@localhost",
        &Time::new(crate::db::now_ms() / 1000, 0),
    )?;
    let commit = odb.commit(None, &sig, &sig, message, &tree, &[])?;
    odb.reference(ref_name, commit, true, "workbench checkpoint")?;

    Ok(SnapshotResult {
        tree: tree_oid,
        commit,
        file_count: entries.len(),
        total_bytes: entries.iter().map(|e| e.size).sum(),
        skipped,
    })
}
