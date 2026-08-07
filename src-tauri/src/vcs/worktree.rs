//! Uncommitted changes in the user's own repository.
//!
//! Distinct from `diff.rs`, which compares a shadow-ODB checkpoint against a
//! snapshot to review what an agent did. This is the everyday view: what is
//! different right now versus HEAD, staged or not, including untracked files.
//!
//! Strictly read-only. Nothing here opens an index for writing, stages, or
//! commits — the user does that from the terminal, and a diff panel that could
//! mutate the repository would be a much bigger promise than it looks.

use std::path::Path;

use super::VcsError;
use super::diff::FileStatus;

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeChange {
    pub rel_path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub insertions: u32,
    pub deletions: u32,
    pub is_binary: bool,
    /// Not yet tracked by git. Worth showing differently: it has no history to
    /// diff against, so the whole file is "new".
    pub untracked: bool,
}

fn opts(include_untracked: bool) -> git2::DiffOptions {
    let mut o = git2::DiffOptions::new();
    o.include_typechange(true)
        .include_untracked(include_untracked)
        // Without this an untracked directory reports as one entry rather than
        // the files inside it, which is useless in a file list.
        .recurse_untracked_dirs(include_untracked)
        .context_lines(3);
    o
}

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchState {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    /// Commits on the branch that the upstream does not have.
    pub ahead: usize,
    /// Commits on the upstream that the branch does not have.
    pub behind: usize,
}

/// Which branch, and how it stands against its upstream.
///
/// Shown beside the change list because "no uncommitted changes" and "ahead of
/// origin/main by 32 commits" are both true at once, and a panel that reports
/// only the first reads as broken to anyone who just ran `git status`.
pub fn branch_state(root: &Path) -> Result<BranchState, VcsError> {
    let none = BranchState { branch: None, upstream: None, ahead: 0, behind: 0 };
    let Ok(repo) = git2::Repository::open(root) else {
        return Ok(none);
    };
    let Ok(head) = repo.head() else {
        // Unborn HEAD: nothing committed yet, so nothing to compare.
        return Ok(none);
    };
    // git2 0.21 returns Result here, not Option.
    let branch: Option<String> = head.shorthand().ok().map(String::from);
    let Some(local_oid) = head.target() else {
        return Ok(BranchState { branch, ..none });
    };

    let upstream = branch
        .as_deref()
        .and_then(|b| repo.find_branch(b, git2::BranchType::Local).ok())
        .and_then(|br| br.upstream().ok());
    let Some(up) = upstream else {
        // No upstream configured is ordinary, not an error.
        return Ok(BranchState { branch, ..none });
    };
    let up_name = up.name().ok().flatten().map(String::from);

    let Some(up_oid) = up.get().target() else {
        return Ok(BranchState { branch, upstream: up_name, ..none });
    };

    let (ahead, behind) = repo
        .graph_ahead_behind(local_oid, up_oid)
        .unwrap_or((0, 0));
    Ok(BranchState { branch, upstream: up_name, ahead, behind })
}

/// Everything different from HEAD right now, staged or not.
///
/// Returns an empty list rather than an error when the directory is not a
/// repository, or when HEAD has no commits yet — neither is a failure the user
/// needs to see in a diff panel.
pub fn changes(root: &Path) -> Result<Vec<WorktreeChange>, VcsError> {
    let repo = match git2::Repository::open(root) {
        Ok(r) => r,
        Err(_) => return Ok(Vec::new()),
    };
    // An unborn HEAD (fresh `git init`) has no tree; everything is then
    // simply new, which diffing against None expresses correctly.
    let head_tree = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok());

    let diff = repo
        .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts(true)))
        .map_err(|e| VcsError::Git(e.to_string()))?;

    // Per-file line counts: the summary list shows +/- beside each path.
    let mut out: Vec<WorktreeChange> = Vec::new();
    let stats_by_path = line_stats(&diff);

    diff.foreach(
        &mut |delta, _| {
            let new_path = delta
                .new_file()
                .path()
                .map(|p| p.to_string_lossy().into_owned());
            let old_path = delta
                .old_file()
                .path()
                .map(|p| p.to_string_lossy().into_owned());
            let rel_path = new_path.clone().or_else(|| old_path.clone()).unwrap_or_default();
            let (ins, del) = stats_by_path
                .get(&rel_path)
                .copied()
                .unwrap_or((0, 0));
            out.push(WorktreeChange {
                status: match delta.status() {
                    git2::Delta::Added | git2::Delta::Untracked => FileStatus::Added,
                    git2::Delta::Deleted => FileStatus::Deleted,
                    git2::Delta::Renamed => FileStatus::Renamed,
                    git2::Delta::Typechange => FileStatus::TypeChanged,
                    _ => FileStatus::Modified,
                },
                untracked: delta.status() == git2::Delta::Untracked,
                is_binary: delta.new_file().is_binary() || delta.old_file().is_binary(),
                old_path: old_path.filter(|o| Some(o) != new_path.as_ref()),
                rel_path,
                insertions: ins,
                deletions: del,
            });
            true
        },
        None,
        None,
        None,
    )
    .map_err(|e| VcsError::Git(e.to_string()))?;

    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
}

/// Insertions and deletions per path, keyed by the new path.
fn line_stats(diff: &git2::Diff<'_>) -> std::collections::HashMap<String, (u32, u32)> {
    let mut map: std::collections::HashMap<String, (u32, u32)> = std::collections::HashMap::new();
    let _ = diff.foreach(
        &mut |_, _| true,
        None,
        None,
        Some(&mut |delta, _hunk, line| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            let entry = map.entry(path).or_insert((0, 0));
            match line.origin() {
                '+' => entry.0 += 1,
                '-' => entry.1 += 1,
                _ => {}
            }
            true
        }),
    );
    map
}

/// Unified patch for one path, as `git diff -- <path>` would print it.
pub fn patch(root: &Path, rel_path: &str) -> Result<String, VcsError> {
    let repo = match git2::Repository::open(root) {
        Ok(r) => r,
        Err(_) => return Ok(String::new()),
    };
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());

    let mut o = opts(true);
    o.pathspec(rel_path);
    let diff = repo
        .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut o))
        .map_err(|e| VcsError::Git(e.to_string()))?;

    let mut out = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        // `origin` carries the +/-/space marker, which `content` does not.
        match line.origin() {
            '+' | '-' | ' ' => out.push(line.origin()),
            _ => {}
        }
        out.push_str(&String::from_utf8_lossy(line.content()));
        true
    })
    .map_err(|e| VcsError::Git(e.to_string()))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A repo with one committed file, so HEAD exists to diff against.
    fn repo_with_commit() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let repo = git2::Repository::init(&root).unwrap();
        std::fs::write(root.join("tracked.txt"), "one\ntwo\nthree\n").unwrap();

        let mut index = repo.index().unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("t", "t@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        drop(tree);
        drop(index);
        (dir, root)
    }

    #[test]
    fn a_clean_repository_reports_nothing() {
        let (_d, root) = repo_with_commit();
        assert!(changes(&root).unwrap().is_empty());
    }

    #[test]
    fn reports_a_modification_with_line_counts() {
        let (_d, root) = repo_with_commit();
        std::fs::write(root.join("tracked.txt"), "one\nCHANGED\nthree\n").unwrap();

        let out = changes(&root).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].rel_path, "tracked.txt");
        assert_eq!(out[0].status, FileStatus::Modified);
        assert_eq!((out[0].insertions, out[0].deletions), (1, 1));
        assert!(!out[0].untracked);
    }

    /// Untracked files must appear: "what changed" without them is misleading.
    #[test]
    fn reports_untracked_files_including_inside_new_directories() {
        let (_d, root) = repo_with_commit();
        std::fs::write(root.join("loose.txt"), "new\n").unwrap();
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/nested.txt"), "new\n").unwrap();

        let out = changes(&root).unwrap();
        let paths: Vec<&str> = out.iter().map(|c| c.rel_path.as_str()).collect();
        assert!(paths.contains(&"loose.txt"), "got {paths:?}");
        assert!(
            paths.contains(&"sub/nested.txt"),
            "an untracked directory must list its files, got {paths:?}"
        );
        assert!(out.iter().all(|c| c.untracked));
    }

    #[test]
    fn reports_a_deletion() {
        let (_d, root) = repo_with_commit();
        std::fs::remove_file(root.join("tracked.txt")).unwrap();
        let out = changes(&root).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, FileStatus::Deleted);
    }

    /// Staged work is still uncommitted, so it belongs in the list.
    #[test]
    fn includes_staged_changes() {
        let (_d, root) = repo_with_commit();
        std::fs::write(root.join("tracked.txt"), "one\nSTAGED\nthree\n").unwrap();
        let repo = git2::Repository::open(&root).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        index.write().unwrap();

        let out = changes(&root).unwrap();
        assert_eq!(out.len(), 1, "staged but uncommitted work must still show");
        assert_eq!(out[0].status, FileStatus::Modified);
    }

    #[test]
    fn patch_carries_the_origin_markers() {
        let (_d, root) = repo_with_commit();
        std::fs::write(root.join("tracked.txt"), "one\nCHANGED\nthree\n").unwrap();
        let p = patch(&root, "tracked.txt").unwrap();
        assert!(p.contains("-two"), "missing removed line in:\n{p}");
        assert!(p.contains("+CHANGED"), "missing added line in:\n{p}");
        assert!(p.contains("@@"), "missing hunk header in:\n{p}");
    }

    #[test]
    fn patch_is_scoped_to_the_requested_file() {
        let (_d, root) = repo_with_commit();
        std::fs::write(root.join("tracked.txt"), "one\nCHANGED\nthree\n").unwrap();
        std::fs::write(root.join("other.txt"), "unrelated\n").unwrap();
        let p = patch(&root, "tracked.txt").unwrap();
        assert!(!p.contains("unrelated"), "other files leaked in:\n{p}");
    }

    #[test]
    fn reports_the_branch_and_no_upstream_by_default() {
        let (_d, root) = repo_with_commit();
        let st = branch_state(&root).unwrap();
        // The default branch name depends on git config, so assert it exists
        // rather than pinning main vs master.
        assert!(st.branch.is_some(), "a committed repo has a branch");
        assert_eq!(st.upstream, None, "a fresh repo has no upstream");
        assert_eq!((st.ahead, st.behind), (0, 0));
    }

    /// The reported confusion: a clean tree with unpushed commits. The change
    /// list is empty AND the branch is ahead — both must be reportable.
    #[test]
    fn counts_commits_ahead_of_an_upstream() {
        let (_d, root) = repo_with_commit();
        let repo = git2::Repository::open(&root).unwrap();

        // Stand in for a remote: a second branch this one tracks.
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("upstream", &head_commit, false).unwrap();
        let branch_name = repo.head().unwrap().shorthand().unwrap().to_string();
        let mut local = repo.find_branch(&branch_name, git2::BranchType::Local).unwrap();
        local.set_upstream(Some("upstream")).unwrap();

        // One commit beyond the upstream.
        std::fs::write(root.join("tracked.txt"), "changed\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("tracked.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("t", "t@example.com").unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "second", &tree, &[&head_commit]).unwrap();

        let st = branch_state(&root).unwrap();
        assert_eq!(st.ahead, 1, "one unpushed commit");
        assert_eq!(st.behind, 0);
        assert!(st.upstream.is_some());
        // And the working tree is clean, which is the whole point.
        assert!(changes(&root).unwrap().is_empty());
    }

    /// A directory that is not a repository is an ordinary state, not an error.
    #[test]
    fn a_plain_directory_yields_no_changes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        assert!(changes(dir.path()).unwrap().is_empty());
        assert_eq!(patch(dir.path(), "a.txt").unwrap(), "");
    }

    /// A fresh `git init` has no HEAD to diff against; everything is new.
    #[test]
    fn an_unborn_head_reports_files_as_added() {
        let dir = tempfile::tempdir().unwrap();
        git2::Repository::init(dir.path()).unwrap();
        std::fs::write(dir.path().join("a.txt"), "x\n").unwrap();
        let out = changes(dir.path()).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, FileStatus::Added);
    }
}
