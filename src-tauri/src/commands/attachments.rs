//! Files picked or dropped onto the chat.
//!
//! Two jobs: name files (a native picker), and turn an image into the bytes the
//! agent's RPC wants. Nothing here is workspace-scoped — you attach a screenshot
//! from `~/Desktop` far more often than from the repository, and the agent is
//! given an absolute path either way.

use std::path::{Path, PathBuf};

use crate::error::AppError;

/// Refused above this. Bigger than a chat attachment is a data transfer, and a
/// multi-megabyte base64 blob on one JSONL line helps nobody.
pub const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub path: String,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedFile {
    pub path: String,
    pub reason: String,
}

/// What a drop or a pick yielded, partitioned.
///
/// Both halves, deliberately. Dropping three files and a folder used to fail
/// the whole batch on the folder — one thing you did not mean taking down three
/// you did. Each path stands or falls alone, and the ones that fall say why.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DescribeResult {
    pub files: Vec<PickedFile>,
    pub rejected: Vec<RejectedFile>,
}

fn partition(paths: impl Iterator<Item = PathBuf>) -> DescribeResult {
    let mut files = Vec::new();
    let mut rejected = Vec::new();
    for path in paths {
        match describe(&path) {
            Ok(f) => files.push(f),
            Err(e) => rejected.push(RejectedFile {
                path: path.to_string_lossy().to_string(),
                reason: reason_of(&e),
            }),
        }
    }
    DescribeResult { files, rejected }
}

/// The message alone. The pill has room for "is a folder", not for a wrapped
/// error type's Debug output.
fn reason_of(e: &AppError) -> String {
    match e {
        AppError::Validation(m) | AppError::Io(m) => m.clone(),
        other => other.to_string(),
    }
}

/// Native file picker, multi-select.
///
/// `async` deliberately: `blocking_pick_files` must not run on the main thread,
/// and an async command is handed to a worker. `workspace_pick` does the same
/// for the same reason.
#[tauri::command]
pub async fn attachment_pick(app: tauri::AppHandle) -> Result<DescribeResult, AppError> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().blocking_pick_files();
    let Some(files) = picked else {
        // Cancelled, which is not a failure.
        return Ok(DescribeResult { files: vec![], rejected: vec![] });
    };
    Ok(partition(
        files.into_iter().filter_map(|f| f.into_path().ok()),
    ))
}

/// Size and name for a dropped path.
///
/// Drops arrive as bare paths from the webview, so the same facts the picker
/// returns have to be gathered here too. A directory is refused: attaching one
/// means something ("all of it"? "recursively"?) that nothing downstream honours.
#[tauri::command]
pub fn attachment_describe(paths: Vec<String>) -> DescribeResult {
    partition(paths.into_iter().map(PathBuf::from))
}

fn describe(path: &Path) -> Result<PickedFile, AppError> {
    let meta = std::fs::metadata(path).map_err(|e| AppError::Io(e.to_string()))?;
    if meta.is_dir() {
        return Err(AppError::Validation(format!(
            "{} is a folder — attach the files inside it",
            name_of(path)
        )));
    }
    Ok(PickedFile {
        path: path.to_string_lossy().to_string(),
        name: name_of(path),
        size: meta.len(),
    })
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentBytes {
    /// Raw base64, no `data:` prefix — that is the shape the agent's RPC takes.
    pub base64: String,
    pub mime_type: String,
    pub size: u64,
}

/// Read an image for sending.
///
/// The type comes from the file's own first bytes, not its extension. A `.png`
/// that is really a JPEG is common enough (every "save as" that renamed rather
/// than re-encoded), and declaring the wrong mime to the model provider is
/// rejected at the far end where the error means nothing to anyone.
#[tauri::command]
pub fn attachment_read(path: String) -> Result<AttachmentBytes, AppError> {
    use base64::Engine;

    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| AppError::Io(e.to_string()))?;
    if meta.is_dir() {
        return Err(AppError::Validation("that is a folder".into()));
    }
    if meta.len() > MAX_ATTACHMENT_BYTES {
        return Err(AppError::Validation(format!(
            "{} is too large to attach — the limit is {} MB",
            name_of(&p),
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        )));
    }

    let bytes = std::fs::read(&p).map_err(|e| AppError::Io(e.to_string()))?;
    let mime = sniff_image(&bytes).ok_or_else(|| {
        AppError::Validation(format!("{} is not an image the agent can read", name_of(&p)))
    })?;

    Ok(AttachmentBytes {
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime_type: mime.to_string(),
        size: meta.len(),
    })
}

/// The image formats prime-agent accepts, identified by magic bytes.
fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    // RIFF....WEBP — the four size bytes sit between the two markers.
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0];

    #[test]
    fn identifies_the_formats_the_agent_takes() {
        assert_eq!(sniff_image(PNG), Some("image/png"));
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_image(b"GIF89a....."), Some("image/gif"));
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBPVP8 ");
        assert_eq!(sniff_image(&webp), Some("image/webp"));
    }

    #[test]
    fn rejects_what_is_not_an_image() {
        assert_eq!(sniff_image(b"#!/bin/sh\n"), None);
        assert_eq!(sniff_image(b"%PDF-1.7"), None);
        assert_eq!(sniff_image(b""), None);
        // Truncated RIFF: a header that starts right and stops early must not
        // be read past its end.
        assert_eq!(sniff_image(b"RIFF"), None);
    }

    #[test]
    fn trusts_the_bytes_over_the_extension() {
        // A JPEG named .png is ordinary, and declaring image/png for it is
        // rejected by the provider at the far end.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("actually-a-jpeg.png");
        std::fs::write(&path, [0xFF, 0xD8, 0xFF, 0xE0, 0, 0]).unwrap();

        let out = attachment_read(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(out.mime_type, "image/jpeg");
    }

    #[test]
    fn reads_an_image_as_base64_with_its_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.png");
        std::fs::write(&path, PNG).unwrap();

        let out = attachment_read(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(out.size, PNG.len() as u64);
        assert!(!out.base64.is_empty());
        // Raw base64: a `data:` prefix would be passed straight through to the
        // provider, which expects the payload alone.
        assert!(!out.base64.starts_with("data:"));
    }

    #[test]
    fn says_the_limit_when_refusing_a_large_file() {
        // "too large" without the number leaves you guessing what would fit.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.png");
        std::fs::write(&path, vec![0u8; (MAX_ATTACHMENT_BYTES + 1) as usize]).unwrap();

        let err = attachment_read(path.to_string_lossy().to_string()).unwrap_err();
        let msg = format!("{err:?}");
        assert!(msg.contains("20"), "limit not stated: {msg}");
    }

    #[test]
    fn refuses_a_folder_rather_than_guessing_what_it_means() {
        let dir = tempfile::tempdir().unwrap();
        let err = describe(dir.path()).unwrap_err();
        assert!(format!("{err:?}").contains("folder"));
    }

    #[test]
    fn describes_a_file_by_name_and_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("run.log");
        std::fs::write(&path, b"hello").unwrap();

        let out = describe(&path).unwrap();
        assert_eq!(out.name, "run.log");
        assert_eq!(out.size, 5);
        assert!(out.path.ends_with("run.log"));
    }

    #[test]
    fn a_missing_file_is_an_error_not_an_empty_attachment() {
        assert!(describe(Path::new("/nope/does-not-exist.png")).is_err());
    }

    #[test]
    fn one_bad_path_does_not_take_the_good_ones_with_it() {
        // Dropping files together with a folder used to lose the whole batch.
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("a.log");
        std::fs::write(&good, b"x").unwrap();
        let folder = dir.path().join("sub");
        std::fs::create_dir(&folder).unwrap();

        let out = attachment_describe(vec![
            good.to_string_lossy().to_string(),
            folder.to_string_lossy().to_string(),
            "/nope/missing.png".to_string(),
        ]);
        assert_eq!(out.files.len(), 1);
        assert_eq!(out.files[0].name, "a.log");
        assert_eq!(out.rejected.len(), 2);
        assert!(out.rejected[0].reason.contains("folder"), "{:?}", out.rejected);
    }

    #[test]
    fn a_rejection_carries_a_reason_worth_showing() {
        // "Io(\"...\")" in a pill helps nobody.
        let out = attachment_describe(vec!["/nope/missing.png".into()]);
        assert_eq!(out.rejected.len(), 1);
        assert!(!out.rejected[0].reason.contains("Io("), "{:?}", out.rejected);
    }
}
