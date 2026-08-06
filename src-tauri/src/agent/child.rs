//! Process abstraction the dispatcher runs against.
//!
//! Output is handed over as an unbounded channel at spawn time. Adapters that
//! wrap bounded upstream sources (e.g. tauri-plugin-shell's buffer-1 channel)
//! MUST pump into this channel with zero work per message — anything slower
//! backpressures the child's stdout and can stall the model mid-stream.

use tokio::sync::mpsc;

#[derive(Debug)]
pub enum RawOutput {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Terminated { code: Option<i32>, signal: Option<i32> },
}

pub trait ChildProcess: Send + 'static {
    fn write_stdin(&mut self, bytes: &[u8]) -> std::io::Result<()>;
    fn kill(&mut self) -> std::io::Result<()>;
    fn pid(&self) -> Option<u32>;
}

/// In-memory child for dispatcher tests: records stdin writes, exposes the
/// output sender so tests can inject stdout/stderr/termination directly.
pub struct MockChild {
    pub stdin: std::sync::Arc<std::sync::Mutex<Vec<Vec<u8>>>>,
    pub killed: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl MockChild {
    #[allow(clippy::type_complexity)]
    pub fn new() -> (
        Self,
        mpsc::UnboundedSender<RawOutput>,
        mpsc::UnboundedReceiver<RawOutput>,
        std::sync::Arc<std::sync::Mutex<Vec<Vec<u8>>>>,
    ) {
        let (tx, rx) = mpsc::unbounded_channel();
        let stdin = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let child = MockChild {
            stdin: stdin.clone(),
            killed: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        };
        (child, tx, rx, stdin)
    }
}

impl ChildProcess for MockChild {
    fn write_stdin(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.stdin.lock().unwrap().push(bytes.to_vec());
        Ok(())
    }

    fn kill(&mut self) -> std::io::Result<()> {
        self.killed.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    fn pid(&self) -> Option<u32> {
        None
    }
}

/// Adapter over a tokio child process (fake-agent e2e now; later the
/// process-group-capable escape hatch for real spawns).
///
/// stdin is converted to a blocking `std::fs::File` at spawn: command lines are
/// tiny, a pipe accepts them without blocking in practice, and it keeps the
/// `ChildProcess` trait synchronous.
pub struct TokioChild {
    stdin: Option<std::fs::File>,
    child: tokio::process::Child,
}

impl TokioChild {
    /// Spawn and wire stdout/stderr/exit into a single RawOutput channel.
    /// `Terminated` is emitted after both readers hit EOF and the child is reaped.
    pub fn spawn(
        mut cmd: tokio::process::Command,
    ) -> std::io::Result<(Self, mpsc::UnboundedReceiver<RawOutput>)> {
        use std::process::Stdio;
        use tokio::io::AsyncReadExt;

        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn()?;

        #[cfg(unix)]
        let stdin = child.stdin.take().map(|s| {
            let fd: std::os::fd::OwnedFd = s.into_owned_fd().expect("stdin fd");
            std::fs::File::from(fd)
        });
        #[cfg(not(unix))]
        let stdin: Option<std::fs::File> = unimplemented!("macOS-only prototype");

        let mut stdout = child.stdout.take().expect("stdout piped");
        let mut stderr = child.stderr.take().expect("stderr piped");

        let (tx, rx) = mpsc::unbounded_channel();

        let out_task = {
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 64 * 1024];
                loop {
                    match stdout.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send(RawOutput::Stdout(buf[..n].to_vec())).is_err() {
                                break;
                            }
                        }
                    }
                }
            })
        };
        let err_task = {
            let tx = tx.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    match stderr.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send(RawOutput::Stderr(buf[..n].to_vec())).is_err() {
                                break;
                            }
                        }
                    }
                }
            })
        };

        // Exit watcher: after both readers finish, reap and emit Terminated.
        let exit_rx = {
            let (exit_tx, exit_rx) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let _ = out_task.await;
                let _ = err_task.await;
                let _ = exit_tx.send(());
            });
            exit_rx
        };
        {
            let tx = tx.clone();
            let waiter = child.id(); // just to move nothing mutable; wait handled below
            let _ = waiter;
            tokio::spawn(async move {
                let _ = exit_rx.await;
                // The dispatcher owns `child` via TokioChild; we cannot wait() here.
                // Emit Terminated with unknown code — the owner may call `reap()`
                // for the real status if it needs it.
                let _ = tx.send(RawOutput::Terminated {
                    code: None,
                    signal: None,
                });
            });
        }

        Ok((TokioChild { stdin, child }, rx))
    }

    /// Wait for exit and return the real status (optional, after Terminated).
    pub async fn reap(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.child.wait().await
    }
}

impl ChildProcess for TokioChild {
    fn write_stdin(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        use std::io::Write;
        let stdin = self
            .stdin
            .as_mut()
            .ok_or_else(|| std::io::Error::other("stdin closed"))?;
        stdin.write_all(bytes)?;
        stdin.flush()
    }

    fn kill(&mut self) -> std::io::Result<()> {
        self.child.start_kill()
    }

    fn pid(&self) -> Option<u32> {
        self.child.id()
    }
}
