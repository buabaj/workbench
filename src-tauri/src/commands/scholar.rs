//! Scholarly search, and importing a paper into the vault.

use tauri::State;

use crate::commands::workspace::OpenWorkspaces;
use crate::error::AppError;
use crate::fsx::safe_path::Intent;
use crate::scholar::{note_for, search, slug_for, Paper, ScholarError};

impl From<ScholarError> for AppError {
    fn from(e: ScholarError) -> Self {
        match e {
            ScholarError::Http(code) => {
                AppError::Internal(format!("the paper index returned {code}"))
            }
            other => AppError::Internal(other.to_string()),
        }
    }
}

/// Where imported papers live. A plain folder, because a library the app
/// invented a private location for is a library you lose when the app goes.
const PAPERS_DIR: &str = "papers";

#[tauri::command]
pub async fn scholar_search(query: String, limit: Option<u8>) -> Result<Vec<Paper>, AppError> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    Ok(search(&query, limit.unwrap_or(20).clamp(1, 50)).await?)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub rel_path: String,
    /// Set when the open-access PDF was fetched alongside the note.
    pub pdf_rel_path: Option<String>,
    /// True when the note already existed and was left untouched.
    pub already_had_it: bool,
}

/// Write a paper into the vault as a literature note, with its PDF if open.
///
/// Never overwrites: re-importing a paper you have already annotated must not
/// discard the annotations, which is the one unrecoverable mistake this
/// command could make.
#[tauri::command]
pub async fn paper_import(
    open: State<'_, OpenWorkspaces>,
    workspace_id: String,
    paper: serde_json::Value,
) -> Result<ImportOutcome, AppError> {
    let paper: PaperInput =
        serde_json::from_value(paper).map_err(|e| AppError::Validation(e.to_string()))?;
    let paper: Paper = paper.into();

    let root = crate::commands::workspace::root_for(&open, &workspace_id)?;
    let slug = slug_for(&paper);
    let rel_path = format!("{PAPERS_DIR}/{slug}.md");

    let note_path = root.resolve(&rel_path, Intent::Write)?;
    if note_path.abs().exists() {
        return Ok(ImportOutcome { rel_path, pdf_rel_path: None, already_had_it: true });
    }
    if let Some(parent) = note_path.abs().parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(note_path.abs(), note_for(&paper))?;

    // The PDF is best effort: a paper worth reading later is worth having the
    // note for now, even if the download fails or the file is paywalled.
    let mut pdf_rel_path = None;
    if let Some(url) = &paper.pdf_url {
        let pdf_rel = format!("{PAPERS_DIR}/pdf/{slug}.pdf");
        if let Ok(p) = root.resolve(&pdf_rel, Intent::Write) {
            if fetch_pdf(url, p.abs()).await.is_ok() {
                pdf_rel_path = Some(pdf_rel);
            }
        }
    }
    Ok(ImportOutcome { rel_path, pdf_rel_path, already_had_it: false })
}

/// Download an open-access PDF, refusing anything that is not one.
async fn fetch_pdf(url: &str, dest: &std::path::Path) -> Result<(), AppError> {
    const MAX_PDF_BYTES: u64 = 64 * 1024 * 1024;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .user_agent("Workbench/0.1 (mailto:workbench@morpheusgh.co)")
        .build()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(AppError::Internal(format!("pdf fetch returned {}", resp.status())));
    }
    // A paywall usually answers with an HTML login page and a 200, so the
    // content type is checked rather than trusted.
    let is_pdf = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("pdf"));
    if !is_pdf {
        return Err(AppError::Internal("that link did not return a PDF".into()));
    }
    if resp.content_length().is_some_and(|n| n > MAX_PDF_BYTES) {
        return Err(AppError::Internal("that PDF is implausibly large".into()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err(AppError::Internal("that PDF is implausibly large".into()));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(dest, &bytes)?;
    Ok(())
}

/// The frontend sends back the same shape it was given; `Paper` is
/// serialize-only, so this mirrors it for the way in.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaperInput {
    id: String,
    title: String,
    #[serde(default)]
    authors: Vec<String>,
    #[serde(default)]
    year: Option<i32>,
    #[serde(default)]
    doi: Option<String>,
    #[serde(default)]
    venue: Option<String>,
    #[serde(default)]
    abstract_text: Option<String>,
    #[serde(default)]
    pdf_url: Option<String>,
    #[serde(default)]
    landing_url: Option<String>,
    #[serde(default)]
    cited_by: i64,
    #[serde(default)]
    open_access: bool,
}

impl From<PaperInput> for Paper {
    fn from(p: PaperInput) -> Self {
        Paper {
            id: p.id,
            title: p.title,
            authors: p.authors,
            year: p.year,
            doi: p.doi,
            venue: p.venue,
            abstract_text: p.abstract_text,
            pdf_url: p.pdf_url,
            landing_url: p.landing_url,
            cited_by: p.cited_by,
            open_access: p.open_access,
        }
    }
}
