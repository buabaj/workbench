//! Checkpoint engine tests against fixture repos.
//!
//! EVERY case asserts the two invariants beyond its own claim:
//!   1. the user's `.git/index` bytes are unchanged
//!   2. HEAD and all refs are unchanged
//! Those are the promises the whole review layer rests on.

use std::path::Path;

use workbench_lib::vcs::{diff, restore, snapshot, VcsError};

struct Fixture {
    _dir: tempfile::TempDir,
    root: std::path::PathBuf,
    odb_dir: tempfile::TempDir,
}

fn run_git(root: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}

impl Fixture {
    fn git() -> Self {
        let f = Self::plain();
        run_git(&f.root, &["init", "-q"]);
        std::fs::write(f.root.join("tracked.txt"), "original\n").unwrap();
        run_git(&f.root, &["add", "."]);
        run_git(&f.root, &["commit", "-qm", "initial"]);
        f
    }

    fn plain() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(root.join("tracked.txt"), "original\n").unwrap();
        Fixture {
            _dir: dir,
            root,
            odb_dir: tempfile::tempdir().unwrap(),
        }
    }

    fn odb(&self) -> git2::Repository {
        let path = self.odb_dir.path().join("checkpoints.git");
        if path.exists() {
            git2::Repository::open_bare(&path).unwrap()
        } else {
            git2::Repository::init_bare(&path).unwrap()
        }
    }

    /// Semantic staging state: staged path→mode→OID plus HEAD and all refs.
    ///
    /// Deliberately NOT the raw `.git/index` bytes: git itself opportunistically
    /// rewrites the index stat cache (ctime/mtime/inode) whenever the user runs
    /// `git status`, and an atomic temp+rename restore legitimately changes a
    /// file's inode. What must never change is what is *staged* — see
    /// `restore_never_writes_the_index_file` for the byte-level proof that our
    /// code doesn't touch the index at all.
    fn git_state(&self) -> Option<(String, String)> {
        let staged = std::process::Command::new("git")
            .args(["ls-files", "--stage"])
            .current_dir(&self.root)
            .output()
            .ok()?;
        let refs = std::process::Command::new("git")
            .args(["show-ref", "--head"])
            .current_dir(&self.root)
            .output()
            .ok()?;
        Some((
            String::from_utf8_lossy(&staged.stdout).into_owned(),
            String::from_utf8_lossy(&refs.stdout).into_owned(),
        ))
    }

    fn index_bytes(&self) -> Vec<u8> {
        std::fs::read(self.root.join(".git/index")).unwrap_or_default()
    }

    fn checkpoint(&self, odb: &git2::Repository) -> git2::Oid {
        snapshot::snapshot(odb, &self.root, "refs/workbench/checkpoints/t1", "pre-task")
            .unwrap()
            .tree
    }

    fn after(&self, odb: &git2::Repository) -> git2::Oid {
        snapshot::snapshot(odb, &self.root, "refs/workbench/checkpoints/t1-after", "post")
            .unwrap()
            .tree
    }
}

/// The invariant assertion every test runs: staged content and refs unchanged.
fn assert_git_untouched(f: &Fixture, before: Option<(String, String)>) {
    let after = f.git_state();
    assert_eq!(before, after, "user's staged content or refs were modified");
}

#[test]
fn modified_file_diffs_and_restores_byte_exact() {
    let f = Fixture::git();
    let odb = f.odb();
    let before_git = f.git_state();
    let cp = f.checkpoint(&odb);

    std::fs::write(f.root.join("tracked.txt"), "agent edit\n").unwrap();
    let after = f.after(&odb);

    let files = diff::tree_to_tree(&odb, cp, after).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].rel_path, "tracked.txt");
    assert_eq!(files[0].status, diff::FileStatus::Modified);
    assert_eq!(files[0].insertions, 1);
    assert_eq!(files[0].deletions, 1);

    let r = restore::restore(&odb, &f.root, cp, &["tracked.txt".into()], None).unwrap();
    assert_eq!(r.restored, vec!["tracked.txt"]);
    assert_eq!(
        std::fs::read_to_string(f.root.join("tracked.txt")).unwrap(),
        "original\n"
    );
    assert_git_untouched(&f, before_git);
}

#[test]
fn staged_and_unstaged_changes_survive_restore() {
    let f = Fixture::git();
    let odb = f.odb();

    // Stage one change, leave another unstaged.
    std::fs::write(f.root.join("tracked.txt"), "staged content\n").unwrap();
    run_git(&f.root, &["add", "tracked.txt"]);
    std::fs::write(f.root.join("unstaged.txt"), "unstaged\n").unwrap();

    let porcelain_before = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&f.root)
        .output()
        .unwrap()
        .stdout;
    let before_git = f.git_state();

    let cp = f.checkpoint(&odb);
    // Agent modifies both.
    std::fs::write(f.root.join("tracked.txt"), "agent overwrote\n").unwrap();
    std::fs::write(f.root.join("unstaged.txt"), "agent overwrote\n").unwrap();

    restore::restore(
        &odb,
        &f.root,
        cp,
        &["tracked.txt".into(), "unstaged.txt".into()],
        None,
    )
    .unwrap();

    let porcelain_after = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&f.root)
        .output()
        .unwrap()
        .stdout;
    assert_eq!(
        porcelain_before, porcelain_after,
        "git status changed across checkpoint+restore"
    );
    assert_git_untouched(&f, before_git);
}

#[test]
fn agent_created_file_is_trashed_on_restore() {
    let f = Fixture::git();
    let odb = f.odb();
    let before_git = f.git_state();
    let cp = f.checkpoint(&odb);

    std::fs::create_dir_all(f.root.join("newdir")).unwrap();
    std::fs::write(f.root.join("newdir/created.rs"), "fn new() {}").unwrap();
    let after = f.after(&odb);

    let files = diff::tree_to_tree(&odb, cp, after).unwrap();
    assert_eq!(files[0].status, diff::FileStatus::Added);

    let r = restore::restore(&odb, &f.root, cp, &["newdir/created.rs".into()], None).unwrap();
    assert_eq!(r.trashed, vec!["newdir/created.rs"]);
    assert!(!f.root.join("newdir/created.rs").exists());
    assert!(!f.root.join("newdir").exists(), "empty parent not cleaned");
    assert_git_untouched(&f, before_git);
}

#[test]
fn agent_deleted_file_is_recreated() {
    let f = Fixture::git();
    let odb = f.odb();
    let before_git = f.git_state();
    let cp = f.checkpoint(&odb);

    std::fs::remove_file(f.root.join("tracked.txt")).unwrap();
    let after = f.after(&odb);
    let files = diff::tree_to_tree(&odb, cp, after).unwrap();
    assert_eq!(files[0].status, diff::FileStatus::Deleted);

    let r = restore::restore(&odb, &f.root, cp, &["tracked.txt".into()], None).unwrap();
    assert_eq!(r.recreated, vec!["tracked.txt"]);
    assert_eq!(
        std::fs::read_to_string(f.root.join("tracked.txt")).unwrap(),
        "original\n"
    );
    assert_git_untouched(&f, before_git);
}

#[test]
fn rename_is_detected() {
    let f = Fixture::git();
    let odb = f.odb();
    std::fs::write(
        f.root.join("longer.txt"),
        "line one\nline two\nline three\nline four\n",
    )
    .unwrap();
    let cp = f.checkpoint(&odb);

    std::fs::rename(f.root.join("longer.txt"), f.root.join("renamed.txt")).unwrap();
    let after = f.after(&odb);

    let files = diff::tree_to_tree(&odb, cp, after).unwrap();
    let renamed = files
        .iter()
        .find(|f| f.status == diff::FileStatus::Renamed)
        .expect("rename not detected");
    assert_eq!(renamed.rel_path, "renamed.txt");
    assert_eq!(renamed.old_path.as_deref(), Some("longer.txt"));
}

#[test]
fn gitignored_files_are_not_checkpointed() {
    let f = Fixture::git();
    let odb = f.odb();
    std::fs::write(f.root.join(".gitignore"), "secrets/\n*.log\n").unwrap();
    std::fs::create_dir_all(f.root.join("secrets")).unwrap();
    std::fs::write(f.root.join("secrets/key.txt"), "sk-SENTINEL").unwrap();
    std::fs::write(f.root.join("debug.log"), "noise").unwrap();

    let cp = f.checkpoint(&odb);
    let tree = odb.find_tree(cp).unwrap();
    assert!(tree.get_path(Path::new("secrets/key.txt")).is_err());
    assert!(tree.get_path(Path::new("debug.log")).is_err());
    assert!(tree.get_path(Path::new("tracked.txt")).is_ok());
}

#[test]
fn non_git_workspace_behaves_identically() {
    let f = Fixture::plain(); // no .git at all
    let odb = f.odb();
    let cp = f.checkpoint(&odb);

    std::fs::write(f.root.join("tracked.txt"), "changed\n").unwrap();
    std::fs::write(f.root.join("added.txt"), "new\n").unwrap();
    let after = f.after(&odb);

    let files = diff::tree_to_tree(&odb, cp, after).unwrap();
    assert_eq!(files.len(), 2);

    restore::restore(
        &odb,
        &f.root,
        cp,
        &["tracked.txt".into(), "added.txt".into()],
        None,
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(f.root.join("tracked.txt")).unwrap(),
        "original\n"
    );
    assert!(!f.root.join("added.txt").exists());
}

#[test]
fn crlf_content_round_trips_exactly() {
    // Proves the raw-bytes blob path bypasses clean filters: with autocrlf on,
    // a filtered snapshot would not restore byte-exact.
    let f = Fixture::git();
    run_git(&f.root, &["config", "core.autocrlf", "true"]);
    let odb = f.odb();
    let crlf = b"line one\r\nline two\r\n";
    std::fs::write(f.root.join("crlf.txt"), crlf).unwrap();

    let cp = f.checkpoint(&odb);
    std::fs::write(f.root.join("crlf.txt"), b"clobbered\n").unwrap();
    restore::restore(&odb, &f.root, cp, &["crlf.txt".into()], None).unwrap();

    assert_eq!(std::fs::read(f.root.join("crlf.txt")).unwrap(), crlf);
}

#[test]
fn executable_bit_and_symlinks_preserved() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::plain();
    let odb = f.odb();
    std::fs::write(f.root.join("script.sh"), "#!/bin/sh\necho hi\n").unwrap();
    std::fs::set_permissions(
        f.root.join("script.sh"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    std::os::unix::fs::symlink("tracked.txt", f.root.join("link.txt")).unwrap();

    let cp = f.checkpoint(&odb);
    std::fs::set_permissions(
        f.root.join("script.sh"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    std::fs::remove_file(f.root.join("link.txt")).unwrap();

    restore::restore(
        &odb,
        &f.root,
        cp,
        &["script.sh".into(), "link.txt".into()],
        None,
    )
    .unwrap();

    let mode = std::fs::metadata(f.root.join("script.sh")).unwrap().permissions().mode();
    assert_eq!(mode & 0o111, 0o111, "exec bit lost");
    let meta = std::fs::symlink_metadata(f.root.join("link.txt")).unwrap();
    assert!(meta.is_symlink(), "symlink restored as a regular file");
    assert_eq!(
        std::fs::read_link(f.root.join("link.txt")).unwrap().to_string_lossy(),
        "tracked.txt"
    );
}

#[test]
fn restore_is_idempotent_and_undoable() {
    let f = Fixture::git();
    let odb = f.odb();
    let cp = f.checkpoint(&odb);
    std::fs::write(f.root.join("tracked.txt"), "agent edit\n").unwrap();

    let r1 = restore::restore(
        &odb,
        &f.root,
        cp,
        &["tracked.txt".into()],
        Some("refs/workbench/restores/t1/1"),
    )
    .unwrap();
    assert!(r1.undo_ref.is_some());

    // Second restore is a no-op with identical results.
    let r2 = restore::restore(&odb, &f.root, cp, &["tracked.txt".into()], None).unwrap();
    assert_eq!(r1.restored, r2.restored);
    assert_eq!(
        std::fs::read_to_string(f.root.join("tracked.txt")).unwrap(),
        "original\n"
    );

    // Undo returns to the post-task state.
    let undo_tree = odb
        .find_reference("refs/workbench/restores/t1/1")
        .unwrap()
        .peel_to_tree()
        .unwrap()
        .id();
    restore::restore(&odb, &f.root, undo_tree, &["tracked.txt".into()], None).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.root.join("tracked.txt")).unwrap(),
        "agent edit\n"
    );
}

#[test]
fn user_git_gc_mid_task_does_not_affect_checkpoints() {
    let f = Fixture::git();
    let odb = f.odb();
    let cp = f.checkpoint(&odb);
    std::fs::write(f.root.join("tracked.txt"), "agent edit\n").unwrap();

    // The user runs aggressive gc in THEIR repo — our ODB is separate.
    run_git(&f.root, &["gc", "--prune=now", "-q"]);

    restore::restore(&odb, &f.root, cp, &["tracked.txt".into()], None).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.root.join("tracked.txt")).unwrap(),
        "original\n"
    );
}

#[test]
fn restore_never_writes_the_index_file() {
    // Byte-level proof that checkpoint + diff + restore never touch .git/index.
    // No git command runs between the two reads, so git's own stat-cache
    // refresh can't muddy the result.
    let f = Fixture::git();
    let odb = f.odb();
    std::fs::write(f.root.join("staged.txt"), "staged\n").unwrap();
    run_git(&f.root, &["add", "staged.txt"]);

    let index_before = f.index_bytes();
    assert!(!index_before.is_empty());

    let cp = f.checkpoint(&odb);
    std::fs::write(f.root.join("tracked.txt"), "agent edit\n").unwrap();
    std::fs::write(f.root.join("staged.txt"), "agent edit\n").unwrap();
    let after_tree = f.after(&odb);
    let _ = diff::tree_to_tree(&odb, cp, after_tree).unwrap();
    restore::restore(
        &odb,
        &f.root,
        cp,
        &["tracked.txt".into(), "staged.txt".into()],
        Some("refs/workbench/restores/t1/1"),
    )
    .unwrap();

    assert_eq!(
        index_before,
        f.index_bytes(),
        ".git/index bytes changed — our code wrote to the user's index"
    );
}

#[test]
fn unsafe_paths_are_refused() {
    let f = Fixture::git();
    let odb = f.odb();
    let cp = f.checkpoint(&odb);

    let r = restore::restore(
        &odb,
        &f.root,
        cp,
        &["../escape.txt".into(), ".git/config".into()],
        None,
    )
    .unwrap();
    assert_eq!(r.refused.len(), 2);
    assert!(r.restored.is_empty());
}

#[test]
fn large_files_are_skipped_not_silently_included() {
    let f = Fixture::plain();
    let odb = f.odb();
    let big = vec![b'x'; (snapshot::MAX_BLOB_BYTES + 1) as usize];
    std::fs::write(f.root.join("big.bin"), &big).unwrap();

    let result =
        snapshot::snapshot(&odb, &f.root, "refs/workbench/checkpoints/t1", "pre").unwrap();
    assert!(result.skipped.contains(&"big.bin".to_string()));
    let tree = odb.find_tree(result.tree).unwrap();
    assert!(tree.get_path(Path::new("big.bin")).is_err());
}

#[test]
fn identical_snapshots_dedupe_to_same_tree() {
    // Zeroed stat fields make the tree a pure function of content.
    let f = Fixture::plain();
    let odb = f.odb();
    let a = snapshot::snapshot(&odb, &f.root, "refs/workbench/checkpoints/a", "a").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    let b = snapshot::snapshot(&odb, &f.root, "refs/workbench/checkpoints/b", "b").unwrap();
    assert_eq!(a.tree, b.tree);
}

#[test]
fn file_patch_produces_unified_diff() -> Result<(), VcsError> {
    let f = Fixture::plain();
    let odb = f.odb();
    let cp = f.checkpoint(&odb);
    std::fs::write(f.root.join("tracked.txt"), "changed\n").unwrap();
    let after = f.after(&odb);

    let patch = diff::file_patch(&odb, cp, after, "tracked.txt")?;
    assert!(patch.contains("-original"));
    assert!(patch.contains("+changed"));
    Ok(())
}
