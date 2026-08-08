//! Moving between branches.
//!
//! Kept apart from `worktree.rs`, which says it is strictly read-only and
//! should go on being able to say that. This is the one place in the app that
//! changes what the working tree contains, and it does exactly one thing —
//! `git checkout <branch>` — with git's own safety rather than a looser
//! version of it: a switch that would overwrite uncommitted work fails and
//! says so, rather than winning.
//!
//! There is still no stage, no commit, no push. Switching is navigation; the
//! rest is publishing, and that stays in the terminal.

use std::path::Path;

use super::VcsError;

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchRef {
    /// `main`, or `origin/main` for a remote branch with no local counterpart.
    pub name: String,
    /// The branch currently checked out. Detached HEAD leaves this false
    /// everywhere, which is honest: no branch is checked out.
    pub is_head: bool,
    /// Switching to one of these creates a local branch that tracks it.
    pub is_remote: bool,
}

/// Every branch worth offering: the local ones, plus remote branches that have
/// no local counterpart yet.
///
/// A remote branch you already have locally is not listed twice — `main` and
/// `origin/main` are one choice, and the local name is the one that switching
/// actually means.
pub fn list(root: &Path) -> Result<Vec<BranchRef>, VcsError> {
    let repo = git2::Repository::open(root)?;
    let head = repo.head().ok();
    let head_name = head
        .as_ref()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().ok())
        .map(String::from);

    let mut local: Vec<BranchRef> = Vec::new();
    for entry in repo.branches(Some(git2::BranchType::Local))? {
        let (branch, _) = entry?;
        let Some(name) = branch.name()?.map(String::from) else {
            continue;
        };
        local.push(BranchRef {
            is_head: head_name.as_deref() == Some(name.as_str()),
            name,
            is_remote: false,
        });
    }
    local.sort_by(|a, b| a.name.cmp(&b.name));

    let have: std::collections::HashSet<&str> = local.iter().map(|b| b.name.as_str()).collect();
    let mut remote: Vec<BranchRef> = Vec::new();
    for entry in repo.branches(Some(git2::BranchType::Remote))? {
        let (branch, _) = entry?;
        let Some(name) = branch.name()?.map(String::from) else {
            continue;
        };
        // `origin/HEAD` is a symbolic pointer, not somewhere to go.
        if name.ends_with("/HEAD") {
            continue;
        }
        if let Some(short) = name.split_once('/').map(|(_, rest)| rest) {
            if have.contains(short) {
                continue;
            }
        }
        remote.push(BranchRef {
            name,
            is_head: false,
            is_remote: true,
        });
    }
    remote.sort_by(|a, b| a.name.cmp(&b.name));

    local.extend(remote);
    Ok(local)
}

/// Check out a branch, creating a local tracking branch for a remote one.
///
/// Uncommitted work is preserved exactly as `git checkout` preserves it: it
/// comes along when the file is the same on both sides, and the switch is
/// refused when it is not. Nothing here forces.
pub fn switch(root: &Path, name: &str) -> Result<(), VcsError> {
    let repo = git2::Repository::open(root)?;

    // A half-finished merge or rebase has state in the index that a checkout
    // would strand. Whoever started it is mid-thought; say so and stop.
    if repo.state() != git2::RepositoryState::Clean {
        return Err(VcsError::Refused(format!(
            "{:?} in progress — finish it in the terminal first",
            repo.state()
        )));
    }

    let (refname, commit) = match repo.find_branch(name, git2::BranchType::Local) {
        Ok(branch) => {
            let commit = branch.get().peel_to_commit()?;
            (format!("refs/heads/{name}"), commit)
        }
        Err(_) => {
            // Not local: try it as a remote branch and lay down a local one
            // tracking it, which is what `git checkout foo` does for you.
            let remote = repo
                .find_branch(name, git2::BranchType::Remote)
                .map_err(|_| VcsError::Refused(format!("no branch named {name}")))?;
            let commit = remote.get().peel_to_commit()?;
            let short = name
                .split_once('/')
                .map(|(_, rest)| rest)
                .ok_or_else(|| VcsError::Refused(format!("no branch named {name}")))?;
            if repo.find_branch(short, git2::BranchType::Local).is_ok() {
                return Err(VcsError::Refused(format!(
                    "{short} already exists locally — switch to that instead"
                )));
            }
            let mut created = repo.branch(short, &commit, false)?;
            created.set_upstream(Some(name))?;
            (format!("refs/heads/{short}"), commit)
        }
    };

    // Tree first, HEAD second. If the checkout is refused, HEAD has not moved
    // and the repository is exactly as it was.
    //
    // No `.force()`: the default is git's safe strategy, which fails rather
    // than overwriting a file you have edited but not committed.
    repo.checkout_tree(commit.as_object(), None)
        .map_err(|e| VcsError::Refused(format!("{} — commit or stash first", e.message())))?;
    repo.set_head(&refname)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A repo with one commit on `main` and a second branch `feature` whose
    /// copy of the file differs, so a switch has something to actually do.
    fn repo() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let repo = git2::Repository::init(&root).unwrap();
        std::fs::write(root.join("a.txt"), "main\n").unwrap();

        let sig = git2::Signature::now("t", "t@example.com").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let first = repo
            .commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .unwrap();
        drop(tree);

        // Name it `main` whatever the machine's init.defaultBranch says.
        let head_name = repo.head().unwrap().shorthand().unwrap().to_string();
        if head_name != "main" {
            repo.find_branch(&head_name, git2::BranchType::Local)
                .unwrap()
                .rename("main", false)
                .unwrap();
            repo.set_head("refs/heads/main").unwrap();
        }

        let parent = repo.find_commit(first).unwrap();
        repo.branch("feature", &parent, false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        std::fs::write(root.join("a.txt"), "feature\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "feature", &tree, &[&parent])
            .unwrap();
        drop(tree);
        drop(index);

        // Leave it on main, which is where a test expects to start.
        repo.set_head("refs/heads/main").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .unwrap();
        (dir, root)
    }

    #[test]
    fn lists_both_branches_and_marks_the_one_checked_out() {
        let (_d, root) = repo();
        let branches = list(&root).unwrap();
        let names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, vec!["feature", "main"]);
        assert!(branches.iter().find(|b| b.name == "main").unwrap().is_head);
        assert!(!branches.iter().find(|b| b.name == "feature").unwrap().is_head);
    }

    #[test]
    fn switching_moves_head_and_the_files_with_it() {
        let (_d, root) = repo();
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "main\n");

        switch(&root, "feature").unwrap();

        // Both halves: the ref moved, and so did the working tree. Moving only
        // HEAD would leave every file looking modified.
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "feature\n"
        );
        let branches = list(&root).unwrap();
        assert!(branches.iter().find(|b| b.name == "feature").unwrap().is_head);
    }

    #[test]
    fn refuses_rather_than_discarding_uncommitted_work() {
        // The failure that matters. `a.txt` differs between the branches and
        // has unsaved edits; git refuses this, and so must we.
        let (_d, root) = repo();
        std::fs::write(root.join("a.txt"), "my work in progress\n").unwrap();

        let err = switch(&root, "feature").unwrap_err();
        assert!(matches!(err, VcsError::Refused(_)), "got {err:?}");
        // Untouched: the edit is still there and HEAD has not moved.
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "my work in progress\n"
        );
        assert!(list(&root).unwrap().iter().find(|b| b.name == "main").unwrap().is_head);
    }

    #[test]
    fn uncommitted_work_comes_along_when_it_does_not_conflict() {
        // A file that is the same on both branches is carried over, exactly as
        // git does — refusing here would make the feature useless.
        let (_d, root) = repo();
        std::fs::write(root.join("scratch.txt"), "notes\n").unwrap();

        switch(&root, "feature").unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("scratch.txt")).unwrap(),
            "notes\n"
        );
    }

    #[test]
    fn a_branch_that_does_not_exist_is_refused_by_name() {
        let (_d, root) = repo();
        let err = switch(&root, "nope").unwrap_err();
        assert!(matches!(&err, VcsError::Refused(m) if m.contains("nope")), "got {err:?}");
    }

    #[test]
    fn switching_to_where_you_already_are_is_not_an_error() {
        let (_d, root) = repo();
        switch(&root, "main").unwrap();
        assert!(list(&root).unwrap().iter().find(|b| b.name == "main").unwrap().is_head);
    }
}
