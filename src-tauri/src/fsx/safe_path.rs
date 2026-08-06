//! THE path-validation chokepoint. Every filesystem operation takes a
//! `SafePath`; its fields are private and its only constructor is
//! `WorkspaceRoot::resolve` — path traversal is structurally impossible to
//! reintroduce elsewhere.

use std::path::{Path, PathBuf};

use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Intent {
    Read,
    Write,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum PathError {
    #[error("path is empty")]
    Empty,
    #[error("absolute paths are not allowed")]
    Absolute,
    #[error("path escapes the workspace")]
    Escapes,
    #[error("path contains an invalid component")]
    InvalidComponent,
    #[error("writes into .git are not allowed")]
    GitInternal,
    #[error("io: {0}")]
    Io(String),
}

#[derive(Debug, Clone)]
pub struct WorkspaceRoot {
    /// Canonicalized at open.
    real: PathBuf,
}

/// A path proven to be inside its workspace. Private fields; only `resolve`
/// constructs one.
#[derive(Debug, Clone)]
pub struct SafePath {
    rel: String,
    abs: PathBuf,
}

impl SafePath {
    pub fn rel(&self) -> &str {
        &self.rel
    }
    pub fn abs(&self) -> &Path {
        &self.abs
    }
}

impl WorkspaceRoot {
    pub fn open(root: &Path) -> Result<Self, PathError> {
        let real = root
            .canonicalize()
            .map_err(|e| PathError::Io(e.to_string()))?;
        Ok(WorkspaceRoot { real })
    }

    pub fn real(&self) -> &Path {
        &self.real
    }

    pub fn resolve(&self, user_path: &str, intent: Intent) -> Result<SafePath, PathError> {
        // 1. Lexical rejections, before touching the filesystem.
        if user_path.is_empty() {
            return Err(PathError::Empty);
        }
        if user_path.contains('\0') || user_path.chars().any(|c| c.is_control()) {
            return Err(PathError::InvalidComponent);
        }
        // 2. NFC-normalize: APFS returns NFD from directory reads; "café" must
        //    be one file, not two.
        let normalized: String = user_path.nfc().collect();
        let p = Path::new(&normalized);
        if p.is_absolute() {
            return Err(PathError::Absolute);
        }
        let mut clean_parts: Vec<&std::ffi::OsStr> = Vec::new();
        for comp in p.components() {
            match comp {
                std::path::Component::Normal(c) => clean_parts.push(c),
                std::path::Component::CurDir => {}
                _ => return Err(PathError::InvalidComponent), // ParentDir, prefixes
            }
        }
        if clean_parts.is_empty() {
            return Err(PathError::Empty);
        }
        // 3. .git is read-visible but never writable.
        if intent == Intent::Write
            && clean_parts
                .iter()
                .any(|c| c.eq_ignore_ascii_case(".git"))
        {
            return Err(PathError::GitInternal);
        }

        let mut abs = self.real.clone();
        for part in &clean_parts {
            abs.push(part);
        }

        // 4. Canonicalize the deepest EXISTING ancestor and assert containment —
        //    this is what defeats symlink escapes even for not-yet-created files.
        let mut probe = abs.clone();
        let canonical_ancestor = loop {
            if let Some(parent) = probe.parent() {
                match parent.canonicalize() {
                    Ok(c) => break c,
                    Err(_) => probe = parent.to_path_buf(),
                }
            } else {
                return Err(PathError::Escapes);
            }
        };
        if !canonical_ancestor.starts_with(&self.real) {
            return Err(PathError::Escapes);
        }
        // 5. If the target itself exists and is a symlink, resolve and re-check.
        if let Ok(meta) = std::fs::symlink_metadata(&abs) {
            if meta.is_symlink() {
                let resolved = abs
                    .canonicalize()
                    .map_err(|e| PathError::Io(e.to_string()))?;
                if !resolved.starts_with(&self.real) {
                    return Err(PathError::Escapes);
                }
            }
        }

        let rel = clean_parts
            .iter()
            .map(|c| c.to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        Ok(SafePath { rel, abs })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> (tempfile::TempDir, WorkspaceRoot) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/main.rs"), "fn main() {}").unwrap();
        let ws = WorkspaceRoot::open(dir.path()).unwrap();
        (dir, ws)
    }

    #[test]
    fn traversal_table_all_rejected() {
        let (_d, ws) = root();
        for (path, intent) in [
            ("../outside.txt", Intent::Read),
            ("src/../../etc/passwd", Intent::Read),
            ("/etc/passwd", Intent::Read),
            ("", Intent::Read),
            ("src/\0evil", Intent::Read),
            (".git/config", Intent::Write),
            ("nested/.git/hooks/pre-commit", Intent::Write),
            ("..", Intent::Read),
        ] {
            assert!(
                ws.resolve(path, intent).is_err(),
                "should have rejected {path:?}"
            );
        }
    }

    #[test]
    fn normal_paths_resolve() {
        let (_d, ws) = root();
        let p = ws.resolve("src/main.rs", Intent::Read).unwrap();
        assert_eq!(p.rel(), "src/main.rs");
        assert!(p.abs().ends_with("src/main.rs"));
        // ./ is tolerated
        let p = ws.resolve("./src/main.rs", Intent::Read).unwrap();
        assert_eq!(p.rel(), "src/main.rs");
        // not-yet-existing file in an existing dir is fine for writes
        assert!(ws.resolve("src/new_file.rs", Intent::Write).is_ok());
        // .git is readable
        assert!(ws.resolve(".git/HEAD", Intent::Read).is_ok());
    }

    #[test]
    fn nfd_and_nfc_resolve_to_same_rel() {
        let (_d, ws) = root();
        let nfc = "caf\u{00e9}.md"; // café precomposed
        let nfd = "cafe\u{0301}.md"; // café decomposed
        let a = ws.resolve(nfc, Intent::Write).unwrap();
        let b = ws.resolve(nfd, Intent::Write).unwrap();
        assert_eq!(a.rel(), b.rel());
    }

    #[test]
    fn symlink_escape_rejected() {
        let (dir, ws) = root();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link-out")).unwrap();
        // Symlinked dir that escapes: resolving THROUGH it must fail.
        assert_eq!(
            ws.resolve("link-out/secret.txt", Intent::Read).unwrap_err(),
            PathError::Escapes
        );
        // A symlink target file that escapes also fails.
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            dir.path().join("file-link"),
        )
        .unwrap();
        assert_eq!(
            ws.resolve("file-link", Intent::Read).unwrap_err(),
            PathError::Escapes
        );
    }
}
