//! Wire types for prime-agent's RPC protocol, with forward-compatible parsing.
//!
//! Payload-shaped fields stay `serde_json::Value` deliberately: rendering
//! decisions belong to the frontend, and upstream shape churn must not break
//! this layer. `assistantMessageEvent`'s internal discriminants are unverified
//! upstream — it is a passthrough (TIGHTEN-LATER, single site in TS `normalize`).
//!
//! Parsing degrades, never dies: unknown `type` or a shape change in a known
//! type → `Frame::Unknown`; invalid JSON → `Frame::ProtocolError`. Neither ends
//! the stream.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResponseEnvelope {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub command: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    AgentStart,
    AgentEnd {
        #[serde(default)]
        messages: Value,
    },
    TurnStart,
    TurnEnd {
        #[serde(default)]
        message: Value,
        #[serde(default, rename = "toolResults")]
        tool_results: Value,
    },
    MessageStart {
        #[serde(default)]
        message: Value,
    },
    MessageUpdate {
        #[serde(default)]
        message: Value,
        #[serde(default, rename = "assistantMessageEvent")]
        assistant_message_event: Value,
    },
    MessageEnd {
        #[serde(default)]
        message: Value,
    },
    ToolExecutionStart {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(default)]
        args: Value,
    },
    ToolExecutionUpdate {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(default)]
        args: Value,
        #[serde(default, rename = "partialResult")]
        partial_result: Value,
    },
    ToolExecutionEnd {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(default)]
        result: Value,
        #[serde(default, rename = "isError")]
        is_error: bool,
    },
    SessionActionUpdate {
        #[serde(default)]
        actions: Value,
    },
    CompactionStart {
        #[serde(default)]
        reason: String,
    },
    CompactionEnd {
        #[serde(default)]
        reason: String,
        #[serde(default)]
        result: Value,
        #[serde(default)]
        aborted: bool,
        #[serde(default, rename = "willRetry")]
        will_retry: bool,
    },
    AutoRetryStart {
        #[serde(default)]
        attempt: u32,
        #[serde(default, rename = "maxAttempts")]
        max_attempts: u32,
        #[serde(default, rename = "delayMs")]
        delay_ms: u64,
        #[serde(default, rename = "errorMessage")]
        error_message: Option<String>,
    },
    AutoRetryEnd {
        #[serde(default)]
        success: bool,
        #[serde(default)]
        attempt: u32,
        #[serde(default, rename = "finalError")]
        final_error: Option<String>,
    },
    ExtensionError {
        #[serde(default, rename = "extensionPath")]
        extension_path: String,
        #[serde(default)]
        event: String,
        #[serde(default)]
        error: String,
    },
    /// Extension UI protocol (the future approval channel). Passthrough for now.
    ExtensionUiRequest {
        #[serde(default)]
        id: String,
        #[serde(default)]
        method: String,
        #[serde(flatten)]
        rest: Value,
    },
}

/// Result of parsing one frame.
#[derive(Debug, PartialEq)]
pub enum Frame {
    Response(ResponseEnvelope),
    Event(AgentEvent),
    /// Valid JSON, but an unrecognized `type` or a shape we couldn't match.
    /// The payload is preserved verbatim.
    Unknown { raw_type: String, raw: Value },
    /// Not valid JSON. Diagnostic only; the stream continues.
    ProtocolError { reason: String, sample: String },
}

pub fn parse_frame(bytes: &[u8]) -> Frame {
    let value: Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(e) => {
            let sample: String = String::from_utf8_lossy(bytes).chars().take(512).collect();
            return Frame::ProtocolError {
                reason: e.to_string(),
                sample,
            };
        }
    };
    let raw_type = value
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();

    if raw_type == "response" {
        match serde_json::from_value::<ResponseEnvelope>(value.clone()) {
            Ok(env) => Frame::Response(env),
            Err(_) => Frame::Unknown { raw_type, raw: value },
        }
    } else {
        match serde_json::from_value::<AgentEvent>(value.clone()) {
            Ok(ev) => Frame::Event(ev),
            Err(_) => Frame::Unknown { raw_type, raw: value },
        }
    }
}

/// Serialize an outbound command as one JSONL record (trailing `\n` included).
/// `params` must be an object (or Null for none). serde_json escapes all control
/// characters, so the record can never contain an interior raw LF — asserted in
/// tests rather than trusted.
pub fn encode_command(
    id: &str,
    command: &str,
    params: Value,
) -> Result<Vec<u8>, serde_json::Error> {
    let mut obj = match params {
        Value::Object(m) => m,
        Value::Null => serde_json::Map::new(),
        other => {
            let mut m = serde_json::Map::new();
            m.insert("params".into(), other);
            m
        }
    };
    obj.insert("id".into(), Value::String(id.to_string()));
    obj.insert("type".into(), Value::String(command.to_string()));
    let mut line = serde_json::to_vec(&Value::Object(obj))?;
    line.push(b'\n');
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn golden_capture_parses_as_successful_responses() {
        let golden = include_str!("../../tests/golden/rpc-responses.jsonl");
        let mut count = 0;
        for line in golden.lines().filter(|l| !l.trim().is_empty()) {
            match parse_frame(line.as_bytes()) {
                Frame::Response(env) => {
                    assert!(env.success, "golden response not success: {}", env.command);
                    assert!(env.id.is_some());
                    count += 1;
                }
                other => panic!("golden line did not parse as Response: {other:?}"),
            }
        }
        assert!(count >= 3, "expected at least 3 golden responses, got {count}");
    }

    #[test]
    fn known_event_parses() {
        let f = parse_frame(
            br#"{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":{"ok":true},"isError":false}"#,
        );
        match f {
            Frame::Event(AgentEvent::ToolExecutionEnd {
                tool_call_id,
                tool_name,
                is_error,
                ..
            }) => {
                assert_eq!(tool_call_id, "t1");
                assert_eq!(tool_name, "bash");
                assert!(!is_error);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn unknown_type_degrades_with_payload_preserved() {
        let f = parse_frame(br#"{"type":"brand_new_event","payload":{"x":1}}"#);
        match f {
            Frame::Unknown { raw_type, raw } => {
                assert_eq!(raw_type, "brand_new_event");
                assert_eq!(raw["payload"]["x"], 1);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn known_type_with_extra_fields_still_parses() {
        let f = parse_frame(br#"{"type":"agent_start","newField":"added upstream"}"#);
        assert_eq!(f, Frame::Event(AgentEvent::AgentStart));
    }

    #[test]
    fn known_type_with_wrong_shape_degrades_not_dies() {
        // tool_execution_start requires toolCallId — its absence must degrade.
        let f = parse_frame(br#"{"type":"tool_execution_start","totally":"different"}"#);
        match f {
            Frame::Unknown { raw_type, .. } => assert_eq!(raw_type, "tool_execution_start"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn malformed_json_is_protocol_error() {
        let f = parse_frame(b"{not json");
        match f {
            Frame::ProtocolError { sample, .. } => assert!(sample.contains("{not json")),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn failed_response_carries_error() {
        let f = parse_frame(
            br#"{"type":"response","command":"set_model","success":false,"error":"Model not found"}"#,
        );
        match f {
            Frame::Response(env) => {
                assert!(!env.success);
                assert_eq!(env.error.as_deref(), Some("Model not found"));
                assert!(env.id.is_none());
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn encode_command_never_contains_interior_lf() {
        let nasty = "line1\nline2\rline3\u{2028}line4 🦀";
        let line = encode_command("wb-1", "prompt", json!({ "message": nasty })).unwrap();
        let interior = &line[..line.len() - 1];
        assert!(!interior.contains(&b'\n'), "interior LF leaked into record");
        assert_eq!(*line.last().unwrap(), b'\n');
        // and it round-trips
        let v: Value = serde_json::from_slice(interior).unwrap();
        assert_eq!(v["message"], nasty);
        assert_eq!(v["id"], "wb-1");
        assert_eq!(v["type"], "prompt");
    }
}
