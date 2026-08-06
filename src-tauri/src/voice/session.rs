//! Recording session lifecycle.
//!
//! Deletion of captured audio is guaranteed on four paths: success (the temp
//! file is removed *before* the request is sent, so only the in-memory buffer
//! travels), cancel, failure (Drop), and crash (startup sweep). No DB row ever
//! references audio, no path is logged, and there is no recording history.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Hard stop. Also keeps us far under OpenRouter's ~60s upstream timeout for
/// the transcription request itself.
pub const MAX_DURATION_MS: u64 = 120_000;
pub const WARN_DURATION_MS: u64 = 90_000;
pub const MAX_BYTES: u64 = 20 * 1024 * 1024;
pub const MIN_DURATION_MS: u64 = 400;
/// Below this RMS the recording is treated as silence and no request is made.
pub const SILENCE_RMS: f32 = 0.004;

#[derive(Debug, thiserror::Error)]
pub enum VoiceError {
    #[error("no recording session")]
    NoSession,
    #[error("recording too short")]
    TooShort,
    #[error("no audio detected — check your input device")]
    Silence,
    #[error("recording limit reached")]
    LimitReached,
    #[error("io: {0}")]
    Io(String),
}

impl From<std::io::Error> for VoiceError {
    fn from(e: std::io::Error) -> Self {
        VoiceError::Io(e.to_string())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitState {
    Ok,
    Warn,
    Hard,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushAck {
    pub total_bytes: u64,
    pub elapsed_ms: u64,
    pub limit_state: LimitState,
}

pub struct VoiceSession {
    pub id: String,
    path: PathBuf,
    file: std::fs::File,
    pub sample_rate: u32,
    pub bytes: u64,
    started_at: std::time::Instant,
}

impl VoiceSession {
    fn elapsed_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }

    fn limit_state(&self) -> LimitState {
        let ms = self.elapsed_ms();
        if ms >= MAX_DURATION_MS || self.bytes >= MAX_BYTES {
            LimitState::Hard
        } else if ms >= WARN_DURATION_MS {
            LimitState::Warn
        } else {
            LimitState::Ok
        }
    }
}

impl Drop for VoiceSession {
    fn drop(&mut self) {
        // Unconditional: cancel, error, and app exit all land here.
        let _ = std::fs::remove_file(&self.path);
    }
}

#[derive(Default)]
pub struct VoiceState {
    sessions: Mutex<HashMap<String, VoiceSession>>,
    dir: Mutex<Option<PathBuf>>,
}

impl VoiceState {
    /// Crash safety: nothing in the voice directory is ever meant to outlive a
    /// session, so the whole directory is emptied at startup.
    pub fn sweep_on_startup(&self, app_cache: &Path) {
        let dir = app_cache.join("voice");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        *self.dir.lock().unwrap() = Some(dir);
    }

    fn dir(&self) -> Result<PathBuf, VoiceError> {
        self.dir
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| VoiceError::Io("voice directory not initialised".into()))
    }

    pub fn begin(&self, sample_rate: u32) -> Result<String, VoiceError> {
        let dir = self.dir()?;
        std::fs::create_dir_all(&dir)?;
        let id = ulid::Ulid::new().to_string();
        let path = dir.join(format!("{id}.pcm"));
        let file = std::fs::File::create(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        self.sessions.lock().unwrap().insert(
            id.clone(),
            VoiceSession {
                id: id.clone(),
                path,
                file,
                sample_rate: sample_rate.clamp(8_000, 192_000),
                bytes: 0,
                started_at: std::time::Instant::now(),
            },
        );
        Ok(id)
    }

    /// Append a chunk. Limits are enforced here, server-side: the frontend
    /// cannot be the only guard.
    pub fn push(&self, id: &str, bytes: &[u8]) -> Result<PushAck, VoiceError> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(id).ok_or(VoiceError::NoSession)?;
        if session.limit_state() == LimitState::Hard {
            return Ok(PushAck {
                total_bytes: session.bytes,
                elapsed_ms: session.elapsed_ms(),
                limit_state: LimitState::Hard,
            });
        }
        session.file.write_all(bytes)?;
        session.bytes += bytes.len() as u64;
        Ok(PushAck {
            total_bytes: session.bytes,
            elapsed_ms: session.elapsed_ms(),
            limit_state: session.limit_state(),
        })
    }

    /// Finish: read the PCM, delete the temp file, and return WAV bytes ready
    /// to upload. The file is gone before any network call happens.
    pub fn finish(&self, id: &str) -> Result<(Vec<u8>, u64), VoiceError> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .remove(id)
            .ok_or(VoiceError::NoSession)?;

        let raw = std::fs::read(&session.path)?;
        let samples = super::pcm::bytes_to_samples(&raw);
        let duration_ms =
            (samples.len() as u64 * 1000) / session.sample_rate.max(1) as u64;

        // `session` drops at the end of this scope, removing the file — but do
        // it explicitly first so nothing can observe it during encoding.
        drop(session);

        if duration_ms < MIN_DURATION_MS {
            return Err(VoiceError::TooShort);
        }
        let resampled = super::pcm::resample_to_16k(&samples, {
            // sample_rate moved with the session; recompute from duration.
            if duration_ms == 0 {
                super::pcm::TARGET_RATE
            } else {
                ((samples.len() as u64 * 1000) / duration_ms) as u32
            }
        });
        if super::pcm::rms(&resampled) < SILENCE_RMS {
            return Err(VoiceError::Silence);
        }
        let wav = super::pcm::encode_wav(&resampled, super::pcm::TARGET_RATE)
            .map_err(|e| VoiceError::Io(e.to_string()))?;
        Ok((wav, duration_ms))
    }

    pub fn cancel(&self, id: &str) {
        // Removing from the map drops the session, which unlinks the file.
        self.sessions.lock().unwrap().remove(id);
    }

    pub fn cancel_all(&self) {
        self.sessions.lock().unwrap().clear();
    }

    pub fn active_count(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_with_dir() -> (tempfile::TempDir, VoiceState) {
        let dir = tempfile::tempdir().unwrap();
        let state = VoiceState::default();
        state.sweep_on_startup(dir.path());
        (dir, state)
    }

    fn tone_bytes(rate: u32, ms: u32) -> Vec<u8> {
        let n = (rate * ms / 1000) as usize;
        (0..n)
            .flat_map(|i| {
                let t = i as f32 / rate as f32;
                let s = ((t * 440.0 * std::f32::consts::TAU).sin() * 0.5 * i16::MAX as f32) as i16;
                s.to_le_bytes()
            })
            .collect()
    }

    #[test]
    fn full_capture_produces_wav_and_deletes_temp_file() {
        let (dir, state) = state_with_dir();
        let id = state.begin(48_000).unwrap();
        let voice_dir = dir.path().join("voice");
        assert_eq!(std::fs::read_dir(&voice_dir).unwrap().count(), 1);

        for _ in 0..10 {
            state.push(&id, &tone_bytes(48_000, 100)).unwrap();
        }
        let (wav, duration_ms) = state.finish(&id).unwrap();
        assert_eq!(&wav[0..4], b"RIFF");
        assert!((duration_ms as i64 - 1000).abs() < 50, "got {duration_ms}ms");

        assert_eq!(
            std::fs::read_dir(&voice_dir).unwrap().count(),
            0,
            "temp audio survived a successful finish"
        );
        assert_eq!(state.active_count(), 0);
    }

    #[test]
    fn cancel_deletes_temp_file() {
        let (dir, state) = state_with_dir();
        let id = state.begin(48_000).unwrap();
        state.push(&id, &tone_bytes(48_000, 500)).unwrap();
        state.cancel(&id);
        assert_eq!(
            std::fs::read_dir(dir.path().join("voice")).unwrap().count(),
            0
        );
    }

    #[test]
    fn silence_is_rejected_before_any_request() {
        let (_dir, state) = state_with_dir();
        let id = state.begin(16_000).unwrap();
        state.push(&id, &vec![0u8; 16_000 * 2]).unwrap(); // 1s of zeros
        assert!(matches!(state.finish(&id), Err(VoiceError::Silence)));
    }

    #[test]
    fn too_short_is_rejected() {
        let (_dir, state) = state_with_dir();
        let id = state.begin(16_000).unwrap();
        state.push(&id, &tone_bytes(16_000, 100)).unwrap();
        assert!(matches!(state.finish(&id), Err(VoiceError::TooShort)));
    }

    #[test]
    fn byte_limit_reports_hard_and_stops_accepting() {
        let (_dir, state) = state_with_dir();
        let id = state.begin(48_000).unwrap();
        let chunk = vec![7u8; 1024 * 1024];
        let mut last = None;
        for _ in 0..25 {
            last = Some(state.push(&id, &chunk).unwrap());
        }
        let ack = last.unwrap();
        assert_eq!(ack.limit_state, LimitState::Hard);
        // Further pushes do not grow the file.
        let before = ack.total_bytes;
        let after = state.push(&id, &chunk).unwrap().total_bytes;
        assert_eq!(before, after, "bytes accepted past the hard limit");
    }

    #[test]
    fn startup_sweep_removes_orphaned_recordings() {
        let dir = tempfile::tempdir().unwrap();
        let voice = dir.path().join("voice");
        std::fs::create_dir_all(&voice).unwrap();
        std::fs::write(voice.join("orphan.pcm"), b"leftover from a crash").unwrap();

        let state = VoiceState::default();
        state.sweep_on_startup(dir.path());
        assert_eq!(std::fs::read_dir(&voice).unwrap().count(), 0);
    }

    #[test]
    fn unknown_session_is_an_error_not_a_panic() {
        let (_dir, state) = state_with_dir();
        assert!(matches!(state.push("nope", b"x"), Err(VoiceError::NoSession)));
        assert!(matches!(state.finish("nope"), Err(VoiceError::NoSession)));
        state.cancel("nope"); // no-op
    }
}
