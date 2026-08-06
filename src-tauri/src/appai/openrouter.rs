//! OpenRouter client: transcription and the model catalog.
//!
//! Request shapes are pinned to what was verified against the live API:
//! - transcription is a dedicated endpoint, `POST /api/v1/audio/transcriptions`,
//!   with `input_audio: {data, format}` (base64 JSON, not multipart — one code
//!   path and no 25 MB ceiling);
//! - model fallbacks use a top-level `models: [...]` array INSTEAD of `model`,
//!   and the response's `model` field says which one actually ran;
//! - `provider.zdr` and `provider.data_collection` are different things, so
//!   strict privacy sets both, plus `allow_fallbacks: false` — without it
//!   OpenRouter may fall back to a non-ZDR provider and quietly void the
//!   guarantee.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::AppAiError;
use crate::secret::SecretString;

const BASE: &str = "https://openrouter.ai/api/v1";
const TITLE: &str = "Workbench";

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyMode {
    Strict,
    Balanced,
    Off,
}

impl PrivacyMode {
    pub fn parse(s: &str) -> Self {
        match s {
            "balanced" => PrivacyMode::Balanced,
            "off" => PrivacyMode::Off,
            _ => PrivacyMode::Strict,
        }
    }

    fn provider_block(&self) -> Option<serde_json::Value> {
        match self {
            PrivacyMode::Strict => Some(serde_json::json!({
                "zdr": true,
                "data_collection": "deny",
                "allow_fallbacks": false
            })),
            PrivacyMode::Balanced => Some(serde_json::json!({
                "data_collection": "deny",
                "allow_fallbacks": true
            })),
            PrivacyMode::Off => None,
        }
    }
}

/// Build the transcription request body. Separated from the HTTP call so the
/// exact wire shape is unit-testable without a network.
pub fn transcription_body(
    models: &[String],
    wav: &[u8],
    language: Option<&str>,
    privacy: PrivacyMode,
) -> serde_json::Value {
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD.encode(wav);
    let mut body = serde_json::json!({
        "models": models,
        "input_audio": { "data": data, "format": "wav" }
    });
    if let Some(lang) = language {
        body["language"] = serde_json::Value::String(lang.to_string());
    }
    if let Some(provider) = privacy.provider_block() {
        body["provider"] = provider;
    }
    body
}

#[derive(Debug, Deserialize)]
struct TranscriptionResponse {
    text: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    usage: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptResult {
    pub text: String,
    pub model_served: Option<String>,
    pub duration_ms: u64,
    pub usage: Option<serde_json::Value>,
}

fn client(timeout_ms: u64) -> Result<reqwest::Client, AppAiError> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|e| AppAiError::Other(e.to_string()))
}

fn map_reqwest(e: reqwest::Error, timeout_ms: u64) -> AppAiError {
    if e.is_timeout() {
        AppAiError::Timeout(timeout_ms)
    } else if e.is_connect() {
        AppAiError::Offline
    } else {
        AppAiError::Other(crate::secret::redact(&e.to_string()))
    }
}

pub async fn transcribe(
    key: &SecretString,
    models: &[String],
    wav: &[u8],
    language: Option<&str>,
    privacy: PrivacyMode,
    timeout_ms: u64,
) -> Result<TranscriptResult, AppAiError> {
    let started = std::time::Instant::now();
    let body = transcription_body(models, wav, language, privacy);
    let resp = client(timeout_ms)?
        .post(format!("{BASE}/audio/transcriptions"))
        .bearer_auth(key.expose())
        .header("X-OpenRouter-Title", TITLE)
        .json(&body)
        .send()
        .await
        .map_err(|e| map_reqwest(e, timeout_ms))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AppAiError::Http {
            status: status.as_u16(),
            message: crate::secret::redact(&text.chars().take(300).collect::<String>()),
        });
    }
    let parsed: TranscriptionResponse = resp.json().await.map_err(|_| AppAiError::Decode)?;
    Ok(TranscriptResult {
        text: parsed.text,
        // Read back which model actually ran — with a fallback chain it is not
        // necessarily the one requested.
        model_served: parsed.model,
        duration_ms: started.elapsed().as_millis() as u64,
        usage: parsed.usage,
    })
}

// ── model catalog ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ModelsPage {
    data: Vec<RawModel>,
    #[serde(default)]
    total_count: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct RawModel {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    context_length: Option<u32>,
    #[serde(default)]
    architecture: Option<Architecture>,
    /// Sparse map of stringified decimals; keys vary per model. Never a fixed
    /// struct, and a missing key means "not applicable", never zero.
    #[serde(default)]
    pricing: std::collections::HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct Architecture {
    #[serde(default)]
    input_modalities: Vec<String>,
    #[serde(default)]
    output_modalities: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub input_modalities: Vec<String>,
    pub output_modalities: Vec<String>,
    /// `None` when zero — STT models report 0 and the picker must not render
    /// "0 tokens".
    pub context_length: Option<u32>,
    pub price_prompt: Option<String>,
}

fn to_info(m: RawModel) -> ModelInfo {
    let arch = m.architecture.unwrap_or(Architecture {
        input_modalities: vec![],
        output_modalities: vec![],
    });
    ModelInfo {
        name: m.name.unwrap_or_else(|| m.id.clone()),
        id: m.id,
        input_modalities: arch.input_modalities,
        output_modalities: arch.output_modalities,
        context_length: m.context_length.filter(|c| *c > 0),
        price_prompt: m.pricing.get("prompt").cloned(),
    }
}

/// Fetch the full catalog, following pagination. Unauthenticated is fine.
pub async fn fetch_models() -> Result<Vec<ModelInfo>, AppAiError> {
    const LIMIT: u32 = 1000;
    const MAX_PAGES: u32 = 20; // runaway guard
    let http = client(30_000)?;
    let mut out = Vec::new();
    let mut offset = 0u32;

    for _ in 0..MAX_PAGES {
        let page: ModelsPage = http
            .get(format!("{BASE}/models?limit={LIMIT}&offset={offset}"))
            .send()
            .await
            .map_err(|e| map_reqwest(e, 30_000))?
            .json()
            .await
            .map_err(|_| AppAiError::Decode)?;

        let got = page.data.len() as u32;
        out.extend(page.data.into_iter().map(to_info));
        if got < LIMIT {
            break;
        }
        offset += got;
        if let Some(total) = page.total_count {
            if offset >= total {
                break;
            }
        }
    }
    Ok(out)
}

/// Filter by required modalities using SET MEMBERSHIP.
pub fn filter_for(
    models: &[ModelInfo],
    required_input: &[&str],
    required_output: &[&str],
) -> Vec<ModelInfo> {
    models
        .iter()
        .filter(|m| {
            required_input
                .iter()
                .all(|r| m.input_modalities.iter().any(|x| x == r))
                && required_output
                    .iter()
                    .all(|r| m.output_modalities.iter().any(|x| x == r))
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_privacy_sets_zdr_and_data_collection_and_disables_fallbacks() {
        let body = transcription_body(&["a".into()], b"RIFF", None, PrivacyMode::Strict);
        let p = &body["provider"];
        assert_eq!(p["zdr"], true);
        assert_eq!(p["data_collection"], "deny");
        assert_eq!(p["allow_fallbacks"], false);
    }

    #[test]
    fn balanced_privacy_omits_zdr_but_keeps_data_collection() {
        let body = transcription_body(&["a".into()], b"RIFF", None, PrivacyMode::Balanced);
        assert!(body["provider"].get("zdr").is_none());
        assert_eq!(body["provider"]["data_collection"], "deny");
        assert_eq!(body["provider"]["allow_fallbacks"], true);
    }

    #[test]
    fn privacy_off_omits_the_provider_block_entirely() {
        let body = transcription_body(&["a".into()], b"RIFF", None, PrivacyMode::Off);
        assert!(body.get("provider").is_none());
    }

    #[test]
    fn uses_models_array_never_a_model_key() {
        let body = transcription_body(
            &["openai/whisper-1".into(), "openai/gpt-4o-transcribe".into()],
            b"RIFF",
            None,
            PrivacyMode::Strict,
        );
        assert!(body.get("model").is_none(), "singular `model` breaks fallbacks");
        assert_eq!(body["models"][0], "openai/whisper-1");
        assert_eq!(body["models"][1], "openai/gpt-4o-transcribe");
    }

    #[test]
    fn audio_is_base64_with_wav_format() {
        use base64::Engine;
        let wav = b"RIFF\x00\x00\x00\x00WAVE";
        let body = transcription_body(&["a".into()], wav, Some("en"), PrivacyMode::Strict);
        assert_eq!(body["input_audio"]["format"], "wav");
        assert_eq!(body["language"], "en");
        let encoded = body["input_audio"]["data"].as_str().unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        assert_eq!(decoded, wav);
    }

    fn model(id: &str, input: &[&str], output: &[&str], ctx: Option<u32>) -> ModelInfo {
        ModelInfo {
            id: id.into(),
            name: id.into(),
            input_modalities: input.iter().map(|s| s.to_string()).collect(),
            output_modalities: output.iter().map(|s| s.to_string()).collect(),
            context_length: ctx,
            price_prompt: None,
        }
    }

    #[test]
    fn modality_filter_uses_set_membership_not_order() {
        let models = vec![
            // Same modalities, different order — both must match.
            model("stt/a", &["audio"], &["transcription"], None),
            model("stt/b", &["text", "audio"], &["transcription"], None),
            model("chat/x", &["text"], &["text"], Some(128_000)),
            model("audio-chat", &["audio", "text"], &["text"], Some(1_000_000)),
        ];
        let stt = filter_for(&models, &["audio"], &["transcription"]);
        assert_eq!(stt.len(), 2);
        assert!(stt.iter().all(|m| m.id.starts_with("stt/")));
    }

    #[test]
    fn zero_context_length_becomes_none() {
        let raw = RawModel {
            id: "openai/whisper-1".into(),
            name: None,
            context_length: Some(0),
            architecture: Some(Architecture {
                input_modalities: vec!["audio".into()],
                output_modalities: vec!["transcription".into()],
            }),
            pricing: [("prompt".to_string(), "0.006".to_string())]
                .into_iter()
                .collect(),
        };
        let info = to_info(raw);
        assert_eq!(info.context_length, None);
        assert_eq!(info.price_prompt.as_deref(), Some("0.006"));
        assert_eq!(info.name, "openai/whisper-1");
    }

    #[test]
    fn sparse_pricing_map_parses_without_loss() {
        // A free model carries only prompt/completion; others add many keys.
        let json = r#"{"id":"x/free","pricing":{"prompt":"0","completion":"0"},
                       "architecture":{"input_modalities":["text"],"output_modalities":["text"]}}"#;
        let raw: RawModel = serde_json::from_str(json).unwrap();
        let info = to_info(raw);
        assert_eq!(info.price_prompt.as_deref(), Some("0"));
        assert_eq!(info.context_length, None);
    }
}
