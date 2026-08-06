//! Voice commands. Audio never reaches SQLite, never reaches a log, and the
//! temp file is gone before the network call happens.

use rusqlite::OptionalExtension;
use tauri::State;

use crate::appai::{openrouter, registry, AppAiError};
use crate::creds::keychain::account_for;
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

/// Where a voice credential came from. Ambient keys (`.env`) mean the app can
/// transcribe without ever asking — the user opted into that by dropping the
/// key in a file.
enum CredSource {
    /// Keychain, via a configured capability profile.
    Profile(String),
    /// `.env` or the process environment.
    Ambient,
}

struct VoiceProfile {
    source: CredSource,
    model_ids: Vec<String>,
    privacy_mode: String,
    timeout_ms: u64,
}

/// A Finder-launched `.app` has cwd `/`, so the project `.env` is only findable
/// via the workspace the user actually opened.
fn last_workspace_root(state: &State<'_, AppState>) -> Option<std::path::PathBuf> {
    let conn = state.db.lock().expect("db lock");
    conn.query_row(
        "SELECT root_real FROM workspaces ORDER BY last_opened_at DESC NULLS LAST LIMIT 1",
        [],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .map(std::path::PathBuf::from)
}

fn default_models() -> Vec<String> {
    registry::get("voice.transcription")
        .map(|c| c.default_models.iter().map(|s| s.to_string()).collect())
        .unwrap_or_default()
}

fn load_profile(state: &State<'_, AppState>) -> Result<VoiceProfile, AppError> {
    let conn = state.db.lock().expect("db lock");
    let row = conn
        .query_row(
            "SELECT credential_profile_id, model_ids_json, privacy_mode, timeout_ms
               FROM capability_profiles WHERE capability = 'voice.transcription'
              ORDER BY created_at DESC LIMIT 1",
            [],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((credential_id, models_json, privacy_mode, timeout_ms)) = row else {
        // No configured profile — fall back to an ambient key so internal AI
        // capabilities work without a setup step.
        drop(conn);
        let root = last_workspace_root(state);
        if crate::appai::dotenv::has_openrouter(root.as_deref()) {
            return Ok(VoiceProfile {
                source: CredSource::Ambient,
                model_ids: default_models(),
                privacy_mode: "strict".into(),
                timeout_ms: 90_000,
            });
        }
        return Err(AppError::from(AppAiError::NoCapabilityProfile(
            "voice.transcription".into(),
        )));
    };
    let mut model_ids: Vec<String> = serde_json::from_str(&models_json).unwrap_or_default();
    if model_ids.is_empty() {
        model_ids = default_models();
    }
    Ok(VoiceProfile {
        source: CredSource::Profile(credential_id),
        model_ids,
        privacy_mode,
        timeout_ms: timeout_ms as u64,
    })
}

#[tauri::command]
pub fn voice_capability(state: State<'_, AppState>) -> Result<VoiceCapability, AppError> {
    match load_profile(&state) {
        Ok(p) => {
            let label = match &p.source {
                CredSource::Ambient => Some("ambient key (.env)".to_string()),
                CredSource::Profile(id) => {
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
                model_ids: p.model_ids,
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
    let profile = load_profile(&state)?;
    let key = match &profile.source {
        CredSource::Ambient => {
            let root = last_workspace_root(&state);
            crate::appai::dotenv::lookup("OPENROUTER_API_KEY", root.as_deref())
                .ok_or_else(|| AppError::from(AppAiError::NoCredential))?
        }
        CredSource::Profile(id) => state
            .keychain
            .get(&account_for(id))
            .map_err(|e| AppError::Internal(crate::secret::redact(&e.to_string())))?
            .ok_or_else(|| AppError::from(AppAiError::NoCredential))?,
    };

    // Encode and DELETE the temp file before any network call.
    let (wav, _duration_ms) = voice.finish(&session_id)?;

    let result = openrouter::transcribe(
        &key,
        &profile.model_ids,
        &wav,
        language.as_deref(),
        openrouter::PrivacyMode::parse(&profile.privacy_mode),
        profile.timeout_ms,
    )
    .await?;

    // Telemetry: scalars only. No transcript text, no audio, no paths.
    {
        let conn = state.db.lock().expect("db lock");
        let _ = conn.execute(
            "INSERT INTO appai_invocations
               (id, capability, model_requested, model_served, status, duration_ms,
                input_bytes, output_chars, created_at)
             VALUES (?1, 'voice.transcription', ?2, ?3, 'ok', ?4, ?5, ?6, ?7)",
            rusqlite::params![
                ulid::Ulid::new().to_string(),
                profile.model_ids.first(),
                result.model_served,
                result.duration_ms as i64,
                wav.len() as i64,
                result.text.chars().count() as i64,
                crate::db::now_ms()
            ],
        );
    }

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
