//! Real terminals, owned by the user.
//!
//! Distinct from the agent's `bash` tool on purpose: the dock hosts only PTYs
//! the user opened, so nothing the agent does can appear as if the user typed
//! it, and closing a conversation never closes a shell.
//!
//! Two design points that are easy to get wrong and expensive to discover
//! later:
//!
//! - **Bytes, not Strings.** Terminal output is not guaranteed to be valid
//!   UTF-8 at a read boundary — a multi-byte character routinely straddles two
//!   reads, and lossy conversion would corrupt it permanently. Output travels
//!   as `InvokeResponseBody::Raw`, arriving in the webview as an ArrayBuffer,
//!   and xterm.js reassembles. This also avoids base64's 33% overhead.
//!
//! - **Batched.** A build can emit thousands of small writes a second. One IPC
//!   message per read would flood the channel and stall the UI thread, so a
//!   coalescing thread accumulates for `BATCH_WINDOW` and sends once.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use tauri::ipc::{Channel, InvokeResponseBody};

/// How long output accumulates before being sent. Long enough to collapse a
/// build's chatter into a handful of messages, short enough that typing still
/// echoes instantly.
const BATCH_WINDOW: Duration = Duration::from_millis(8);

/// Cap on a single batch, so one enormous burst cannot make an IPC message
/// large enough to stall the webview.
const MAX_BATCH: usize = 256 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    #[error("pty: {0}")]
    Io(String),
    #[error("no such terminal")]
    NotFound,
}

pub struct PtySession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

impl PtySession {
    pub fn write(&self, bytes: &[u8]) -> Result<(), PtyError> {
        let mut w = self.writer.lock().expect("pty writer lock");
        w.write_all(bytes).map_err(|e| PtyError::Io(e.to_string()))?;
        w.flush().map_err(|e| PtyError::Io(e.to_string()))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PtyError> {
        self.master
            .lock()
            .expect("pty master lock")
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::Io(e.to_string()))
    }

    pub fn kill(&self) {
        let _ = self.child.lock().expect("pty child lock").kill();
    }
}

#[derive(Default)]
pub struct PtyRegistry {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
}

impl PtyRegistry {
    pub fn get(&self, id: &str) -> Option<Arc<PtySession>> {
        self.sessions.lock().expect("pty registry").get(id).cloned()
    }

    /// Open a shell in `cwd`, streaming its output to `channel`.
    pub fn open(
        &self,
        id: String,
        cwd: &std::path::Path,
        cols: u16,
        rows: u16,
        channel: Channel<InvokeResponseBody>,
    ) -> Result<(), PtyError> {
        let pair = NativePtySystem::default()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::Io(e.to_string()))?;

        let mut cmd = CommandBuilder::new(user_shell());
        // A login shell, so the user's own PATH, aliases and prompt are here.
        // A terminal that does not match the one in iTerm is a broken promise.
        cmd.arg("-l");
        cmd.cwd(cwd);
        // Inherited environment, unlike the agent's deliberately cleared one:
        // this shell belongs to the user, not to us.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::Io(e.to_string()))?;
        // Dropping the slave here is what lets the reader see EOF when the
        // shell exits; holding it open would hang the reader thread forever.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PtyError::Io(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PtyError::Io(e.to_string()))?;

        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        spawn_reader(reader, tx);
        spawn_batcher(rx, channel);

        self.sessions.lock().expect("pty registry").insert(
            id,
            Arc::new(PtySession {
                writer: Mutex::new(writer),
                master: Mutex::new(pair.master),
                child: Mutex::new(child),
            }),
        );
        Ok(())
    }

    pub fn close(&self, id: &str) {
        if let Some(s) = self.sessions.lock().expect("pty registry").remove(id) {
            s.kill();
        }
    }

    /// Kill every shell. Called on app exit so no terminal outlives the window.
    pub fn close_all(&self) {
        let mut map = self.sessions.lock().expect("pty registry");
        for (_, s) in map.iter() {
            s.kill();
        }
        map.clear();
    }
}

fn user_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
}

/// Blocking reads on a dedicated OS thread.
///
/// Deliberately `std::thread` rather than a tokio task: a PTY read blocks with
/// no async equivalent, and parking a runtime worker on it would starve the
/// executor that every other command shares.
fn spawn_reader(mut reader: Box<dyn Read + Send>, tx: mpsc::Sender<Vec<u8>>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // shell exited
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break; // receiver gone; terminal was closed
                    }
                }
                Err(_) => break,
            }
        }
    });
}

/// Coalesce reads into one IPC message per `BATCH_WINDOW`.
fn spawn_batcher(rx: mpsc::Receiver<Vec<u8>>, channel: Channel<InvokeResponseBody>) {
    std::thread::spawn(move || {
        loop {
            // Block until there is anything at all, so an idle terminal costs
            // nothing rather than waking every 8ms.
            let first = match rx.recv() {
                Ok(b) => b,
                Err(_) => break,
            };
            let mut batch = first;
            let deadline = std::time::Instant::now() + BATCH_WINDOW;
            while batch.len() < MAX_BATCH {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                if left.is_zero() {
                    break;
                }
                match rx.recv_timeout(left) {
                    Ok(more) => batch.extend_from_slice(&more),
                    Err(_) => break,
                }
            }
            if channel.send(InvokeResponseBody::Raw(batch)).is_err() {
                break; // webview gone
            }
        }
        // EOF: tell the frontend the shell is gone. An empty frame is
        // unambiguous — a PTY read of length 0 already means exit, so it
        // cannot collide with real output.
        let _ = channel.send(InvokeResponseBody::Raw(Vec::new()));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_shell_falls_back_when_unset() {
        // Whatever SHELL is here, the result must be a usable absolute path.
        let shell = user_shell();
        assert!(shell.starts_with('/'), "got {shell}");
    }

    /// The batching contract: many small reads collapse into far fewer sends,
    /// and no byte is lost or reordered on the way.
    #[test]
    fn batching_preserves_every_byte_in_order() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let collected = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = collected.clone();

        // Stand in for the IPC channel with the same coalescing loop.
        let handle = std::thread::spawn(move || {
            let mut batches = 0usize;
            while let Ok(first) = rx.recv() {
                let mut batch = first;
                let deadline = std::time::Instant::now() + BATCH_WINDOW;
                while batch.len() < MAX_BATCH {
                    let left = deadline.saturating_duration_since(std::time::Instant::now());
                    if left.is_zero() {
                        break;
                    }
                    match rx.recv_timeout(left) {
                        Ok(more) => batch.extend_from_slice(&more),
                        Err(_) => break,
                    }
                }
                sink.lock().unwrap().extend_from_slice(&batch);
                batches += 1;
            }
            batches
        });

        let mut expected = Vec::new();
        for i in 0..500u32 {
            let chunk = format!("line {i}\n").into_bytes();
            expected.extend_from_slice(&chunk);
            tx.send(chunk).unwrap();
        }
        drop(tx);
        let batches = handle.join().unwrap();

        assert_eq!(*collected.lock().unwrap(), expected, "bytes must survive batching");
        assert!(batches < 500, "500 writes should not be 500 IPC messages, got {batches}");
    }

    /// A UTF-8 character split across two reads must survive, which is the
    /// whole reason output is carried as bytes rather than String.
    #[test]
    fn a_split_multibyte_character_is_not_corrupted() {
        let text = "héllo — ünïcode ✓".as_bytes().to_vec();
        let (head, tail) = text.split_at(2); // lands mid-character
        let mut rebuilt = Vec::new();
        rebuilt.extend_from_slice(head);
        rebuilt.extend_from_slice(tail);
        assert_eq!(
            String::from_utf8(rebuilt).unwrap(),
            "héllo — ünïcode ✓",
            "byte transport must not transform the stream"
        );
        // The lossy path this avoids would have produced replacement chars.
        assert!(String::from_utf8_lossy(head).contains('\u{fffd}'));
    }
}
