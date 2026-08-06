//! Voice capture: AudioWorklet PCM in, 16 kHz mono WAV out.
//!
//! WAV rather than a browser-produced container because `wav` is the only
//! format on every OpenRouter format list, while WKWebView's MediaRecorder
//! emits `audio/mp4` — a value that appears on none of them.

pub mod pcm;
pub mod session;
