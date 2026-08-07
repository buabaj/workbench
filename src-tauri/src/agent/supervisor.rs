//! One prime-agent process per active task. The supervisor owns spawning (from
//! a SpawnPlan), the get_state handshake, stream fan-out with a replay ring
//! (survives frontend remounts/HMR), stop escalation, and status persistence.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::Channel;

use super::child::TokioChild;
use super::config_dir::IsolatedConfigDir;
use super::dispatch::{DispatchError, Dispatcher, StreamEnvelope, StreamItem};
use super::protocol::AgentEvent;
use super::spawn::{EnvValue, SpawnPlan};
use crate::db::now_ms;

const RING_CAP: usize = 2000;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const ABORT_GRACE: Duration = Duration::from_secs(3);

pub type Db = Arc<Mutex<rusqlite::Connection>>;

pub struct RunningTask {
    pub task_id: String,
    pub dispatcher: Arc<Dispatcher>,
    /// Kept alive for the child's lifetime; shredded on drop.
    _config_dir: Option<IsolatedConfigDir>,
    ring: Mutex<VecDeque<Arc<Value>>>,
    subscribers: Mutex<Vec<Channel<Value>>>,
}

impl RunningTask {
    fn publish(&self, envelope: Arc<Value>) {
        {
            let mut ring = self.ring.lock().unwrap();
            if ring.len() >= RING_CAP {
                ring.pop_front();
            }
            ring.push_back(envelope.clone());
        }
        let mut subs = self.subscribers.lock().unwrap();
        subs.retain(|ch| ch.send((*envelope).clone()).is_ok());
    }

    pub fn subscribe(&self, from_seq: u64, channel: Channel<Value>) {
        // Replay the tail first, then attach for live delivery.
        let ring = self.ring.lock().unwrap();
        for env in ring.iter() {
            let seq = env.get("seq").and_then(|s| s.as_u64()).unwrap_or(0);
            if seq > from_seq {
                let _ = channel.send((**env).clone());
            }
        }
        drop(ring);
        self.subscribers.lock().unwrap().push(channel);
    }
}

#[derive(Default)]
pub struct Supervisor {
    tasks: RwLock<HashMap<String, Arc<RunningTask>>>,
}

#[derive(Debug, thiserror::Error)]
pub enum SupervisorError {
    #[error("spawn failed: {0}")]
    Spawn(String),
    #[error("agent did not become ready: {0}")]
    Handshake(String),
    #[error("task not found or not running")]
    NotRunning,
    #[error("{0}")]
    Dispatch(#[from] DispatchError),
}

pub struct StartOutcome {
    pub session_id: Option<String>,
    pub session_path: Option<String>,
    /// What the agent will actually use — resolved, not requested.
    pub model: Option<String>,
}

/// Model ids reported by `get_available_models`, for a provider.
fn models_for(data: &Value, provider: &str) -> Vec<String> {
    data.get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|m| m.get("provider").and_then(|p| p.as_str()) == Some(provider))
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

impl Supervisor {
    pub fn get(&self, task_id: &str) -> Option<Arc<RunningTask>> {
        self.tasks.read().unwrap().get(task_id).cloned()
    }

    /// Spawn the child, handshake, register, and start the forwarder.
    /// Returns session identity from get_state. Takes `Arc<Self>` so the
    /// forwarder can deregister the task when its stream ends.
    pub async fn start(
        self: &Arc<Self>,
        db: Db,
        task_id: String,
        plan: SpawnPlan,
        cwd: &std::path::Path,
        // Existing session file to reattach to, if this is a resume.
        resume_session: Option<String>,
        channel: Channel<Value>,
    ) -> Result<StartOutcome, SupervisorError> {
        // Resume is a spawn-time concern, not a post-handshake one. Sending
        // `switch_session` to an already-started agent is rejected outright
        // ("Session is already active"), because the agent takes a lease on
        // the fresh session it just opened. `--resume` boots straight into the
        // saved session instead — verified end to end against a live agent.
        let mut plan = plan;
        if let Some(path) = &resume_session {
            // Clear the previous run's lease if its owner died without
            // releasing it, or the agent exits during startup and the
            // conversation appears to be unresumable forever.
            let leases = plan
                .config_dir
                .as_ref()
                .map(|d| d.agent_dir().join("session-leases"))
                .unwrap_or_else(|| {
                    super::oauth_discovery::prime_home()
                        .join("agent")
                        .join("session-leases")
                });
            // Safe to evict: `agent_resume_task` only reaches spawn when this
            // task has no agent registered, so any holder is a leftover from a
            // previous run that outlived its kill.
            super::lease::reclaim(
                &leases,
                std::path::Path::new(path),
                super::lease::OnLiveOwner::Evict,
            );

            plan.args.push("--resume".into());
            plan.args.push(path.clone());
        }

        let mut cmd = tokio::process::Command::new(&plan.program);
        cmd.args(&plan.args).current_dir(cwd).env_clear();
        for (k, v) in &plan.env_set {
            match v {
                EnvValue::Plain(p) => {
                    cmd.env(k, p);
                }
                EnvValue::Secret(s) => {
                    cmd.env(k, s.expose());
                }
            }
        }
        // env_clear makes env_remove redundant, but belt and braces:
        for k in &plan.env_remove {
            cmd.env_remove(k);
        }

        let (child, output) =
            TokioChild::spawn(cmd).map_err(|e| SupervisorError::Spawn(e.to_string()))?;
        let (dispatcher, stream) = Dispatcher::start(Box::new(child), output);

        // Handshake: the first get_state may pay kernel bootstrap.
        let state = dispatcher
            .request("get_state", json!({}), HANDSHAKE_TIMEOUT)
            .await
            .map_err(|e| {
                let tail = dispatcher.stderr_tail();
                dispatcher.kill();
                SupervisorError::Handshake(format!("{e} — stderr: {tail}"))
            })?;
        let data = state.data.unwrap_or(Value::Null);
        let session_id = data
            .get("sessionId")
            .and_then(|v| v.as_str())
            .map(String::from);
        let session_path = data
            .get("sessionFile")
            .and_then(|v| v.as_str())
            .map(String::from);

        // If the profile named no model, pick one belonging to the SELECTED
        // provider rather than inheriting whatever default is lying around —
        // that inheritance is what silently routed work to another provider.
        let mut model = plan.model_id.clone();
        if model.is_none() {
            if let Some(provider) = &plan.provider_slug {
                if let Ok(list) = dispatcher
                    .request("get_available_models", json!({}), Duration::from_secs(20))
                    .await
                {
                    let candidates = models_for(&list.data.unwrap_or(Value::Null), provider);
                    if let Some(first) = candidates.first() {
                        // Params are `provider` + `modelId`, NOT `model` —
                        // verified against the live RPC, which rejects the
                        // latter with "Model not found: undefined/undefined".
                        match dispatcher
                            .request(
                                "set_model",
                                json!({ "provider": provider, "modelId": first }),
                                Duration::from_secs(15),
                            )
                            .await
                        {
                            Ok(_) => {
                                model = Some(first.clone());
                                tracing::info!(provider, model = %first, "pinned model for provider");
                            }
                            Err(e) => tracing::warn!(provider, error = %e, "set_model failed"),
                        }
                    } else {
                        tracing::warn!(provider, "provider reports no available models");
                    }
                }
            }
        }

        let running = Arc::new(RunningTask {
            task_id: task_id.clone(),
            dispatcher: dispatcher.clone(),
            _config_dir: plan.config_dir,
            ring: Mutex::new(VecDeque::new()),
            subscribers: Mutex::new(vec![channel]),
        });
        self.tasks
            .write()
            .unwrap()
            .insert(task_id.clone(), running.clone());

        tokio::spawn(forwarder(
            self.clone(),
            db,
            task_id,
            running.clone(),
            stream,
        ));

        Ok(StartOutcome {
            session_id,
            session_path,
            model,
        })
    }

    /// Two different intentions, not two intensities.
    ///
    /// `force == false` means "stop this turn": send `abort` and leave the
    /// agent running, so the conversation can continue. `force == true` means
    /// "end this session": wind the agent down for good.
    ///
    /// Ending never uses a bare kill. prime-agent leaves our process group, so
    /// a kill orphans it — still running, still holding the session lease that
    /// its own conversation needs to resume. `shutdown` closes stdin first and
    /// escalates to SIGTERM/SIGKILL only if that is ignored.
    pub async fn stop(&self, task_id: &str, force: bool) -> Result<(), SupervisorError> {
        let running = self.get(task_id).ok_or(SupervisorError::NotRunning)?;
        if !force {
            let aborted = running
                .dispatcher
                .request("abort", json!({}), ABORT_GRACE)
                .await;
            if aborted.is_ok() {
                return Ok(());
            }
        }
        running.dispatcher.shutdown();
        Ok(())
    }

    /// Send a conversational command (prompt/steer/follow_up) to a running task.
    pub async fn send(
        &self,
        task_id: &str,
        command: &str,
        message: String,
    ) -> Result<(), SupervisorError> {
        let running = self.get(task_id).ok_or(SupervisorError::NotRunning)?;
        running
            .dispatcher
            .request(command, json!({ "message": message }), Duration::from_secs(15))
            .await?;
        Ok(())
    }

    pub fn subscribe(
        &self,
        task_id: &str,
        from_seq: u64,
        channel: Channel<Value>,
    ) -> Result<(), SupervisorError> {
        let running = self.get(task_id).ok_or(SupervisorError::NotRunning)?;
        running.subscribe(from_seq, channel);
        Ok(())
    }

    /// Kill everything — app exit. Best-effort, bounded by kill_on_drop.
    /// Wind every agent down on the way out, and wait for them.
    ///
    /// Killing is not enough and never was: prime-agent detaches from our
    /// process group, so neither `kill_on_drop` nor a group kill reaches it —
    /// measured, a killed agent and its Python kernel keep running and keep
    /// holding the session lease. Closing stdin is what actually stops it, so
    /// exit blocks briefly to let that finish rather than leaking a process
    /// pair per conversation.
    pub fn shutdown_all(&self, budget: Duration) {
        let dispatchers: Vec<_> = self
            .tasks
            .read()
            .unwrap()
            .values()
            .map(|t| t.dispatcher.clone())
            .collect();
        if dispatchers.is_empty() {
            return;
        }
        for d in &dispatchers {
            d.shutdown();
        }
        let deadline = std::time::Instant::now() + budget;
        while std::time::Instant::now() < deadline {
            if dispatchers.iter().all(|d| d.has_exited()) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let stuck = dispatchers.iter().filter(|d| !d.has_exited()).count();
        if stuck > 0 {
            tracing::warn!(stuck, "agents still running at exit; leases will be reclaimed on resume");
        }
        self.tasks.write().unwrap().clear();
    }

    pub fn kill_all(&self) {
        for (_, t) in self.tasks.read().unwrap().iter() {
            t.dispatcher.kill();
        }
        self.tasks.write().unwrap().clear();
    }

    fn remove(&self, task_id: &str) {
        self.tasks.write().unwrap().remove(task_id);
    }
}

/// Per-task forwarder: dispatcher stream → envelope JSON → ring + subscribers,
/// with terminal status persisted to SQLite and deregistration on stream end.
async fn forwarder(
    sup: Arc<Supervisor>,
    db: Db,
    task_id: String,
    running: Arc<RunningTask>,
    mut stream: tokio::sync::mpsc::UnboundedReceiver<StreamEnvelope>,
) {
    let mut saw_agent_end = false;
    while let Some(env) = stream.recv().await {
        let terminal: Option<(&str, Option<String>)> = match &env.item {
            StreamItem::Event(AgentEvent::AgentEnd { .. }) => {
                saw_agent_end = true;
                None
            }
            StreamItem::ProcessExited { code, signal } => {
                if saw_agent_end || (*code == Some(0) && signal.is_none()) {
                    Some(("succeeded", None))
                } else {
                    Some((
                        "failed",
                        Some(crate::secret::redact(&format!(
                            "agent exited (code {code:?}, signal {signal:?}) — {}",
                            running.dispatcher.stderr_tail()
                        ))),
                    ))
                }
            }
            _ => None,
        };

        let value = serde_json::to_value(&env).unwrap_or(Value::Null);
        let wrapped = json!({
            "taskId": task_id,
            "seq": env.seq,
            "item": value.get("item").cloned().unwrap_or(Value::Null),
        });
        running.publish(Arc::new(wrapped));

        if let Some((status, error)) = terminal {
            let conn = db.lock().unwrap();
            let _ = conn.execute(
                "UPDATE tasks SET status = ?1, error_text = ?2, ended_at = ?3 WHERE id = ?4",
                rusqlite::params![status, error, now_ms(), task_id],
            );
        } else if matches!(&env.item, StreamItem::Event(AgentEvent::AgentStart)) {
            let conn = db.lock().unwrap();
            let _ = conn.execute(
                "UPDATE tasks SET status = 'running', started_at = ?1 WHERE id = ?2",
                rusqlite::params![now_ms(), task_id],
            );
        }
    }
    // Stream closed: the process is gone. Deregister (drops config dir, and the
    // dispatcher's writer drops the child → kill_on_drop backstop).
    // If no ProcessExited was ever seen (rare), mark cancelled-ish failure.
    {
        let conn = db.lock().unwrap();
        let _ = conn.execute(
            "UPDATE tasks SET status = CASE WHEN status IN ('starting','running')
                                            THEN 'failed' ELSE status END,
                              ended_at = COALESCE(ended_at, ?1)
             WHERE id = ?2",
            rusqlite::params![now_ms(), task_id],
        );
    }
    // Deregister: drops the config dir, and the dispatcher's writer drops the
    // child (kill_on_drop backstop).
    sup.remove(&task_id);
    drop(running);
}
