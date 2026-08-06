//! Voice pipeline integration: capture → resample → WAV, and the guarantee
//! that captured audio never outlives the request.

use workbench_lib::appai::openrouter::{transcription_body, PrivacyMode};
use workbench_lib::voice::pcm;
use workbench_lib::voice::session::VoiceState;

fn speech_like(rate: u32, ms: u32) -> Vec<u8> {
    // Two tones mixed — enough structure to survive decimation and clear the
    // silence gate.
    let n = (rate * ms / 1000) as usize;
    (0..n)
        .flat_map(|i| {
            let t = i as f32 / rate as f32;
            let a = (t * 220.0 * std::f32::consts::TAU).sin() * 0.35;
            let b = (t * 700.0 * std::f32::consts::TAU).sin() * 0.2;
            (((a + b) * i16::MAX as f32) as i16).to_le_bytes()
        })
        .collect()
}

#[test]
fn capture_at_48k_produces_a_16k_wav_ready_to_upload() {
    let dir = tempfile::tempdir().unwrap();
    let state = VoiceState::default();
    state.sweep_on_startup(dir.path());

    let id = state.begin(48_000).unwrap();
    // 2 seconds in 200ms chunks, the way the worklet ships them.
    for _ in 0..10 {
        state.push(&id, &speech_like(48_000, 200)).unwrap();
    }
    let (wav, duration_ms) = state.finish(&id).unwrap();

    assert!((duration_ms as i64 - 2000).abs() < 60, "got {duration_ms}ms");

    let reader = hound::WavReader::new(std::io::Cursor::new(&wav)).unwrap();
    assert_eq!(reader.spec().sample_rate, pcm::TARGET_RATE);
    assert_eq!(reader.spec().channels, 1);
    assert_eq!(reader.spec().bits_per_sample, 16);
    // ~2s at 16 kHz.
    assert!((reader.duration() as i64 - 32_000).abs() < 800);

    // The request body carries exactly these bytes, base64-encoded, as wav.
    let body = transcription_body("openai/whisper-1", &wav, None, PrivacyMode::Strict);
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(body["input_audio"]["data"].as_str().unwrap())
        .unwrap();
    assert_eq!(decoded, wav);
    assert_eq!(body["input_audio"]["format"], "wav");
}

#[test]
fn audio_is_deleted_on_every_terminal_path() {
    let dir = tempfile::tempdir().unwrap();
    let voice_dir = dir.path().join("voice");
    let state = VoiceState::default();
    state.sweep_on_startup(dir.path());
    let count = || std::fs::read_dir(&voice_dir).unwrap().count();

    // 1. success
    let id = state.begin(16_000).unwrap();
    state.push(&id, &speech_like(16_000, 1000)).unwrap();
    state.finish(&id).unwrap();
    assert_eq!(count(), 0, "survived success");

    // 2. cancel mid-recording
    let id = state.begin(16_000).unwrap();
    state.push(&id, &speech_like(16_000, 500)).unwrap();
    state.cancel(&id);
    assert_eq!(count(), 0, "survived cancel");

    // 3. rejected as silence (finish returns Err)
    let id = state.begin(16_000).unwrap();
    state.push(&id, &vec![0u8; 16_000 * 2]).unwrap();
    assert!(state.finish(&id).is_err());
    assert_eq!(count(), 0, "survived a rejected finish");

    // 4. app exit with a recording in flight
    let id = state.begin(16_000).unwrap();
    state.push(&id, &speech_like(16_000, 500)).unwrap();
    state.cancel_all();
    assert_eq!(count(), 0, "survived app exit");
}

#[test]
fn telemetry_table_cannot_hold_a_transcript() {
    // Structural guarantee: the schema has no content-bearing column, so a
    // transcript cannot be persisted even by mistake.
    let dir = tempfile::tempdir().unwrap();
    let conn = workbench_lib::db::open(&dir.path().join("t.db")).unwrap();
    let stmt = conn.prepare("SELECT * FROM appai_invocations LIMIT 0").unwrap();
    let columns: Vec<String> = stmt
        .column_names()
        .into_iter()
        .map(str::to_string)
        .collect();
    for forbidden in ["text", "transcript", "prompt", "content", "path", "audio"] {
        assert!(
            !columns.iter().any(|c| c.contains(forbidden)),
            "column '{forbidden}' would allow content storage: {columns:?}"
        );
    }
    assert!(columns.contains(&"output_chars".to_string()));
    assert!(columns.contains(&"model_served".to_string()));
}
