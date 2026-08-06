//! Task diff: checkpoint tree vs a fresh snapshot of the current worktree.
//! Tree-to-tree (not tree-to-workdir) keeps the user's git config, filters and
//! ignore rules entirely out of the comparison and gives rename detection.

use git2::{Oid, Repository};

use super::VcsError;

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    TypeChanged,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Attribution {
    AgentOnly,
    UserOnly,
    Both,
    Unknown,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffSummary {
    pub rel_path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub insertions: u32,
    pub deletions: u32,
    pub is_binary: bool,
    pub attribution: Attribution,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDiff {
    pub files: Vec<FileDiffSummary>,
    pub skipped: Vec<String>,
    pub attribution_degraded: bool,
}

fn diff_opts() -> git2::DiffOptions {
    let mut o = git2::DiffOptions::new();
    o.include_typechange(true)
        .include_typechange_trees(true)
        .context_lines(3);
    o
}

pub fn tree_to_tree(
    odb: &Repository,
    before: Oid,
    after: Oid,
) -> Result<Vec<FileDiffSummary>, VcsError> {
    let before_tree = odb.find_tree(before)?;
    let after_tree = odb.find_tree(after)?;
    let mut diff = odb.diff_tree_to_tree(
        Some(&before_tree),
        Some(&after_tree),
        Some(&mut diff_opts()),
    )?;
    let mut find = git2::DiffFindOptions::new();
    find.renames(true).copies(false).rename_limit(2000);
    diff.find_similar(Some(&mut find))?;

    // Per-file line stats.
    let mut stats: std::collections::HashMap<String, (u32, u32)> = Default::default();
    diff.foreach(
        &mut |_d, _p| true,
        None,
        None,
        Some(&mut |delta, _hunk, line| {
            let path = delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            let e = stats.entry(path).or_insert((0, 0));
            match line.origin() {
                '+' => e.0 += 1,
                '-' => e.1 += 1,
                _ => {}
            }
            true
        }),
    )?;

    let mut files = Vec::new();
    for delta in diff.deltas() {
        let new_path = delta
            .new_file()
            .path()
            .map(|p| p.to_string_lossy().into_owned());
        let old_path = delta
            .old_file()
            .path()
            .map(|p| p.to_string_lossy().into_owned());
        let rel_path = new_path.clone().or_else(|| old_path.clone()).unwrap_or_default();
        let status = match delta.status() {
            git2::Delta::Added => FileStatus::Added,
            git2::Delta::Deleted => FileStatus::Deleted,
            git2::Delta::Renamed => FileStatus::Renamed,
            git2::Delta::Typechange => FileStatus::TypeChanged,
            _ => FileStatus::Modified,
        };
        let (insertions, deletions) = stats.get(&rel_path).copied().unwrap_or((0, 0));
        files.push(FileDiffSummary {
            old_path: if status == FileStatus::Renamed { old_path } else { None },
            rel_path,
            status,
            insertions,
            deletions,
            is_binary: delta.new_file().is_binary() || delta.old_file().is_binary(),
            attribution: Attribution::Unknown,
        });
    }
    Ok(files)
}

/// Unified patch text for one path.
pub fn file_patch(
    odb: &Repository,
    before: Oid,
    after: Oid,
    rel_path: &str,
) -> Result<String, VcsError> {
    let before_tree = odb.find_tree(before)?;
    let after_tree = odb.find_tree(after)?;
    let mut opts = diff_opts();
    opts.pathspec(rel_path);
    let diff =
        odb.diff_tree_to_tree(Some(&before_tree), Some(&after_tree), Some(&mut opts))?;

    let mut out = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        match line.origin() {
            '+' | '-' | ' ' => out.push(line.origin()),
            _ => {}
        }
        out.push_str(&String::from_utf8_lossy(line.content()));
        true
    })?;
    Ok(out)
}
