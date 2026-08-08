//! Capability registry: what Workbench's own AI can do, and what each needs
//! from a model.
//!
//! `required_input`/`required_output` are what make a model list per capability
//! possible — OpenRouter's catalogue is filtered by modality, so a text model
//! never appears as a candidate for transcription.

pub struct CapabilitySpec {
    pub key: &'static str,
    pub display_name: &'static str,
    pub implemented: bool,
    /// Required OpenRouter modalities, matched by SET MEMBERSHIP — the order of
    /// `architecture.input_modalities` is not stable across models.
    pub required_input: &'static [&'static str],
    pub required_output: &'static [&'static str],
    pub default_models: &'static [&'static str],
}

pub const CAPABILITIES: &[CapabilitySpec] = &[
    CapabilitySpec {
        key: "voice.transcription",
        display_name: "Voice transcription",
        implemented: true,
        required_input: &["audio"],
        required_output: &["transcription"],
        default_models: &[
            "openai/gpt-4o-mini-transcribe",
            "openai/whisper-large-v3-turbo",
            "openai/whisper-1",
        ],
    },
    CapabilitySpec {
        key: "chat.title",
        display_name: "Conversation titles",
        implemented: true,
        required_input: &["text"],
        required_output: &["text"],
        // Cheap and fast: this runs once per conversation and the output is
        // half a dozen words.
        // Verified live against OpenRouter's catalogue — an id that 404s
        // burns the whole fallback chain silently.
        default_models: &[
            "google/gemini-3.5-flash-lite",
            "openai/gpt-4o-mini",
            "anthropic/claude-haiku-4.5",
        ],
    },
    CapabilitySpec {
        key: "note.action",
        display_name: "Inline note actions",
        implemented: true,
        required_input: &["text"],
        required_output: &["text"],
        // Prose written into a document, so quality matters more than for a
        // title, and the context window has to hold a paper — a paper note
        // carrying extracted full text runs to 150KB, which is most of a
        // smaller model's window before the request is even added.
        // deepseek-v4-flash has a 1M window at $0.28/M, verified live.
        default_models: &[
            "deepseek/deepseek-v4-flash",
            "anthropic/claude-haiku-4.5",
            "google/gemini-3.5-flash-lite",
        ],
    },
    CapabilitySpec {
        key: "transcript.cleanup",
        display_name: "Transcript cleanup",
        implemented: true,
        required_input: &["text"],
        required_output: &["text"],
        // Sits between speaking and seeing your words, so latency is the whole
        // experience — the same tier as titles, for the same reason.
        default_models: &[
            "google/gemini-3.5-flash-lite",
            "openai/gpt-4o-mini",
            "anthropic/claude-haiku-4.5",
        ],
    },
    CapabilitySpec {
        key: "research.summarize",
        display_name: "Summarize",
        implemented: true,
        required_input: &["text"],
        required_output: &["text"],
        // Reads a whole paper note, extracted full text and all, so the window
        // matters more than anything else here.
        default_models: &[
            "deepseek/deepseek-v4-flash",
            "anthropic/claude-haiku-4.5",
            "google/gemini-3.5-flash-lite",
        ],
    },
    CapabilitySpec {
        key: "links.suggest",
        display_name: "Suggest links",
        implemented: true,
        required_input: &["text"],
        required_output: &["text"],
        // Same shape as summarizing: a long note in, a short structured answer
        // out, and it has to hold the vault's note names alongside it.
        default_models: &[
            "deepseek/deepseek-v4-flash",
            "google/gemini-3.5-flash-lite",
            "anthropic/claude-haiku-4.5",
        ],
    },
];

pub fn get(key: &str) -> Option<&'static CapabilitySpec> {
    CAPABILITIES.iter().find(|c| c.key == key)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityView {
    pub key: String,
    pub display_name: String,
    pub implemented: bool,
    pub default_models: Vec<String>,
}

pub fn list() -> Vec<CapabilityView> {
    CAPABILITIES
        .iter()
        .map(|c| CapabilityView {
            key: c.key.into(),
            display_name: c.display_name.into(),
            implemented: c.implemented,
            default_models: c.default_models.iter().map(|s| s.to_string()).collect(),
        })
        .collect()
}
