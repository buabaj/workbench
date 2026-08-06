//! Scriptable fake prime-agent for tests: speaks the JSONL RPC protocol on
//! stdin/stdout. Behavior toggles via env vars:
//! - FAKE_IGNORE_ABORT=1     abort commands get no response (tests kill escalation)
//! - FAKE_EXIT_AFTER_MS=n    exit(1) n ms after startup (tests crash mid-stream)
//! - FAKE_SPLIT_WRITES=n     write output in n-byte flushes (tests reassembly)
//! - FAKE_STDERR=msg         print msg to stderr at startup

use std::io::{BufRead, Write};

fn emit(split: usize, line: &str) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let bytes = format!("{line}\n").into_bytes();
    if split == 0 {
        out.write_all(&bytes).unwrap();
    } else {
        for chunk in bytes.chunks(split) {
            out.write_all(chunk).unwrap();
            out.flush().unwrap();
        }
    }
    out.flush().unwrap();
}

fn main() {
    let ignore_abort = std::env::var("FAKE_IGNORE_ABORT").is_ok();
    let split: usize = std::env::var("FAKE_SPLIT_WRITES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    if let Ok(msg) = std::env::var("FAKE_STDERR") {
        eprintln!("{msg}");
    }
    if let Ok(ms) = std::env::var("FAKE_EXIT_AFTER_MS") {
        let ms: u64 = ms.parse().unwrap_or(100);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(ms));
            std::process::exit(1);
        });
    }

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let id = v.get("id").and_then(|i| i.as_str()).unwrap_or("");
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "get_state" => emit(
                split,
                &format!(
                    r#"{{"id":"{id}","type":"response","command":"get_state","success":true,"data":{{"model":{{"id":"fake-model"}},"thinkingLevel":"medium","isStreaming":false,"sessionId":"fake-session","messageCount":0}}}}"#
                ),
            ),
            "prompt" => {
                emit(
                    split,
                    &format!(
                        r#"{{"id":"{id}","type":"response","command":"prompt","success":true}}"#
                    ),
                );
                emit(split, r#"{"type":"agent_start"}"#);
                emit(split, r#"{"type":"turn_start"}"#);
                for i in 0..5 {
                    emit(
                        split,
                        &format!(
                            r#"{{"type":"message_update","message":{{}},"assistantMessageEvent":{{"kind":"text_delta","delta":"chunk-{i} "}}}}"#
                        ),
                    );
                }
                emit(
                    split,
                    r#"{"type":"tool_execution_start","toolCallId":"t1","toolName":"read_file","args":{"path":"x.rs"}}"#,
                );
                emit(
                    split,
                    r#"{"type":"tool_execution_end","toolCallId":"t1","toolName":"read_file","result":{"ok":true},"isError":false}"#,
                );
                emit(split, r#"{"type":"turn_end","message":{},"toolResults":[]}"#);
                emit(split, r#"{"type":"agent_end","messages":[]}"#);
            }
            "abort" if ignore_abort => { /* swallow: tests kill escalation */ }
            "abort" => emit(
                split,
                &format!(r#"{{"id":"{id}","type":"response","command":"abort","success":true}}"#),
            ),
            "bad_command" => emit(
                split,
                &format!(
                    r#"{{"id":"{id}","type":"response","command":"bad_command","success":false,"error":"Unknown command"}}"#
                ),
            ),
            _ => emit(
                split,
                &format!(
                    r#"{{"id":"{id}","type":"response","command":"{ty}","success":true,"data":{{}}}}"#
                ),
            ),
        }
    }
}
