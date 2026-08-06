//! On-demand directory listing, .gitignore-aware. One level at a time — the
//! frontend tree expands lazily, so a 20k-file repo never gets walked eagerly.

use std::path::Path;

use super::safe_path::{Intent, WorkspaceRoot};

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub rel_path: String,
    pub is_dir: bool,
    pub kind: String, // "research" | "code" | "other" | "dir"
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

    // One-level walk with full gitignore semantics from the workspace root.
    let walker = ignore::WalkBuilder::new(&dir)
        .max_depth(Some(1))
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build();

    let mut nodes = Vec::new();
    for entry in walker.flatten() {
        let path = entry.path();
        if path == dir {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
        let rel = relative_to(ws.real(), path);
        nodes.push(TreeNode {
            kind: if is_dir { "dir".into() } else { classify(&name).into() },
            name,
            rel_path: rel,
            is_dir,
        });
    }
    nodes.sort_by(|a, b| (!a.is_dir, a.name.to_lowercase()).cmp(&(!b.is_dir, b.name.to_lowercase())));
    Ok(nodes)
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
        assert!(!names.contains(&"node_modules"), "gitignore not honored");
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
}
