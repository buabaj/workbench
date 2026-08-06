//! File operations. Everything takes a `SafePath` — never a raw path.

use sha2::Digest;

use super::safe_path::SafePath;

pub const MAX_TEXT_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum FsOpError {
    #[error("not found")]
    NotFound,
    #[error("file is binary")]
    Binary,
    #[error("file too large ({size} bytes, limit {limit})")]
    TooLarge { size: u64, limit: u64 },
    #[error("disk changed since last read")]
    Conflict { disk_hash: String },
    #[error("io: {0}")]
    Io(String),
}

impl From<std::io::Error> for FsOpError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            FsOpError::NotFound
        } else {
            FsOpError::Io(e.to_string())
        }
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    pub rel_path: String,
    pub text: String,
    pub content_hash: String,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub rel_path: String,
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: i64,
    pub content_hash: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    pub content_hash: String,
    pub mtime_ms: i64,
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    let digest = sha2::Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

pub fn read(path: &SafePath) -> Result<FileContents, FsOpError> {
    let meta = std::fs::metadata(path.abs())?;
    if meta.len() > MAX_TEXT_BYTES {
        return Err(FsOpError::TooLarge {
            size: meta.len(),
            limit: MAX_TEXT_BYTES,
        });
    }
    let bytes = std::fs::read(path.abs())?;
    if looks_binary(&bytes) {
        return Err(FsOpError::Binary);
    }
    let content_hash = hash_bytes(&bytes);
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Ok(FileContents {
        rel_path: path.rel().to_string(),
        text,
        content_hash,
        size: meta.len(),
        mtime_ms: mtime_ms(&meta),
    })
}

pub fn stat(path: &SafePath) -> Result<FileStat, FsOpError> {
    match std::fs::metadata(path.abs()) {
        Ok(meta) => {
            let content_hash = if meta.is_file() && meta.len() <= MAX_TEXT_BYTES {
                std::fs::read(path.abs()).ok().map(|b| hash_bytes(&b))
            } else {
                None
            };
            Ok(FileStat {
                rel_path: path.rel().to_string(),
                exists: true,
                is_dir: meta.is_dir(),
                size: meta.len(),
                mtime_ms: mtime_ms(&meta),
                content_hash,
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(FileStat {
            rel_path: path.rel().to_string(),
            exists: false,
            is_dir: false,
            size: 0,
            mtime_ms: 0,
            content_hash: None,
        }),
        Err(e) => Err(e.into()),
    }
}

/// Optimistic-concurrency write: if `expected_hash` is given and the file on
/// disk no longer matches, refuse with `Conflict` instead of clobbering.
/// Writes are atomic: temp file in the same directory, fsync, rename.
pub fn write(
    path: &SafePath,
    text: &str,
    expected_hash: Option<&str>,
) -> Result<WriteOutcome, FsOpError> {
    if let Some(expected) = expected_hash {
        match std::fs::read(path.abs()) {
            Ok(current) => {
                let disk_hash = hash_bytes(&current);
                if disk_hash != expected {
                    return Err(FsOpError::Conflict { disk_hash });
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Caller expected content but the file is gone — that's a
                // conflict too (someone deleted it under us).
                return Err(FsOpError::Conflict {
                    disk_hash: String::new(),
                });
            }
            Err(e) => return Err(e.into()),
        }
    }

    if let Some(parent) = path.abs().parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.abs().with_extension(format!(
        "wbtmp-{}",
        std::process::id()
    ));
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path.abs())?;

    let meta = std::fs::metadata(path.abs())?;
    Ok(WriteOutcome {
        content_hash: hash_bytes(text.as_bytes()),
        mtime_ms: mtime_ms(&meta),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsx::safe_path::{Intent, WorkspaceRoot};

    fn setup() -> (tempfile::TempDir, WorkspaceRoot) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "hello world").unwrap();
        let ws = WorkspaceRoot::open(dir.path()).unwrap();
        (dir, ws)
    }

    #[test]
    fn read_write_roundtrip_with_hash() {
        let (_d, ws) = setup();
        let p = ws.resolve("a.md", Intent::Read).unwrap();
        let c = read(&p).unwrap();
        assert_eq!(c.text, "hello world");

        let wp = ws.resolve("a.md", Intent::Write).unwrap();
        let out = write(&wp, "updated", Some(&c.content_hash)).unwrap();
        assert_eq!(read(&p).unwrap().text, "updated");
        assert_eq!(out.content_hash, hash_bytes(b"updated"));
    }

    #[test]
    fn stale_hash_conflicts_instead_of_clobbering() {
        let (_d, ws) = setup();
        let p = ws.resolve("a.md", Intent::Write).unwrap();
        let c = read(&p).unwrap();
        // Disk changes underneath (external editor / agent).
        std::fs::write(p.abs(), "changed externally").unwrap();
        let err = write(&p, "my edit", Some(&c.content_hash)).unwrap_err();
        match err {
            FsOpError::Conflict { disk_hash } => {
                assert_eq!(disk_hash, hash_bytes(b"changed externally"));
            }
            other => panic!("unexpected: {other:?}"),
        }
        // Nothing clobbered.
        assert_eq!(std::fs::read_to_string(p.abs()).unwrap(), "changed externally");
    }

    #[test]
    fn new_file_write_without_expected_hash() {
        let (_d, ws) = setup();
        let p = ws.resolve("notes/new.md", Intent::Write).unwrap();
        write(&p, "fresh", None).unwrap();
        assert_eq!(std::fs::read_to_string(p.abs()).unwrap(), "fresh");
    }

    #[test]
    fn binary_detected() {
        let (dir, ws) = setup();
        std::fs::write(dir.path().join("bin.dat"), [0u8, 1, 2, 3]).unwrap();
        let p = ws.resolve("bin.dat", Intent::Read).unwrap();
        assert!(matches!(read(&p), Err(FsOpError::Binary)));
    }
}
