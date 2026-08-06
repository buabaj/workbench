//! Restore selected paths to their checkpoint state.
//!
//! Guarantees: a pre-restore checkpoint is taken first (Restore is itself
//! undoable); writes are atomic temp+rename; agent-created files go to the
//! macOS Trash, never `unlink`; the user's git state is never touched — putting
//! worktree bytes back means whatever was staged stays staged and still means
//! the same thing.

use std::path::Path;

use git2::{Oid, Repository};

use super::{snapshot, VcsError};

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub restored: Vec<String>,
    pub trashed: Vec<String>,
    pub recreated: Vec<String>,
    pub refused: Vec<(String, String)>,
    pub undo_ref: Option<String>,
}

fn blob_at<'a>(
    odb: &'a Repository,
    tree: Oid,
    rel_path: &str,
) -> Result<Option<(Vec<u8>, u32)>, VcsError> {
    let tree = odb.find_tree(tree)?;
    match tree.get_path(Path::new(rel_path)) {
        Ok(entry) => {
            let obj = entry.to_object(odb)?;
            let blob = obj
                .as_blob()
                .ok_or_else(|| VcsError::Refused("not a blob".into()))?;
            Ok(Some((blob.content().to_vec(), entry.filemode() as u32)))
        }
        Err(_) => Ok(None),
    }
}

fn write_atomic(abs: &Path, bytes: &[u8], mode: u32) -> Result<(), VcsError> {
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if mode == 0o120000 {
        // Symlink entry: recreate the link, never write through it.
        let target = String::from_utf8_lossy(bytes).into_owned();
        let _ = std::fs::remove_file(abs);
        std::os::unix::fs::symlink(target, abs)?;
        return Ok(());
    }
    let tmp = abs.with_extension(format!("wbrestore-{}", std::process::id()));
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perm = std::fs::Permissions::from_mode(if mode & 0o111 != 0 { 0o755 } else { 0o644 });
        std::fs::set_permissions(&tmp, perm)?;
    }
    std::fs::rename(&tmp, abs)?;
    Ok(())
}

/// Restore `paths` to their state in `checkpoint_tree`.
pub fn restore(
    odb: &Repository,
    root: &Path,
    checkpoint_tree: Oid,
    paths: &[String],
    undo_ref_name: Option<&str>,
) -> Result<RestoreResult, VcsError> {
    let mut result = RestoreResult::default();

    // Undo point first — warm ODB makes this near-free.
    if let Some(ref_name) = undo_ref_name {
        snapshot::snapshot(odb, root, ref_name, "pre-restore checkpoint")?;
        result.undo_ref = Some(ref_name.to_string());
    }

    for rel_path in paths {
        // Reject anything that would escape the workspace or touch .git.
        if rel_path.contains("..") || rel_path.split('/').any(|c| c == ".git") {
            result
                .refused
                .push((rel_path.clone(), "unsafe path".into()));
            continue;
        }
        let abs = root.join(rel_path);
        let in_checkpoint = blob_at(odb, checkpoint_tree, rel_path)?;
        let exists_now = std::fs::symlink_metadata(&abs).is_ok();

        match (in_checkpoint, exists_now) {
            (Some((bytes, mode)), true) => {
                write_atomic(&abs, &bytes, mode)?;
                result.restored.push(rel_path.clone());
            }
            (Some((bytes, mode)), false) => {
                write_atomic(&abs, &bytes, mode)?;
                result.recreated.push(rel_path.clone());
            }
            (None, true) => {
                // Created during the task: Trash it, never unlink.
                match trash::delete(&abs) {
                    Ok(()) => result.trashed.push(rel_path.clone()),
                    Err(e) => result
                        .refused
                        .push((rel_path.clone(), format!("trash failed: {e}"))),
                }
                // Clean up now-empty parents, stopping at the root.
                let mut parent = abs.parent().map(Path::to_path_buf);
                while let Some(dir) = parent {
                    if dir == root || !dir.starts_with(root) {
                        break;
                    }
                    if std::fs::read_dir(&dir).map(|mut d| d.next().is_none()).unwrap_or(false) {
                        let _ = std::fs::remove_dir(&dir);
                        parent = dir.parent().map(Path::to_path_buf);
                    } else {
                        break;
                    }
                }
            }
            (None, false) => {
                result
                    .refused
                    .push((rel_path.clone(), "absent in checkpoint and on disk".into()));
            }
        }
    }

    Ok(result)
}
