//! End-to-end: real OS process (fake-agent bin) through TokioChild + Dispatcher.

use std::time::Duration;

use workbench_lib::agent::child::TokioChild;
use workbench_lib::agent::dispatch::{DispatchError, Dispatcher, StreamItem};
use workbench_lib::agent::protocol::AgentEvent;
use serde_json::json;

fn fake_agent_cmd() -> tokio::process::Command {
    tokio::process::Command::new(env!("CARGO_BIN_EXE_fake-agent"))
}

#[tokio::test]
async fn get_state_roundtrip_over_real_process() {
    let (child, output) = TokioChild::spawn(fake_agent_cmd()).unwrap();
    let (d, _stream) = Dispatcher::start(Box::new(child), output);

    let res = d
        .request("get_state", json!({}), Duration::from_secs(5))
        .await
        .unwrap();
    assert!(res.success);
    assert_eq!(res.data.as_ref().unwrap()["sessionId"], "fake-session");
}

#[tokio::test]
async fn prompt_streams_full_event_sequence() {
    let mut cmd = fake_agent_cmd();
    cmd.env("FAKE_SPLIT_WRITES", "3"); // reassembly under tiny writes
    let (child, output) = TokioChild::spawn(cmd).unwrap();
    let (d, mut stream) = Dispatcher::start(Box::new(child), output);

    let ack = d
        .request("prompt", json!({"message": "hello"}), Duration::from_secs(5))
        .await
        .unwrap();
    assert!(ack.success);

    let mut kinds = Vec::new();
    while let Ok(Some(env)) =
        tokio::time::timeout(Duration::from_secs(5), stream.recv()).await
    {
        match &env.item {
            StreamItem::Event(AgentEvent::AgentStart) => kinds.push("start"),
            StreamItem::Event(AgentEvent::MessageUpdate { .. }) => kinds.push("update"),
            StreamItem::Event(AgentEvent::ToolExecutionStart { .. }) => kinds.push("tool_start"),
            StreamItem::Event(AgentEvent::ToolExecutionEnd { .. }) => kinds.push("tool_end"),
            StreamItem::Event(AgentEvent::AgentEnd { .. }) => {
                kinds.push("end");
                break;
            }
            _ => {}
        }
    }
    assert_eq!(kinds[0], "start");
    assert_eq!(kinds.iter().filter(|k| **k == "update").count(), 5);
    assert!(kinds.contains(&"tool_start"));
    assert!(kinds.contains(&"tool_end"));
    assert_eq!(*kinds.last().unwrap(), "end");
}

#[tokio::test]
async fn crash_mid_stream_fails_pending_with_stderr_available() {
    let mut cmd = fake_agent_cmd();
    cmd.env("FAKE_EXIT_AFTER_MS", "50")
        .env("FAKE_IGNORE_ABORT", "1")
        .env("FAKE_STDERR", "ENOENT: kernel python not found");
    let (child, output) = TokioChild::spawn(cmd).unwrap();
    let (d, mut stream) = Dispatcher::start(Box::new(child), output);

    // This request will never be answered: the child dies first.
    let res = d
        .request("abort", json!({}), Duration::from_secs(5))
        .await;
    assert!(
        matches!(res, Err(DispatchError::ProcessExited)),
        "expected ProcessExited, got {res:?}"
    );

    // Exit event lands in the stream; stderr tail captured the diagnosis.
    let mut saw_exit = false;
    while let Ok(Some(env)) =
        tokio::time::timeout(Duration::from_millis(500), stream.recv()).await
    {
        if matches!(env.item, StreamItem::ProcessExited { .. }) {
            saw_exit = true;
            break;
        }
    }
    assert!(saw_exit);
    assert!(d.stderr_tail().contains("kernel python not found"));
}
