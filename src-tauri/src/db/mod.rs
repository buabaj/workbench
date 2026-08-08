//! SQLite layer: connection setup + forward-only migrations.
//!
//! Rules:
//! - `foreign_keys` is per-connection; set it in `configure`, never assume it.
//! - Migrations are append-only, versioned by `PRAGMA user_version`, applied in a
//!   transaction each. Never edited after ship. No down-migrations.
//! - A DB from a NEWER app version (user downgraded) is refused, not "repaired".

use std::path::Path;

use rusqlite::Connection;

const MIGRATIONS: &[&str] = &[
    include_str!("migrations/0001_init.sql"),
    include_str!("migrations/0002_providers.sql"),
    include_str!("migrations/0003_tasks.sql"),
    include_str!("migrations/0004_checkpoints.sql"),
    include_str!("migrations/0005_links.sql"),
    include_str!("migrations/0006_appai.sql"),
    include_str!("migrations/0007_chat.sql"),
    include_str!("migrations/0008_task_title.sql"),
    include_str!("migrations/0009_forget_workspace.sql"),
    include_str!("migrations/0010_note_generations.sql"),
];

/// Current unix time in milliseconds — the app's single timestamp convention.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn open(path: &Path) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open(path)?;
    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

#[cfg(test)]
pub fn open_in_memory() -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open_in_memory()?;
    configure(&conn)?;
    migrate(&conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    Ok(())
}

fn migrate(conn: &Connection) -> Result<(), rusqlite::Error> {
    let current: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let target = MIGRATIONS.len() as u32;

    if current > target {
        // App downgrade. Refuse loudly rather than guessing at the schema.
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_MISMATCH),
            Some(format!(
                "database schema v{current} is newer than this app supports (v{target}); \
                 refusing to open"
            )),
        ));
    }

    for (idx, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let version = idx as u32 + 1;
        tracing::info!(version, "applying migration");
        conn.execute_batch(&format!(
            "BEGIN;\n{sql}\nPRAGMA user_version = {version};\nCOMMIT;"
        ))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn migrations_apply_from_zero() {
        let conn = super::open_in_memory().expect("open");
        let v: u32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, super::MIGRATIONS.len() as u32);
        // spot-check a table exists
        let n: u32 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='workspaces'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn newer_schema_is_refused() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", 999).unwrap();
        let err = super::migrate(&conn).unwrap_err();
        assert!(err.to_string().contains("newer"));
    }

    #[test]
    fn foreign_keys_are_on() {
        let conn = super::open_in_memory().unwrap();
        let fk: u32 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1);
    }
}
