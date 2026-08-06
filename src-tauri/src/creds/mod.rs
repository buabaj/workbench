//! Credential profiles: Keychain-backed secrets, SQLite-backed metadata.

pub mod keychain;
pub mod store;

/// Built-in provider slugs prime-agent understands via env vars, with the env
/// var each resolves (providers.md table). Used for validation and for the
/// EnvOnly injection mode.
pub const PROVIDER_ENV_VARS: &[(&str, &str)] = &[
    ("anthropic", "ANTHROPIC_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
    ("prime-inference", "PRIME_API_KEY"),
    ("openrouter", "OPENROUTER_API_KEY"),
    ("kimi-coding", "KIMI_API_KEY"),
    ("google", "GEMINI_API_KEY"),
    ("deepseek", "DEEPSEEK_API_KEY"),
    ("xai", "XAI_API_KEY"),
    ("groq", "GROQ_API_KEY"),
    ("cerebras", "CEREBRAS_API_KEY"),
    ("mistral", "MISTRAL_API_KEY"),
    ("fireworks", "FIREWORKS_API_KEY"),
    ("zai", "ZAI_API_KEY"),
    ("minimax", "MINIMAX_API_KEY"),
    ("xiaomi", "XIAOMI_API_KEY"),
];

pub fn env_var_for_slug(slug: &str) -> Option<&'static str> {
    PROVIDER_ENV_VARS
        .iter()
        .find(|(s, _)| *s == slug)
        .map(|(_, v)| *v)
}

pub fn is_known_slug(slug: &str) -> bool {
    env_var_for_slug(slug).is_some()
}
