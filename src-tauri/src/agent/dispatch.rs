//! Request/response correlation and event streaming over one agent child.
//!
//! Topology: a writer task owns the `ChildProcess` (stdin + kill); a reader task
//! consumes the unbounded `RawOutput` channel, frames stdout, parses, resolves
//! pending requests, and forwards everything else to the seq-stamped stream.
//! stderr accumulates in a capped tail ring — the crash-diagnosis channel.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use super::child::{ChildProcess, RawOutput};
use super::framer::{FrameEvent, LineFramer};
use super::protocol::{parse_frame, AgentEvent, Frame, ResponseEnvelope};

const STDERR_TAIL_CAP: usize = 256 * 1024;

#[derive(Debug)]
pub enum StreamItem {
    Event(AgentEvent),
    Unknown { raw_type: String, raw: Value },
    ProtocolError { reason: String, sample: String },
    /// Response whose id matched no pending request (late after timeout,
    /// duplicate, or agent-initiated). Diagnostic, never fatal.
    OrphanResponse(ResponseEnvelope),
    Oversize { dropped_bytes: usize },
    ProcessExited { code: Option<i32>, signal: Option<i32> },
}

#[derive(Debug)]
pub struct StreamEnvelope {
    pub seq: u64,
    pub item: StreamItem,
}

#[derive(Debug, thiserror::Error)]
pub enum DispatchError {
    #[error("request '{command}' timed out after {ms}ms")]
    Timeout { command: String, ms: u64 },
    #[error("agent rejected '{command}': {message}")]
    Agent { command: String, message: String },
    #[error("agent process exited")]
    ProcessExited,
    #[error("dispatcher shut down")]
    Closed,
    #[error("io: {0}")]
    Io(String),
}

struct Pending {
    command: String,
    tx: oneshot::Sender<Result<ResponseEnvelope, DispatchError>>,
}

#[derive(Default)]
struct PendingMap {
    /// id -> pending. Insertion order kept separately for the no-id fallback.
    by_id: HashMap<String, Pending>,
    order: Vec<String>,
}

impl PendingMap {
    fn insert(&mut self, id: String, p: Pending) {
        self.order.push(id.clone());
        self.by_id.insert(id, p);
    }

    fn remove(&mut self, id: &str) -> Option<Pending> {
        let p = self.by_id.remove(id);
        if p.is_some() {
            self.order.retain(|x| x != id);
        }
        p
    }

    /// Oldest pending whose command matches — the documented heuristic for
    /// responses that arrive without an id.
    fn remove_oldest_for_command(&mut self, command: &str) -> Option<Pending> {
        let id = self
            .order
            .iter()
            .find(|id| self.by_id.get(*id).is_some_and(|p| p.command == command))?
            .clone();
        self.remove(&id)
    }

    fn drain(&mut self) -> Vec<Pending> {
        self.order.clear();
        self.by_id.drain().map(|(_, p)| p).collect()
    }
}

enum Outbound {
    Line(Vec<u8>),
    Kill,
}

pub struct Dispatcher {
    cmd_tx: mpsc::UnboundedSender<Outbound>,
    pending: Arc<Mutex<PendingMap>>,
    next_id: AtomicU64,
    stderr_tail: Arc<Mutex<Vec<u8>>>,
    exited: Arc<std::sync::atomic::AtomicBool>,
}

impl Dispatcher {
    /// Start the writer + reader tasks. Returns the dispatcher handle and the
    /// stream of everything that is not a correlated response.
    pub fn start(
        child: Box<dyn ChildProcess>,
        output: mpsc::UnboundedReceiver<RawOutput>,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<StreamEnvelope>) {
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let (stream_tx, stream_rx) = mpsc::unbounded_channel();

        let this = Arc::new(Dispatcher {
            cmd_tx,
            pending: Arc::new(Mutex::new(PendingMap::default())),
            next_id: AtomicU64::new(1),
            stderr_tail: Arc::new(Mutex::new(Vec::new())),
            exited: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        });

        tokio::spawn(writer_task(child, cmd_rx));
        tokio::spawn(reader_task(
            output,
            this.pending.clone(),
            this.stderr_tail.clone(),
            this.exited.clone(),
            stream_tx,
        ));

        (this, stream_rx)
    }

    /// Send a command and await its correlated response. `success: false`
    /// resolves to `Err(DispatchError::Agent)`.
    pub async fn request(
        &self,
        command: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<ResponseEnvelope, DispatchError> {
        if self.exited.load(Ordering::SeqCst) {
            return Err(DispatchError::ProcessExited);
        }
        let id = format!("wb-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let line = super::protocol::encode_command(&id, command, params)
            .map_err(|e| DispatchError::Io(e.to_string()))?;

        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(
            id.clone(),
            Pending {
                command: command.to_string(),
                tx,
            },
        );

        if self.cmd_tx.send(Outbound::Line(line)).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(DispatchError::Closed);
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(DispatchError::ProcessExited),
            Err(_) => {
                // Entry removed so a late response becomes an orphan, not a panic.
                self.pending.lock().unwrap().remove(&id);
                Err(DispatchError::Timeout {
                    command: command.to_string(),
                    ms: timeout.as_millis() as u64,
                })
            }
        }
    }

    /// Fire-and-forget line (used for extension_ui_response replies later).
    pub fn send_raw(&self, line: Vec<u8>) -> Result<(), DispatchError> {
        self.cmd_tx
            .send(Outbound::Line(line))
            .map_err(|_| DispatchError::Closed)
    }

    pub fn kill(&self) {
        let _ = self.cmd_tx.send(Outbound::Kill);
    }

    pub fn has_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst)
    }

    /// Redacted stderr tail for diagnostics.
    pub fn stderr_tail(&self) -> String {
        let tail = self.stderr_tail.lock().unwrap();
        crate::secret::redact(&String::from_utf8_lossy(&tail))
    }
}

async fn writer_task(
    mut child: Box<dyn ChildProcess>,
    mut cmd_rx: mpsc::UnboundedReceiver<Outbound>,
) {
    while let Some(msg) = cmd_rx.recv().await {
        match msg {
            Outbound::Line(line) => {
                if let Err(e) = child.write_stdin(&line) {
                    tracing::warn!(error = %e, "agent stdin write failed");
                }
            }
            Outbound::Kill => {
                let _ = child.kill();
            }
        }
    }
    // Handle dropped: dispatcher gone; child is killed on drop where supported.
}

async fn reader_task(
    mut output: mpsc::UnboundedReceiver<RawOutput>,
    pending: Arc<Mutex<PendingMap>>,
    stderr_tail: Arc<Mutex<Vec<u8>>>,
    exited: Arc<std::sync::atomic::AtomicBool>,
    stream_tx: mpsc::UnboundedSender<StreamEnvelope>,
) {
    let mut framer = LineFramer::default();
    let mut seq: u64 = 0;
    let mut emit = |item: StreamItem, seq: &mut u64| {
        *seq += 1;
        let _ = stream_tx.send(StreamEnvelope { seq: *seq, item });
    };

    while let Some(out) = output.recv().await {
        match out {
            RawOutput::Stdout(bytes) => {
                // Collect frames first (framer borrows internally), then handle.
                let mut items: Vec<StreamItem> = Vec::new();
                framer.push(&bytes, |ev| match ev {
                    FrameEvent::Frame(frame) => match parse_frame(frame) {
                        Frame::Response(env) => {
                            let resolved = {
                                let mut map = pending.lock().unwrap();
                                match &env.id {
                                    Some(id) => map.remove(id),
                                    None => map.remove_oldest_for_command(&env.command),
                                }
                            };
                            match resolved {
                                Some(p) => {
                                    let result = if env.success {
                                        Ok(env)
                                    } else {
                                        Err(DispatchError::Agent {
                                            command: p.command.clone(),
                                            message: crate::secret::redact(
                                                env.error.as_deref().unwrap_or("unknown error"),
                                            ),
                                        })
                                    };
                                    let _ = p.tx.send(result);
                                }
                                None => items.push(StreamItem::OrphanResponse(env)),
                            }
                        }
                        Frame::Event(ev) => items.push(StreamItem::Event(ev)),
                        Frame::Unknown { raw_type, raw } => {
                            items.push(StreamItem::Unknown { raw_type, raw })
                        }
                        Frame::ProtocolError { reason, sample } => {
                            items.push(StreamItem::ProtocolError {
                                reason,
                                sample: crate::secret::redact(&sample),
                            })
                        }
                    },
                    FrameEvent::Oversize { dropped_bytes } => {
                        items.push(StreamItem::Oversize { dropped_bytes })
                    }
                });
                for item in items {
                    emit(item, &mut seq);
                }
            }
            RawOutput::Stderr(bytes) => {
                let mut tail = stderr_tail.lock().unwrap();
                tail.extend_from_slice(&bytes);
                if tail.len() > STDERR_TAIL_CAP {
                    let excess = tail.len() - STDERR_TAIL_CAP;
                    tail.drain(..excess);
                }
            }
            RawOutput::Terminated { code, signal } => {
                exited.store(true, Ordering::SeqCst);
                for p in pending.lock().unwrap().drain() {
                    let _ = p.tx.send(Err(DispatchError::ProcessExited));
                }
                emit(StreamItem::ProcessExited { code, signal }, &mut seq);
                break;
            }
        }
    }
}
