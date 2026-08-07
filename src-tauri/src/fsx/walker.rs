//! On-demand directory listing, .gitignore-aware. One level at a time — the
//! frontend tree expands lazily, so a 20k-file repo never gets walked eagerly.
//!
//! Ignored entries are LISTED AND MARKED, not hidden. Hiding them meant `.env`
//! vanished from the tree the moment it was gitignored — which is precisely
//! the file you open often and commit never. Editors show ignored files
//! dimmed for this reason; only `.git` itself is genuinely not worth showing.

use std::path::Path;

use super::safe_path::{Intent, WorkspaceRoot};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub rel_path: String,
    pub is_dir: bool,
    pub kind: String, // "research" | "code" | "other" | "dir"
    /// Excluded by gitignore. Shown, but visually de-emphasised.
    pub ignored: bool,
}

fn classify(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".md") || lower.ends_with(".markdown") {
        "research"
    } else if [
        ".rs", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".swift", ".c", ".h", ".cpp",
        ".json", ".toml", ".yaml", ".yml", ".css", ".html", ".sh", ".sql",
    ]
    .iter()
    .any(|e| lower.ends_with(e))
    {
        "code"
    } else {
        "other"
    }
}

/// Children of `subpath` (or the root when empty), dirs first, name-sorted,
/// honoring .gitignore and skipping .git itself.
pub fn children(
    ws: &WorkspaceRoot,
    subpath: Option<&str>,
) -> Result<Vec<TreeNode>, super::safe_path::PathError> {
    let dir: std::path::PathBuf = match subpath {
        Some(p) if !p.is_empty() => ws.resolve(p, Intent::Read)?.abs().to_path_buf(),
        _ => ws.real().to_path_buf(),
    };

    // Walk twice rather than reimplement gitignore matching: once honouring
    // it, once not. The difference is exactly the ignored set, with the
    // crate's real semantics (nested .gitignore, global excludes, negations),
    // and at depth 1 the second walk costs nothing.
    let visible: std::collections::HashSet<std::path::PathBuf> = walk(&dir, true)
        .into_iter()
        .collect();

    let mut nodes = Vec::new();
    for path in walk(&dir, false) {
        if path == dir {
            continue;
        }
        let name = match path.file_name() {
            Some(n) => n.to_string_lossy().into_owned(),
            None => continue,
        };
        let is_dir = path.is_dir();
        let rel = relative_to(ws.real(), &path);
        nodes.push(TreeNode {
            kind: if is_dir { "dir".into() } else { classify(&name).into() },
            name,
            rel_path: rel,
            is_dir,
            ignored: !visible.contains(&path),
        });
    }
    nodes.sort_by(|a, b| (!a.is_dir, a.name.to_lowercase()).cmp(&(!b.is_dir, b.name.to_lowercase())));
    Ok(nodes)
}

/// One level of `dir`, optionally honouring gitignore. `.git` is never listed.
fn walk(dir: &Path, honor_gitignore: bool) -> Vec<std::path::PathBuf> {
    ignore::WalkBuilder::new(dir)
        .max_depth(Some(1))
        .hidden(false)
        .git_ignore(honor_gitignore)
        .git_global(honor_gitignore)
        .git_exclude(honor_gitignore)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build()
        .flatten()
        .map(|e| e.path().to_path_buf())
        .collect()
}

fn relative_to(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_children_respecting_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/x")).unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".gitignore"), "node_modules/\n").unwrap();
        std::fs::write(dir.path().join("readme.md"), "# hi").unwrap();
        std::fs::write(dir.path().join("src/main.rs"), "fn main(){}").unwrap();

        let ws = WorkspaceRoot::open(dir.path()).unwrap();
        let nodes = children(&ws, None).unwrap();
        let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
        assert!(names.contains(&"src"));
        assert!(names.contains(&"readme.md"));
        assert!(
            names.contains(&"node_modules"),
            "ignored entries are listed, not hidden"
        );
        assert!(
            nodes.iter().find(|n| n.name == "node_modules").unwrap().ignored,
            "and are marked as ignored"
        );
        assert!(!nodes.iter().find(|n| n.name == "src").unwrap().ignored);
        assert!(!names.contains(&".git"));
        // dirs first
        assert!(nodes[0].is_dir);
        // classification
        let md = nodes.iter().find(|n| n.name == "readme.md").unwrap();
        assert_eq!(md.kind, "research");

        let sub = children(&ws, Some("src")).unwrap();
        assert_eq!(sub.len(), 1);
        assert_eq!(sub[0].rel_path, "src/main.rs");
        assert_eq!(sub[0].kind, "code");
    }

    /// The reported case: a gitignored `.env` vanished from the tree, which is
    /// the one file you open constantly and commit never.
    #[test]
    fn a_gitignored_dotfile_is_still_listed() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".gitignore"), ".env\n").unwrap();
        std::fs::write(dir.path().join(".env"), "KEY=x").unwrap();

        let ws = WorkspaceRoot::open(dir.path()).unwrap();
        let nodes = children(&ws, None).unwrap();
        let env = nodes
            .iter()
            .find(|n| n.name == ".env")
            .expect(".env must appear in the tree");
        assert!(env.ignored, "and must be marked ignored");
    }
}
