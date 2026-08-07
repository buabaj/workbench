//! Reclaiming prime-agent session leases whose owner is gone.
//!
//! prime-agent guards each session file with a directory lease under
//! `<config>/agent/session-leases/<hash>.lock/owner.json`. A clean exit removes
//! it; a SIGKILL — or a crash, or a force-quit — does not. The next attempt to
//! `--resume` that session then dies during startup with
//! "Session is already active in <id>: <path>", which is exactly the failure
//! that made reopening a saved conversation start a brand-new one instead.
//!
//! The lease records both `pid` and `processStartId`, so staleness is
//! decidable without guessing: a live pid whose start time still matches is a
//! genuine conflict and is left alone; anything else is debris. Checking the
//! start time is what makes this safe against pid reuse — removing the lease of
//! an unrelated live process would let two agents write one session file.

use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Owner {
    #[serde(default)]
    pid: Option<u32>,
    #[serde(default)]
    process_start_id: Option<String>,
    #[serde(default)]
    session_path: Option<String>,
}

/// Whether the process that took a lease is still the process running now.
///
/// `ps -o lstart=` answers liveness and identity in one call: it exits
/// non-zero for an unknown pid, and prints the start time — the same string
/// prime-agent stores — for a live one.
fn owner_is_live(pid: u32, start_id: Option<&str>) -> bool {
    let out = match std::process::Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .output()
    {
        Ok(o) => o,
        // Without a usable `ps` we cannot prove the owner is dead, so we must
        // assume it is alive: a wrong "stale" verdict corrupts a session.
        Err(_) => return true,
    };
    if !out.status.success() {
        return false;
    }
    let now = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if now.is_empty() {
        return false;
    }
    match start_id {
        // Stored as "ps:<lstart>"; a mismatch means the pid was recycled.
        Some(id) => id.trim_start_matches("ps:").trim() == now,
        None => true,
    }
}

/// SIGTERM, then SIGKILL, waiting for the pid to actually go away.
///
/// Returns false if it outlives both, in which case its lease must be left
/// alone — two agents appending to one session file would corrupt it.
fn terminate(pid: u32, start_id: Option<&str>) -> bool {
    for sig in [libc::SIGTERM, libc::SIGKILL] {
        // SAFETY: plain kill(2). The start-time check above established this
        // pid is the process that took the lease, not a recycled one.
        unsafe { libc::kill(pid as libc::pid_t, sig) };
        for _ in 0..40 {
            if !owner_is_live(pid, start_id) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
    false
}

fn same_session(a: &str, b: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    // Paths differ by /var vs /private/var on macOS, so compare canonically —
    // but fall back to the literal string when the file is already gone.
    canon(Path::new(a)) == canon(b) || a == b.to_string_lossy()
}

/// What to do when the lease on our session is held by a process still running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnLiveOwner {
    /// Leave it alone and report the conflict.
    Leave,
    /// Terminate it, then take the lease.
    ///
    /// Only correct when the owner can only be a leftover of our own previous
    /// run — i.e. the caller has already established that this task has no
    /// live agent registered in the supervisor. The agent detaches from our
    /// process group, so it survives both `kill_on_drop` and a group kill;
    /// its recorded pid is the only handle we have on it.
    Evict,
}

/// Free the lease on `session_path` so the session can be resumed.
///
/// Returns true when a lease was released. With `OnLiveOwner::Leave` a running
/// owner is never touched: the caller should surface that as a real conflict
/// rather than forcing it.
pub fn reclaim(leases_dir: &Path, session_path: &Path, on_live: OnLiveOwner) -> bool {
    let entries = match std::fs::read_dir(leases_dir) {
        Ok(e) => e,
        Err(_) => return false, // no lease directory yet — nothing to reclaim
    };

    for entry in entries.flatten() {
        let dir: PathBuf = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let owner_file = dir.join("owner.json");
        let Ok(raw) = std::fs::read_to_string(&owner_file) else {
            continue;
        };
        let Ok(owner) = serde_json::from_str::<Owner>(&raw) else {
            continue;
        };
        let Some(path) = owner.session_path.as_deref() else {
            continue;
        };
        if !same_session(path, session_path) {
            continue;
        }
        let Some(pid) = owner.pid else { continue };

        if owner_is_live(pid, owner.process_start_id.as_deref()) {
            if on_live == OnLiveOwner::Leave {
                tracing::info!(pid, "session lease held by a live agent; not reclaiming");
                return false;
            }
            tracing::warn!(pid, "evicting leftover agent still holding our session");
            if !terminate(pid, owner.process_start_id.as_deref()) {
                tracing::warn!(pid, "could not stop the lease owner; leaving lease intact");
                return false;
            }
        }
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {
                tracing::info!(pid, lease = %dir.display(), "reclaimed stale session lease");
                return true;
            }
            Err(e) => {
                tracing::warn!(error = %e, "failed to remove stale session lease");
                return false;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_lease(dir: &Path, name: &str, owner: serde_json::Value) -> PathBuf {
        let lock = dir.join(format!("{name}.lock"));
        std::fs::create_dir_all(&lock).unwrap();
        std::fs::write(lock.join("owner.json"), owner.to_string()).unwrap();
        lock
    }

    /// A pid that cannot be running: allocated, then reaped.
    fn dead_pid() -> u32 {
        let child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        let mut child = child;
        child.wait().unwrap();
        pid
    }

    #[test]
    fn reclaims_lease_whose_owner_is_gone() {
        let tmp = tempfile::tempdir().unwrap();
        let session = tmp.path().join("s.jsonl");
        std::fs::write(&session, "{}").unwrap();
        let lock = write_lease(
            tmp.path(),
            "a",
            serde_json::json!({
                "pid": dead_pid(),
                "processStartId": "ps:Fri Aug  7 02:40:03 2026",
                "sessionPath": session.to_string_lossy(),
            }),
        );

        assert!(reclaim(tmp.path(), &session, OnLiveOwner::Leave));
        assert!(!lock.exists(), "stale lease should be gone");
    }

    #[test]
    fn leaves_a_live_owner_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let session = tmp.path().join("s.jsonl");
        std::fs::write(&session, "{}").unwrap();
        // This test process is unquestionably alive; omitting processStartId
        // exercises the "cannot compare, assume live" path.
        let lock = write_lease(
            tmp.path(),
            "a",
            serde_json::json!({
                "pid": std::process::id(),
                "sessionPath": session.to_string_lossy(),
            }),
        );

        assert!(!reclaim(tmp.path(), &session, OnLiveOwner::Leave));
        assert!(lock.exists(), "a live agent's lease must never be removed");
    }

    /// The safety property that matters: a recycled pid must not shield a
    /// stale lease, and must not get an unrelated live process's lease deleted.
    #[test]
    fn pid_reuse_is_detected_by_start_time() {
        let tmp = tempfile::tempdir().unwrap();
        let session = tmp.path().join("s.jsonl");
        std::fs::write(&session, "{}").unwrap();
        write_lease(
            tmp.path(),
            "a",
            serde_json::json!({
                "pid": std::process::id(),
                // Live pid, but this is not when it started.
                "processStartId": "ps:Thu Jan  1 00:00:00 1970",
                "sessionPath": session.to_string_lossy(),
            }),
        );

        assert!(
            reclaim(tmp.path(), &session, OnLiveOwner::Leave),
            "a live pid with a different start time is a different process"
        );
    }

    #[test]
    fn ignores_leases_for_other_sessions() {
        let tmp = tempfile::tempdir().unwrap();
        let mine = tmp.path().join("mine.jsonl");
        let theirs = tmp.path().join("theirs.jsonl");
        std::fs::write(&mine, "{}").unwrap();
        std::fs::write(&theirs, "{}").unwrap();
        let lock = write_lease(
            tmp.path(),
            "a",
            serde_json::json!({
                "pid": dead_pid(),
                "sessionPath": theirs.to_string_lossy(),
            }),
        );

        assert!(!reclaim(tmp.path(), &mine, OnLiveOwner::Leave));
        assert!(lock.exists(), "another session's lease is not ours to clear");
    }

    #[test]
    fn missing_lease_directory_is_not_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!reclaim(
            &tmp.path().join("nope"),
            &tmp.path().join("s.jsonl"),
            OnLiveOwner::Leave
        ));
    }

    /// Eviction must still refuse when the owner cannot be stopped, rather
    /// than handing a second agent the same session file.
    #[test]
    fn eviction_gives_up_rather_than_double_opening_a_session() {
        let tmp = tempfile::tempdir().unwrap();
        let session = tmp.path().join("s.jsonl");
        std::fs::write(&session, "{}").unwrap();
        // pid 1 (launchd) is alive and cannot be signalled by us.
        let lock = write_lease(
            tmp.path(),
            "a",
            serde_json::json!({ "pid": 1, "sessionPath": session.to_string_lossy() }),
        );
        assert!(!reclaim(tmp.path(), &session, OnLiveOwner::Evict));
        assert!(lock.exists());
    }

    #[test]
    fn survives_a_corrupt_owner_file() {
        let tmp = tempfile::tempdir().unwrap();
        let session = tmp.path().join("s.jsonl");
        let lock = tmp.path().join("a.lock");
        std::fs::create_dir_all(&lock).unwrap();
        std::fs::write(lock.join("owner.json"), "not json at all").unwrap();
        assert!(!reclaim(tmp.path(), &session, OnLiveOwner::Leave));
    }
}
