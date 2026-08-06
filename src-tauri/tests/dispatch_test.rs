//! Dispatcher tests against MockChild — no OS process, no Tauri app.

use std::time::Duration;

use prime_workbench_lib::agent::child::{MockChild, RawOutput};
use prime_workbench_lib::agent::dispatch::{DispatchError, Dispatcher, StreamItem};
use serde_json::json;

/// Poll MockChild's recorded stdin until `n` lines have been written.
async fn wait_for_stdin(
    stdin: &std::sync::Arc<std::sync::Mutex<Vec<Vec<u8>>>>,
    n: usize,
) -> Vec<serde_json::Value> {
    for _ in 0..200 {
        {
            let lines = stdin.lock().unwrap();
            if lines.len() >= n {
                return lines
                    .iter()
                    .map(|l| serde_json::from_slice(&l[..l.len() - 1]).unwrap())
                    .collect();
            }
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("stdin never received {n} lines");
}

fn response(id: &str, command: &str, success: bool) -> RawOutput {
    RawOutput::Stdout(
        format!(
            "{}\n",
            json!({"id": id, "type": "response", "command": command, "success": success,
                   "error": if success { serde_json::Value::Null } else { json!("boom") }})
        )
        .into_bytes(),
    )
}

#[tokio::test]
async fn out_of_order_responses_resolve_correct_callers() {
    let (child, out_tx, out_rx, stdin) = MockChild::new();
    let (d, _stream) = Dispatcher::start(Box::new(child), out_rx);

    let d1 = d.clone();
    let a = tokio::spawn(async move {
        d1.request("get_state", json!({}), Duration::from_secs(2)).await
    });
    let d2 = d.clone();
    let b = tokio::spawn(async move {
        d2.request("get_messages", json!({}), Duration::from_secs(2)).await
    });

    let sent = wait_for_stdin(&stdin, 2).await;
    let (id_state, id_msgs) = if sent[0]["type"] == "get_state" {
        (sent[0]["id"].as_str().unwrap(), sent[1]["id"].as_str().unwrap())
    } else {
        (sent[1]["id"].as_str().unwrap(), sent[0]["id"].as_str().unwrap())
    };

    // Respond in REVERSE order.
    out_tx.send(response(id_msgs, "get_messages", true)).unwrap();
    out_tx.send(response(id_state, "get_state", true)).unwrap();

    let ra = a.await.unwrap().unwrap();
    let rb = b.await.unwrap().unwrap();
    assert_eq!(ra.command, "get_state");
    assert_eq!(rb.command, "get_messages");
}

#[tokio::test]
async fn orphan_and_duplicate_responses_never_panic() {
    let (child, out_tx, out_rx, stdin) = MockChild::new();
    let (d, mut stream) = Dispatcher::start(Box::new(child), out_rx);

    // Orphan: response for an id nobody asked for.
    out_tx.send(response("wb-999", "get_state", true)).unwrap();
    let env = stream.recv().await.unwrap();
    assert!(matches!(env.item, StreamItem::OrphanResponse(_)));

    // Real request, then duplicate response.
    let d1 = d.clone();
    let task = tokio::spawn(async move {
        d1.request("get_state", json!({}), Duration::from_secs(2)).await
    });
    let sent = wait_for_stdin(&stdin, 1).await;
    let id = sent[0]["id"].as_str().unwrap().to_string();
    out_tx.send(response(&id, "get_state", true)).unwrap();
    out_tx.send(response(&id, "get_state", true)).unwrap(); // duplicate

    assert!(task.await.unwrap().is_ok());
    let env = stream.recv().await.unwrap();
    assert!(
        matches!(env.item, StreamItem::OrphanResponse(_)),
        "duplicate must become an orphan"
    );
}

#[tokio::test]
async fn failed_response_maps_to_agent_error() {
    let (child, out_tx, out_rx, stdin) = MockChild::new();
    let (d, _stream) = Dispatcher::start(Box::new(child), out_rx);

    let d1 = d.clone();
    let task = tokio::spawn(async move {
        d1.request("set_model", json!({"model": "nope"}), Duration::from_secs(2)).await
    });
    let sent = wait_for_stdin(&stdin, 1).await;
    let id = sent[0]["id"].as_str().unwrap().to_string();
    out_tx.send(response(&id, "set_model", false)).unwrap();

    match task.await.unwrap() {
        Err(DispatchError::Agent { command, message }) => {
            assert_eq!(command, "set_model");
            assert_eq!(message, "boom");
        }
        other => panic!("unexpected: {other:?}"),
    }
}

#[tokio::test]
async fn timeout_removes_pending_and_late_response_is_orphaned() {
    let (child, out_tx, out_rx, stdin) = MockChild::new();
    let (d, mut stream) = Dispatcher::start(Box::new(child), out_rx);

    let result = d
        .request("get_state", json!({}), Duration::from_millis(50))
        .await;
    assert!(matches!(result, Err(DispatchError::Timeout { .. })));

    // Late response arrives after the timeout: orphan, not a panic.
    let sent = wait_for_stdin(&stdin, 1).await;
    let id = sent[0]["id"].as_str().unwrap().to_string();
    out_tx.send(response(&id, "get_state", true)).unwrap();
    let env = stream.recv().await.unwrap();
    assert!(matches!(env.item, StreamItem::OrphanResponse(_)));
}

#[tokio::test]
async fn idless_response_resolves_oldest_matching_command() {
    let (child, out_tx, out_rx, stdin) = MockChild::new();
    let (d, _stream) = Dispatcher::start(Box::new(child), out_rx);

    let d1 = d.clone();
    let task = tokio::spawn(async move {
        d1.request("compact", json!({}), Duration::from_secs(2)).await
    });
    wait_for_stdin(&stdin, 1).await;

    // Response with NO id, matching command.
    out_tx
        .send(RawOutput::Stdout(
            b"{\"type\":\"response\",\"command\":\"compact\",\"success\":true}\n".to_vec(),
        ))
        .unwrap();
    let res = task.await.unwrap().unwrap();
    assert_eq!(res.command, "compact");
    assert!(res.id.is_none());
}

#[tokio::test]
async fn termination_fails_all_pending_and_emits_exit() {
    let (child, out_tx, out_rx, _stdin) = MockChild::new();
    let (d, mut stream) = Dispatcher::start(Box::new(child), out_rx);

    let d1 = d.clone();
    let task = tokio::spawn(async move {
        d1.request("prompt", json!({"message": "hi"}), Duration::from_secs(5)).await
    });
    tokio::time::sleep(Duration::from_millis(20)).await;

    out_tx
        .send(RawOutput::Terminated { code: Some(1), signal: None })
        .unwrap();

    match task.await.unwrap() {
        Err(DispatchError::ProcessExited) => {}
        other => panic!("unexpected: {other:?}"),
    }
    // The exit lands in the stream too.
    let mut saw_exit = false;
    while let Ok(env) = tokio::time::timeout(Duration::from_millis(200), stream.recv()).await {
        if let Some(env) = env {
            if matches!(env.item, StreamItem::ProcessExited { code: Some(1), .. }) {
                saw_exit = true;
                break;
            }
        } else {
            break;
        }
    }
    assert!(saw_exit);
    assert!(d.has_exited());
    // New requests are refused immediately.
    let r = d.request("get_state", json!({}), Duration::from_secs(1)).await;
    assert!(matches!(r, Err(DispatchError::ProcessExited)));
}

#[tokio::test]
async fn flood_of_events_arrives_in_order_with_monotonic_seq() {
    let (child, out_tx, out_rx, _stdin) = MockChild::new();
    let (_d, mut stream) = Dispatcher::start(Box::new(child), out_rx);

    const N: usize = 10_000;
    for i in 0..N {
        out_tx
            .send(RawOutput::Stdout(
                format!(
                    "{{\"type\":\"message_update\",\"message\":{{}},\"assistantMessageEvent\":{{\"i\":{i}}}}}\n"
                )
                .into_bytes(),
            ))
            .unwrap();
    }

    let mut last_seq = 0;
    let mut count = 0;
    while count < N {
        let env = tokio::time::timeout(Duration::from_secs(5), stream.recv())
            .await
            .expect("stream stalled")
            .expect("stream closed");
        assert!(env.seq > last_seq, "seq not monotonic");
        last_seq = env.seq;
        count += 1;
    }
    assert_eq!(count, N);
}

#[tokio::test]
async fn stderr_accumulates_and_is_redacted() {
    let (child, out_tx, out_rx, _stdin) = MockChild::new();
    let (d, _stream) = Dispatcher::start(Box::new(child), out_rx);

    out_tx
        .send(RawOutput::Stderr(
            b"auth failed for key sk-ant-secret123456789 retrying".to_vec(),
        ))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;

    let tail = d.stderr_tail();
    assert!(tail.contains("auth failed"));
    assert!(!tail.contains("secret123456789"), "stderr tail leaked a key");
}
