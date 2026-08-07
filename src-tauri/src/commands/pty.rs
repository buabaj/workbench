//! Terminal commands. One shell per `pty_open`, owned by the user.

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::error::AppError;
use crate::AppState;

impl From<crate::pty::PtyError> for AppError {
    fn from(e: crate::pty::PtyError) -> Self {
        match e {
            crate::pty::PtyError::NotFound => AppError::NotFound("terminal".into()),
            other => AppError::Internal(crate::secret::redact(&other.to_string())),
        }
    }
}

/// Open a shell in the workspace root and stream its output.
#[tauri::command]
pub fn pty_open(
    state: State<'_, AppState>,
    workspace_id: String,
    cols: u16,
    rows: u16,
    channel: Channel<InvokeResponseBody>,
) -> Result<String, AppError> {
    let cwd: String = {
        let conn = state.db.lock().expect("db lock");
        conn.query_row(
            "SELECT root_real FROM workspaces WHERE id = ?1",
            [&workspace_id],
            |r| r.get(0),
        )
        .map_err(|_| AppError::NotFound("workspace".into()))?
    };

    let id = ulid::Ulid::new().to_string();
    // Guard against a zero size before the frontend has measured itself: a
    // 0x0 pty makes programs that query the size misbehave or divide by zero.
    let cols = cols.max(20);
    let rows = rows.max(5);
    state
        .ptys
        .open(id.clone(), std::path::Path::new(&cwd), cols, rows, channel)?;
    Ok(id)
}

/// Keystrokes from the terminal, forwarded verbatim.
#[tauri::command]
pub fn pty_write(state: State<'_, AppState>, pty_id: String, data: String) -> Result<(), AppError> {
    let session = state.ptys.get(&pty_id).ok_or(crate::pty::PtyError::NotFound)?;
    session.write(data.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, AppState>,
    pty_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    let session = state.ptys.get(&pty_id).ok_or(crate::pty::PtyError::NotFound)?;
    session.resize(cols.max(20), rows.max(5))?;
    Ok(())
}

#[tauri::command]
pub fn pty_close(state: State<'_, AppState>, pty_id: String) -> Result<(), AppError> {
    state.ptys.close(&pty_id);
    Ok(())
}
