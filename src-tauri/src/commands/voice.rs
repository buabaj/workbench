//! Voice commands. Audio never reaches SQLite, never reaches a log, and the
//! temp file is gone before the network call happens.

use rusqlite::OptionalExtension;
use tauri::State;

use crate::appai::{openrouter, profile, registry, AppAiError};
use crate::error::AppError;
use crate::voice::session::{PushAck, VoiceError, VoiceState};
use crate::AppState;

impl From<VoiceError> for AppError {
    fn from(e: VoiceError) -> Self {
        match e {
            VoiceError::NoSession => AppError::NotFound("recording session".into()),
            VoiceError::TooShort => AppError::Validation("recording too short".into()),
            VoiceError::Silence => {
                AppError::Validation("no audio detected — check your input device".into())
            }
            VoiceError::LimitReached => AppError::Validation("recording limit reached".into()),
            VoiceError::Io(m) => AppError::Io(crate::secret::redact(&m)),
        }
    }
}

impl From<AppAiError> for AppError {
    fn from(e: AppAiError) -> Self {
        AppError::AppAi {
            code: e.code().to_string(),
            message: crate::secret::redact(&e.to_string()),
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCapability {
    pub configured: bool,
    pub model_ids: Vec<String>,
    pub privacy_mode: String,
    pub credential_label: Option<String>,
}

#[tauri::command]
pub fn voice_capability(state: State<'_, AppState>) -> Result<VoiceCapability, AppError> {
    match profile::resolve(&state, "voice.transcription") {
        Ok(p) => {
            let label = match &p.credential_profile_id {
                None => Some("ambient key (.env)".to_string()),
                Some(id) => {
                    let conn = state.db.lock().expect("db lock");
                    conn.query_row(
                        "SELECT label FROM credential_profiles WHERE id = ?1",
                        [id],
                        |r| r.get(0),
                    )
                    .optional()?
                }
            };
            Ok(VoiceCapability {
                configured: true,
                model_ids: p.models,
                privacy_mode: p.privacy_mode,
                credential_label: label,
            })
        }
        Err(_) => Ok(VoiceCapability {
            configured: false,
            model_ids: registry::get("voice.transcription")
                .map(|c| c.default_models.iter().map(|s| s.to_string()).collect())
                .unwrap_or_default(),
            privacy_mode: "strict".into(),
            credential_label: None,
        }),
    }
}

#[tauri::command]
pub fn voice_begin(
    voice: State<'_, VoiceState>,
    sample_rate: u32,
) -> Result<String, AppError> {
    Ok(voice.begin(sample_rate)?)
}

/// Chunked ingest over the raw request body: no base64 in the webview, no giant
/// ArrayBuffer accumulating in JS, and cancel/crash cleanup stays a single
/// unlink.
#[tauri::command]
pub fn voice_push(
    voice: State<'_, VoiceState>,
    request: tauri::ipc::Request<'_>,
) -> Result<PushAck, AppError> {
    let session_id = request
        .headers()
        .get("x-session-id")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| AppError::Validation("missing x-session-id".into()))?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        _ => return Err(AppError::Validation("expected a raw body".into())),
    };
    Ok(voice.push(session_id, bytes)?)
}

#[tauri::command]
pub fn voice_cancel(voice: State<'_, VoiceState>, session_id: String) {
    voice.cancel(&session_id);
}

#[tauri::command]
pub async fn voice_finish(
    state: State<'_, AppState>,
    voice: State<'_, VoiceState>,
    session_id: String,
    language: Option<String>,
) -> Result<openrouter::TranscriptResult, AppError> {
    let resolved = profile::resolve(&state, "voice.transcription")?;

    // Encode and DELETE the temp file before any network call.
    let (wav, _duration_ms) = voice.finish(&session_id)?;

    let result = openrouter::transcribe(
        &resolved.key,
        &resolved.models,
        &wav,
        language.as_deref(),
        openrouter::PrivacyMode::parse(&resolved.privacy_mode),
        resolved.timeout_ms,
    )
    .await?;

    profile::record(
        &state,
        "voice.transcription",
        resolved.requested(),
        result.model_served.as_deref(),
        result.duration_ms,
        wav.len(),
        result.text.chars().count(),
    );

    Ok(result)
}

#[tauri::command]
pub async fn models_for_capability(capability: String) -> Result<Vec<openrouter::ModelInfo>, AppError> {
    let spec = registry::get(&capability)
        .ok_or_else(|| AppError::NotFound("capability".into()))?;
    let all = openrouter::fetch_models().await?;
    Ok(openrouter::filter_for(&all, spec.required_input, spec.required_output))
}

#[tauri::command]
pub fn appai_capabilities() -> Vec<registry::CapabilityView> {
    registry::list()
}

/// Configure voice transcription: credential + model chain + privacy.
#[tauri::command]
pub fn voice_configure(
    state: State<'_, AppState>,
    credential_profile_id: String,
    model_ids: Vec<String>,
    privacy_mode: String,
) -> Result<(), AppError> {
    if !["strict", "balanced", "off"].contains(&privacy_mode.as_str()) {
        return Err(AppError::Validation("bad privacy mode".into()));
    }
    let conn = state.db.lock().expect("db lock");
    conn.execute("DELETE FROM capability_profiles WHERE capability = 'voice.transcription'", [])?;
    conn.execute(
        "INSERT INTO capability_profiles
           (id, label, capability, credential_profile_id, model_ids_json, privacy_mode,
            params_json, timeout_ms, created_at, updated_at)
         VALUES (?1, 'Voice transcription', 'voice.transcription', ?2, ?3, ?4, '{}', 90000, ?5, ?5)",
        rusqlite::params![
            ulid::Ulid::new().to_string(),
            credential_profile_id,
            serde_json::to_string(&model_ids).unwrap_or_else(|_| "[]".into()),
            privacy_mode,
            crate::db::now_ms()
        ],
    )?;
    Ok(())
}
