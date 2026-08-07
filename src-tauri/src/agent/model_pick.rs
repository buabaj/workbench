//! Choosing a model when the agent profile does not name one.
//!
//! This used to be `candidates.first()`, which on an OpenAI key selected
//! `gpt-4` — a model with an 8,192-token context window. For a coding agent
//! that is not merely a poor default, it is a broken one: reading a single
//! source file exhausts the window, so the turn dies part-way and the reply
//! never arrives. It is also among the most expensive and most rate-limited
//! models on the account.
//!
//! The obvious replacement — rank by context window, break ties on price — is
//! also wrong, and measurably so: run against a live 273-model catalogue it
//! chose `auto` and then a series of `:free` variants, because free models
//! sort first on price. Free tiers are the most rate-limited things on any
//! provider, so that swaps one rate-limit complaint for another.
//!
//! So: a small ordered list of model families known to be good at agentic
//! coding, matched as substrings so a version bump does not need a release,
//! with a properties-based fallback for providers and families not listed.
//! Anything a coding agent cannot use is excluded outright.
//!
//! `PREFERRED_FAMILIES` is a judgement call and will age. It is deliberately
//! the only part that needs revisiting, and the user can always override the
//! choice in Settings — which is the real fix for a default being wrong.

use serde_json::Value;

/// Model families worth defaulting to, best first, matched as substrings
/// against the id so both `gpt-5.1-codex` and `openai/gpt-5.1-codex` hit.
const PREFERRED_FAMILIES: &[&str] = &[
    // Purpose-built for coding agents.
    "gpt-5.1-codex",
    "codex",
    // Current general frontier families.
    "gpt-5.2",
    "gpt-5.1",
    "gpt-5",
    "claude-sonnet",
    "claude-opus",
    "gemini-3-pro",
    "gemini-3.1-pro",
    "gemini-2.5-pro",
    "claude-haiku",
    "kimi",
    // Previous generations, still far better than the alphabetical first hit.
    "gpt-4.1",
    "gpt-4o",
];

/// Substrings that mark a model a coding agent should never be handed.
const EXCLUDED: &[&str] = &[
    ":free",  // heavily rate-limited, which is the problem being solved
    ":batch", // asynchronous; not a conversational endpoint
    "-image", // image generation
    "-audio",
    "-tts",
    "-nano",    // too weak for multi-step tool use
    "-preview", // prefer the stable alias
];

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub id: String,
    pub context_window: u64,
    pub reasoning: bool,
    pub output_cost: f64,
    pub accepts_text: bool,
}

/// Context-window bands. Below 16k a coding agent cannot hold a file and a
/// conversation at once, so those models are a last resort.
fn band(context_window: u64) -> u8 {
    match context_window {
        c if c >= 128_000 => 3,
        c if c >= 32_000 => 2,
        c if c >= 16_000 => 1,
        _ => 0,
    }
}

/// Index in `PREFERRED_FAMILIES`, or one past the end for anything unlisted.
fn family_rank(id: &str) -> usize {
    let lower = id.to_lowercase();
    PREFERRED_FAMILIES
        .iter()
        .position(|f| lower.contains(f))
        .unwrap_or(PREFERRED_FAMILIES.len())
}

fn is_excluded(id: &str) -> bool {
    let lower = id.to_lowercase();
    // A router pseudo-model, not a model: what it resolves to is unknowable.
    if lower == "auto" || lower.ends_with("/auto") {
        return true;
    }
    // Dated snapshots pin an old build; prefer the moving alias.
    if regex_like_date(&lower) {
        return true;
    }
    EXCLUDED.iter().any(|e| lower.contains(e))
}

/// True for ids carrying a `-YYYY-MM-DD` snapshot suffix, without a regex dep.
fn regex_like_date(id: &str) -> bool {
    let b = id.as_bytes();
    for i in 0..b.len().saturating_sub(10) {
        if b[i] == b'-'
            && b[i + 1..i + 5].iter().all(|c| c.is_ascii_digit())
            && b[i + 5] == b'-'
            && b[i + 6..i + 8].iter().all(|c| c.is_ascii_digit())
            && b[i + 8] == b'-'
            && b[i + 9..i + 11].iter().all(|c| c.is_ascii_digit())
        {
            return true;
        }
    }
    false
}

pub fn parse_candidates(data: &Value, provider: &str) -> Vec<Candidate> {
    data.get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|m| m.get("provider").and_then(|p| p.as_str()) == Some(provider))
                .filter_map(|m| {
                    let id = m.get("id").and_then(|i| i.as_str())?.to_string();
                    let accepts_text = match m.get("input").and_then(|i| i.as_array()) {
                        // Absent modality info is not evidence of absence.
                        None => true,
                        Some(inputs) => inputs.iter().any(|v| v.as_str() == Some("text")),
                    };
                    Some(Candidate {
                        id,
                        context_window: m
                            .get("contextWindow")
                            .and_then(|c| c.as_u64())
                            .unwrap_or(0),
                        reasoning: m
                            .get("reasoning")
                            .and_then(|r| r.as_bool())
                            .unwrap_or(false),
                        output_cost: m
                            .get("cost")
                            .and_then(|c| c.get("output"))
                            .and_then(|c| c.as_f64())
                            .unwrap_or(0.0),
                        accepts_text,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The best model for agent work among `candidates`.
pub fn pick(candidates: &[Candidate]) -> Option<String> {
    let usable: Vec<&Candidate> = candidates
        .iter()
        .filter(|c| c.accepts_text && !is_excluded(&c.id))
        .collect();
    // Everything was excluded — better a questionable model than none at all.
    let mut usable = if usable.is_empty() {
        candidates.iter().filter(|c| c.accepts_text).collect()
    } else {
        usable
    };
    if usable.is_empty() {
        return None;
    }

    // A paid model if any exists: a $0 listing means a free tier, and free
    // tiers are the most aggressively rate-limited endpoints a provider has.
    let paid: Vec<&Candidate> = usable.iter().filter(|c| c.output_cost > 0.0).copied().collect();
    if !paid.is_empty() {
        usable = paid;
    }

    usable.sort_by(|a, b| {
        family_rank(&a.id)
            .cmp(&family_rank(&b.id))
            .then(band(b.context_window).cmp(&band(a.context_window)))
            .then(b.reasoning.cmp(&a.reasoning))
            // Within one family, the cheaper variant is the sensible default.
            .then(
                a.output_cost
                    .partial_cmp(&b.output_cost)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
            // Deterministic when everything ties, so the same account does not
            // get a different model on each launch.
            .then(a.id.len().cmp(&b.id.len()))
            .then(a.id.cmp(&b.id))
    });
    Some(usable[0].id.clone())
}

/// Convenience: parse then pick, for a provider.
pub fn pick_for(data: &Value, provider: &str) -> Option<String> {
    pick(&parse_candidates(data, provider))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn c(id: &str, ctx: u64, reasoning: bool, cost: f64) -> Candidate {
        Candidate {
            id: id.into(),
            context_window: ctx,
            reasoning,
            output_cost: cost,
            accepts_text: true,
        }
    }

    /// The original regression: an OpenAI key selected gpt-4 (8k) and the
    /// agent went silent after reading one file.
    #[test]
    fn never_picks_a_tiny_context_legacy_model() {
        let models = vec![c("gpt-4", 8_192, false, 60.0), c("gpt-4o", 128_000, false, 10.0)];
        assert_eq!(pick(&models).as_deref(), Some("gpt-4o"));
    }

    /// The second regression, found by running the first fix against a live
    /// catalogue: ranking on price alone selects free, rate-limited models.
    #[test]
    fn never_picks_a_free_tier_model_over_a_paid_one() {
        let models = vec![
            c("cohere/north-mini-code:free", 256_000, true, 0.0),
            c("openai/gpt-5.1-codex", 400_000, true, 10.0),
        ];
        assert_eq!(pick(&models).as_deref(), Some("openai/gpt-5.1-codex"));
    }

    #[test]
    fn rejects_the_auto_router_pseudo_model() {
        let models = vec![
            c("auto", 2_000_000, true, 0.0),
            c("openai/gpt-5", 400_000, true, 10.0),
        ];
        assert_eq!(pick(&models).as_deref(), Some("openai/gpt-5"));
    }

    #[test]
    fn prefers_a_coding_family_over_a_bigger_window() {
        let models = vec![
            c("some/enormous-generalist", 2_000_000, true, 5.0),
            c("openai/gpt-5.1-codex", 400_000, true, 10.0),
        ];
        assert_eq!(pick(&models).as_deref(), Some("openai/gpt-5.1-codex"));
    }

    #[test]
    fn prefers_the_cheaper_variant_within_one_family() {
        let models = vec![
            c("openai/gpt-5-pro", 400_000, true, 80.0),
            c("openai/gpt-5-mini", 400_000, true, 2.0),
        ];
        assert_eq!(pick(&models).as_deref(), Some("openai/gpt-5-mini"));
    }

    #[test]
    fn skips_image_audio_and_nano_variants() {
        for junk in ["openai/gpt-5-image", "openai/gpt-5-audio", "openai/gpt-5-nano"] {
            let models = vec![c(junk, 400_000, true, 1.0), c("openai/gpt-4o", 128_000, false, 10.0)];
            assert_eq!(pick(&models).as_deref(), Some("openai/gpt-4o"), "{junk}");
        }
    }

    #[test]
    fn prefers_a_stable_alias_over_a_dated_snapshot_or_preview() {
        let models = vec![
            c("openai/gpt-4o-2024-05-13", 128_000, false, 10.0),
            c("google/gemini-2.5-pro-preview", 1_000_000, true, 10.0),
            c("openai/gpt-4o", 128_000, false, 10.0),
        ];
        assert_eq!(pick(&models).as_deref(), Some("openai/gpt-4o"));
    }

    #[test]
    fn falls_back_to_properties_when_no_family_is_recognised() {
        let models = vec![
            c("newco/unknown-small", 8_000, false, 1.0),
            c("newco/unknown-large", 200_000, true, 3.0),
        ];
        assert_eq!(pick(&models).as_deref(), Some("newco/unknown-large"));
    }

    #[test]
    fn takes_a_free_model_when_that_is_genuinely_all_there_is() {
        let models = vec![c("someone/only-option:free", 200_000, true, 0.0)];
        assert_eq!(pick(&models).as_deref(), Some("someone/only-option:free"));
    }

    #[test]
    fn skips_models_that_cannot_take_text() {
        let models = vec![
            Candidate { accepts_text: false, ..c("image-only", 500_000, true, 1.0) },
            c("text-model", 40_000, false, 9.0),
        ];
        assert_eq!(pick(&models).as_deref(), Some("text-model"));
    }

    #[test]
    fn is_deterministic_when_everything_ties() {
        let models = vec![c("z/model", 200_000, true, 1.0), c("a/model", 200_000, true, 1.0)];
        assert_eq!(pick(&models).as_deref(), Some("a/model"));
    }

    #[test]
    fn returns_none_with_no_candidates() {
        assert_eq!(pick(&[]), None);
    }

    #[test]
    fn detects_dated_snapshot_suffixes() {
        assert!(regex_like_date("openai/gpt-4o-2024-05-13"));
        assert!(!regex_like_date("openai/gpt-4.1"));
        assert!(!regex_like_date("anthropic/claude-haiku-4.5"));
    }

    #[test]
    fn parses_the_shape_the_agent_actually_reports() {
        let data = json!({
            "models": [
                {
                    "id": "ai21/jamba-large-1.7", "provider": "openrouter",
                    "reasoning": false, "input": ["text"],
                    "cost": { "input": 2, "output": 8 },
                    "contextWindow": 256000, "maxTokens": 4096
                },
                {
                    "id": "other/model", "provider": "someone-else",
                    "reasoning": true, "input": ["text"],
                    "cost": { "output": 1 }, "contextWindow": 1000000
                }
            ]
        });
        let got = parse_candidates(&data, "openrouter");
        assert_eq!(got.len(), 1, "must filter by provider");
        assert_eq!(got[0].id, "ai21/jamba-large-1.7");
        assert_eq!(got[0].context_window, 256_000);
        assert_eq!(got[0].output_cost, 8.0);
        assert_eq!(pick_for(&data, "openrouter").as_deref(), Some("ai21/jamba-large-1.7"));
    }

    #[test]
    fn a_model_missing_its_metadata_still_parses() {
        let data = json!({ "models": [ { "id": "bare", "provider": "p" } ] });
        let got = parse_candidates(&data, "p");
        assert_eq!(got[0].context_window, 0);
        assert!(got[0].accepts_text, "absent modality info is not absence");
        assert_eq!(pick_for(&data, "p").as_deref(), Some("bare"));
    }
}
