//! Typed cross-mode links, anchored durably to content rather than line numbers.

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::anchors::{self, AnchorStatus};
use crate::db::now_ms;
use crate::error::AppError;
use crate::fsx::ops;
use crate::fsx::safe_path::Intent;
use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorSpec {
    pub rel_path: String,
    pub from: usize,
    pub to: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorView {
    pub id: String,
    pub rel_path: String,
    pub excerpt: String,
    pub status: AnchorStatus,
    pub confidence: f32,
    pub from: usize,
    pub to: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkView {
    pub id: String,
    pub kind: String,
    pub note: Option<String>,
    pub src: AnchorView,
    pub dst: AnchorView,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLinks {
    pub outgoing: Vec<LinkView>,
    pub incoming: Vec<LinkView>,
}

const KINDS: [&str; 5] = [
    "supports",
    "implements",
    "tests",
    "contradicts",
    "derived_from",
];

fn excerpt(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 90 {
        let cut: String = flat.chars().take(90).collect();
        format!("{cut}…")
    } else {
        flat
    }
}

fn create_anchor(
    state: &State<'_, AppState>,
    open: &State<'_, super::workspace::OpenWorkspaces>,
    workspace_id: &str,
    spec: &AnchorSpec,
) -> Result<String, AppError> {
    let root = open
        .roots
        .lock()
        .unwrap()
        .get(workspace_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound("workspace (not open)".into()))?;
    let path = root.resolve(&spec.rel_path, Intent::Read)?;
    let contents = ops::read(&path)?;

    let fp = anchors::fingerprint(&contents.text, spec.from, spec.to, &contents.content_hash);
    if fp.exact_text.trim().is_empty() {
        return Err(AppError::Validation("select some text to anchor".into()));
    }

    let id = ulid::Ulid::new().to_string();
    let conn = state.db.lock().expect("db lock");
    conn.execute(
        "INSERT INTO anchors (id, workspace_id, rel_path, exact_text, prefix_text, suffix_text,
                              hint_from, hint_to, file_hash_at_create, status, confidence,
                              last_resolved_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'ok', 1.0, ?10, ?10)",
        rusqlite::params![
            id,
            workspace_id,
            path.rel(),
            fp.exact_text,
            fp.prefix_text,
            fp.suffix_text,
            fp.hint_from as i64,
            fp.hint_to as i64,
            fp.file_hash_at_create,
            now_ms()
        ],
    )?;
    Ok(id)
}

/// Load an anchor and re-resolve it against the file's current content.
fn resolve_anchor(
    state: &State<'_, AppState>,
    open: &State<'_, super::workspace::OpenWorkspaces>,
    workspace_id: &str,
    anchor_id: &str,
) -> Result<AnchorView, AppError> {
    let (rel_path, fp) = {
        let conn = state.db.lock().expect("db lock");
        conn.query_row(
            "SELECT rel_path, exact_text, prefix_text, suffix_text, hint_from, hint_to,
                    file_hash_at_create
               FROM anchors WHERE id = ?1",
            [anchor_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    anchors::AnchorFingerprint {
                        exact_text: r.get(1)?,
                        prefix_text: r.get(2)?,
                        suffix_text: r.get(3)?,
                        hint_from: r.get::<_, i64>(4)? as usize,
                        hint_to: r.get::<_, i64>(5)? as usize,
                        file_hash_at_create: r.get(6)?,
                    },
                ))
            },
        )
        .map_err(|_| AppError::NotFound("anchor".into()))?
    };

    // A missing or unreadable file is a broken anchor, not an error — the UI
    // still shows what it pointed at.
    let resolved = (|| {
        let root = open.roots.lock().unwrap().get(workspace_id).cloned()?;
        let path = root.resolve(&rel_path, Intent::Read).ok()?;
        let contents = ops::read(&path).ok()?;
        Some(anchors::resolve::resolve(&fp, &contents.text, &contents.content_hash))
    })();

    let view = match resolved {
        Some(r) => AnchorView {
            id: anchor_id.to_string(),
            rel_path,
            excerpt: excerpt(&r.original_text),
            status: r.status,
            confidence: r.confidence,
            from: r.from,
            to: r.to,
        },
        None => AnchorView {
            id: anchor_id.to_string(),
            rel_path,
            excerpt: excerpt(&fp.exact_text),
            status: AnchorStatus::Broken,
            confidence: 0.0,
            from: 0,
            to: 0,
        },
    };

    {
        let conn = state.db.lock().expect("db lock");
        let status = match view.status {
            AnchorStatus::Ok => "ok",
            AnchorStatus::Stale => "stale",
            AnchorStatus::Broken => "broken",
        };
        conn.execute(
            "UPDATE anchors SET status = ?1, confidence = ?2, last_resolved_at = ?3 WHERE id = ?4",
            rusqlite::params![status, view.confidence, now_ms(), anchor_id],
        )?;
    }
    Ok(view)
}

#[tauri::command]
pub fn link_create(
    state: State<'_, AppState>,
    open: State<'_, super::workspace::OpenWorkspaces>,
    workspace_id: String,
    kind: String,
    src: AnchorSpec,
    dst: AnchorSpec,
    note: Option<String>,
) -> Result<LinkView, AppError> {
    if !KINDS.contains(&kind.as_str()) {
        return Err(AppError::Validation(format!("unknown link kind '{kind}'")));
    }
    let src_id = create_anchor(&state, &open, &workspace_id, &src)?;
    let dst_id = create_anchor(&state, &open, &workspace_id, &dst)?;
    let id = ulid::Ulid::new().to_string();
    {
        let conn = state.db.lock().expect("db lock");
        conn.execute(
            "INSERT INTO links (id, workspace_id, kind, src_anchor_id, dst_anchor_id, note,
                                created_by, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'user', ?7)",
            rusqlite::params![id, workspace_id, kind, src_id, dst_id, note, now_ms()],
        )?;
    }
    Ok(LinkView {
        id,
        kind,
        note,
        src: resolve_anchor(&state, &open, &workspace_id, &src_id)?,
        dst: resolve_anchor(&state, &open, &workspace_id, &dst_id)?,
        created_at: now_ms(),
    })
}

#[tauri::command]
pub fn link_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let conn = state.db.lock().expect("db lock");
    // Anchors cascade-delete with the link.
    let anchors: Option<(String, String)> = conn
        .query_row(
            "SELECT src_anchor_id, dst_anchor_id FROM links WHERE id = ?1",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    conn.execute("DELETE FROM links WHERE id = ?1", [&id])?;
    if let Some((s, d)) = anchors {
        conn.execute("DELETE FROM anchors WHERE id IN (?1, ?2)", [&s, &d])?;
    }
    Ok(())
}

#[tauri::command]
pub fn links_for_file(
    state: State<'_, AppState>,
    open: State<'_, super::workspace::OpenWorkspaces>,
    workspace_id: String,
    rel_path: String,
) -> Result<FileLinks, AppError> {
    let rows: Vec<(String, String, Option<String>, String, String, i64, bool)> = {
        let conn = state.db.lock().expect("db lock");
        let mut stmt = conn.prepare(
            "SELECT l.id, l.kind, l.note, l.src_anchor_id, l.dst_anchor_id, l.created_at,
                    (sa.rel_path = ?2) AS outgoing
               FROM links l
               JOIN anchors sa ON sa.id = l.src_anchor_id
               JOIN anchors da ON da.id = l.dst_anchor_id
              WHERE l.workspace_id = ?1 AND (sa.rel_path = ?2 OR da.rel_path = ?2)
              ORDER BY l.created_at DESC",
        )?;
        let v: Vec<_> = stmt
            .query_map(rusqlite::params![workspace_id, rel_path], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get::<_, i64>(6)? != 0,
                ))
            })?
            .filter_map(Result::ok)
            .collect();
        v
    };

    let mut outgoing = Vec::new();
    let mut incoming = Vec::new();
    for (id, kind, note, src_id, dst_id, created_at, is_out) in rows {
        let view = LinkView {
            id,
            kind,
            note,
            src: resolve_anchor(&state, &open, &workspace_id, &src_id)?,
            dst: resolve_anchor(&state, &open, &workspace_id, &dst_id)?,
            created_at,
        };
        if is_out {
            outgoing.push(view);
        } else {
            incoming.push(view);
        }
    }
    Ok(FileLinks { outgoing, incoming })
}

#[tauri::command]
pub fn link_kinds() -> Vec<&'static str> {
    KINDS.to_vec()
}
