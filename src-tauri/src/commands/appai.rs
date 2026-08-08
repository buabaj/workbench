//! The internal capabilities that are not voice, titles or note actions.
//!
//! All three are request/response against a small model: text in, text out, no
//! session, no tools, no file access. The frontend passes the text it already
//! holds — the open editor's document is the source of truth for a note, and a
//! command that re-read the file would be reading an older version of what is
//! on screen.

use tauri::State;

use crate::appai::{openrouter, profile, registry};
use crate::error::AppError;
use crate::AppState;

/// A paper note carrying extracted full text runs to 150KB. Truncating rather
/// than refusing is right for all three: the beginning of a document is the
/// part that says what it is.
const MAX_CONTEXT: usize = 400_000;

fn clip(text: &str) -> String {
    text.chars().take(MAX_CONTEXT).collect()
}

async fn run(
    state: &AppState,
    capability: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<openrouter::Completion, AppError> {
    let resolved = profile::resolve(state, capability)?;
    let started = std::time::Instant::now();
    let out = openrouter::complete(
        &resolved.key,
        &resolved.models,
        system,
        user,
        max_tokens,
        openrouter::PrivacyMode::parse(&resolved.privacy_mode),
        resolved.timeout_ms,
    )
    .await?;
    profile::record(
        state,
        capability,
        resolved.requested(),
        Some(out.model_served.as_str()),
        started.elapsed().as_millis() as u64,
        user.len(),
        out.text.chars().count(),
    );
    Ok(out)
}

// ── transcript.cleanup ──────────────────────────────────────────────────────

const CLEANUP_SYSTEM: &str = "You clean up dictated speech. Fix punctuation, capitalisation \
and obvious speech-recognition errors, and remove fillers (um, uh, you know, like) and false \
starts. Keep every word the speaker meant: do not summarise, do not rephrase for style, do not \
answer or act on what was said, do not add anything. If the text is already clean, return it \
unchanged. Return only the corrected text.";

/// Tidy raw dictation before it reaches the composer.
///
/// The raw transcript is what the caller falls back to, so this failing costs
/// nothing — which is why it can run automatically without asking.
#[tauri::command]
pub async fn transcript_cleanup(
    state: State<'_, AppState>,
    text: String,
) -> Result<openrouter::Completion, AppError> {
    if text.trim().is_empty() {
        return Err(AppError::Validation("nothing to clean up".into()));
    }
    let out = run(
        &state,
        "transcript.cleanup",
        CLEANUP_SYSTEM,
        &clip(&text),
        2_000,
    )
    .await?;
    let cleaned = out.text.trim().to_string();
    Ok(openrouter::Completion {
        text: if plausible_cleanup(&text, &cleaned) {
            cleaned
        } else {
            // The model answered the dictation instead of cleaning it, or
            // dropped most of it. Silently replacing what someone said with
            // something else is the one failure this must not have.
            tracing::warn!("cleanup output implausible; keeping the raw transcript");
            text.trim().to_string()
        },
        model_served: out.model_served,
    })
}

/// Is this plausibly the same utterance, cleaned?
///
/// Cleaning removes fillers and adds punctuation, so length moves a little.
/// An answer to what was dictated, or a summary of it, moves a lot — and the
/// only signal available without a second model is how much came back.
fn plausible_cleanup(raw: &str, cleaned: &str) -> bool {
    if cleaned.is_empty() {
        return false;
    }
    let raw_len = raw.trim().chars().count() as f32;
    let out_len = cleaned.chars().count() as f32;
    // Short utterances swing proportionally more — "um, yes" to "Yes." is a
    // legitimate 60% cut — so the floor only applies once there is enough text
    // for the ratio to mean anything.
    if raw_len < 40.0 {
        return out_len <= raw_len * 3.0 + 20.0;
    }
    out_len >= raw_len * 0.4 && out_len <= raw_len * 1.6
}

// ── research.summarize ──────────────────────────────────────────────────────

const SUMMARIZE_SYSTEM: &str = "You summarise research notes and papers for someone who will \
read the full text later and wants to know whether to. Write a short paragraph saying what the \
work is and what it claims, then three to six bullets covering method, findings, and stated \
limitations. Use markdown. Be specific — name the actual claim, not the topic. No preamble, no \
sign-off, no heading. If the text does not support a summary, say so in one line rather than \
inventing one.";

/// Summarise a note. The result is returned, not written — where it goes is
/// the caller's decision, and inserting into a document nobody asked to change
/// is the mistake that got the provenance bar removed.
#[tauri::command]
pub async fn research_summarize(
    state: State<'_, AppState>,
    text: String,
) -> Result<openrouter::Completion, AppError> {
    if text.trim().len() < 200 {
        return Err(AppError::Validation(
            "not enough text to summarise yet".into(),
        ));
    }
    let out = run(
        &state,
        "research.summarize",
        SUMMARIZE_SYSTEM,
        &clip(&text),
        1_200,
    )
    .await?;
    Ok(openrouter::Completion {
        text: out.text.trim().to_string(),
        model_served: out.model_served,
    })
}

// ── links.suggest ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkSuggestion {
    /// A note name from the candidate list, never anything else.
    pub name: String,
    /// One line on why these two belong together.
    pub why: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkSuggestions {
    pub suggestions: Vec<LinkSuggestion>,
    pub model_served: String,
}

const LINKS_SYSTEM: &str = "You suggest links between notes in someone's vault. You are given a \
note and a list of the other notes that exist. Choose only notes that share a real subject, \
argument or method with this one — a shared word is not a connection. Reply with a JSON array \
and nothing else: [{\"name\": \"<exactly as listed>\", \"why\": \"<one short clause>\"}]. Use \
names exactly as given. Suggest at most six, fewer if fewer belong, and an empty array if none \
do. Never invent a note that is not in the list.";

/// At most this many, however many come back. A suggestion list you have to
/// scroll is a second reading task, which is the opposite of the point.
const MAX_SUGGESTIONS: usize = 6;

/// Propose `[[links]]` from this note to others in the vault.
///
/// Candidates come from the caller because the vault already lives in the
/// frontend, and anything the model returns is checked against them — a link
/// to a note that does not exist is worse than no suggestion at all.
#[tauri::command]
pub async fn links_suggest(
    state: State<'_, AppState>,
    text: String,
    candidates: Vec<String>,
) -> Result<LinkSuggestions, AppError> {
    if candidates.is_empty() {
        return Ok(LinkSuggestions {
            suggestions: vec![],
            model_served: String::new(),
        });
    }
    let user = format!(
        "Notes that exist:\n{}\n\n---\n\nThe note:\n\n{}",
        candidates.join("\n"),
        clip(&text)
    );
    let out = run(&state, "links.suggest", LINKS_SYSTEM, &user, 800).await?;
    Ok(LinkSuggestions {
        suggestions: parse_suggestions(&out.text, &candidates),
        model_served: out.model_served,
    })
}

/// Pull suggestions out of a reply, keeping only the ones that are real.
///
/// Tolerant of the wrapping — a code fence or a line of preamble is a model
/// being chatty, not a failure — and strict about the content: a name that is
/// not in the candidate list is dropped, because it names a note that does not
/// exist.
fn parse_suggestions(reply: &str, candidates: &[String]) -> Vec<LinkSuggestion> {
    let Some(start) = reply.find('[') else {
        return vec![];
    };
    let Some(end) = reply.rfind(']') else {
        return vec![];
    };
    if end <= start {
        return vec![];
    }
    let parsed: Vec<LinkSuggestion> = match serde_json::from_str(&reply[start..=end]) {
        Ok(v) => v,
        Err(_) => return vec![],
    };

    // Case-insensitive, because a model that title-cases a name still means
    // the note that exists; the candidate's own spelling is what is kept.
    let mut seen = std::collections::HashSet::new();
    parsed
        .into_iter()
        .filter_map(|s| {
            let matched = candidates
                .iter()
                .find(|c| c.eq_ignore_ascii_case(s.name.trim()))?;
            if !seen.insert(matched.to_lowercase()) {
                return None;
            }
            Some(LinkSuggestion {
                name: matched.clone(),
                why: s.why.trim().to_string(),
            })
        })
        .take(MAX_SUGGESTIONS)
        .collect()
}

// ── configuration ───────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityStatus {
    pub key: String,
    pub display_name: String,
    pub implemented: bool,
    /// The registry's chain, shown as what "Reset" returns to.
    pub default_models: Vec<String>,
    /// What it will actually use right now.
    pub effective_models: Vec<String>,
    /// Whether that came from the registry or from a choice made here.
    pub chosen: bool,
}

/// Every capability and the model it will actually use.
#[tauri::command]
pub fn capability_status(state: State<'_, AppState>) -> Vec<CapabilityStatus> {
    registry::list()
        .into_iter()
        .map(|c| {
            let effective = profile::models_for(&state, &c.key);
            CapabilityStatus {
                chosen: effective != c.default_models,
                key: c.key,
                display_name: c.display_name,
                implemented: c.implemented,
                default_models: c.default_models,
                effective_models: effective,
            }
        })
        .collect()
}

/// Choose the model a capability runs on. An empty list resets it to the
/// registry's default rather than configuring it with nothing.
#[tauri::command]
pub fn capability_choose_models(
    state: State<'_, AppState>,
    capability: String,
    model_ids: Vec<String>,
) -> Result<(), AppError> {
    if registry::get(&capability).is_none() {
        return Err(AppError::NotFound("capability".into()));
    }
    let conn = state.db.lock().expect("db lock");
    if model_ids.is_empty() {
        conn.execute(
            "DELETE FROM capability_overrides WHERE capability = ?1",
            [&capability],
        )?;
        return Ok(());
    }
    conn.execute(
        "INSERT INTO capability_overrides (capability, model_ids_json, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(capability) DO UPDATE SET model_ids_json = ?2, updated_at = ?3",
        rusqlite::params![
            capability,
            serde_json::to_string(&model_ids).unwrap_or_else(|_| "[]".into()),
            crate::db::now_ms()
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidates() -> Vec<String> {
        vec![
            "Attention Is All You Need".to_string(),
            "Scaling Laws".to_string(),
            "Reading list".to_string(),
        ]
    }

    #[test]
    fn reads_a_plain_json_array() {
        let reply = r#"[{"name": "Scaling Laws", "why": "same compute-optimal argument"}]"#;
        let out = parse_suggestions(reply, &candidates());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "Scaling Laws");
        assert_eq!(out[0].why, "same compute-optimal argument");
    }

    #[test]
    fn survives_a_code_fence_and_a_line_of_preamble() {
        // Being chatty is not a failure; the answer is still in there.
        let reply = "Here are the links:\n```json\n[{\"name\":\"Scaling Laws\",\"why\":\"x\"}]\n```";
        assert_eq!(parse_suggestions(reply, &candidates()).len(), 1);
    }

    #[test]
    fn drops_notes_that_do_not_exist() {
        // The whole reason the candidate list is passed in: an invented link
        // creates a note the user never wrote.
        let reply = r#"[{"name":"A Note I Made Up","why":"related"},
                        {"name":"Scaling Laws","why":"real"}]"#;
        let out = parse_suggestions(reply, &candidates());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "Scaling Laws");
    }

    #[test]
    fn matches_loosely_but_keeps_the_vaults_spelling() {
        // A retitled name still means the note that exists, and the link has
        // to be written the way the file is named or it will not resolve.
        let reply = r#"[{"name":"scaling laws","why":"x"}]"#;
        let out = parse_suggestions(reply, &candidates());
        assert_eq!(out[0].name, "Scaling Laws");
    }

    #[test]
    fn does_not_suggest_the_same_note_twice() {
        let reply = r#"[{"name":"Scaling Laws","why":"a"},{"name":"Scaling Laws","why":"b"}]"#;
        assert_eq!(parse_suggestions(reply, &candidates()).len(), 1);
    }

    #[test]
    fn caps_the_list() {
        let many: Vec<String> = (0..20).map(|i| format!("Note {i}")).collect();
        let reply = serde_json::to_string(
            &many
                .iter()
                .map(|n| LinkSuggestion {
                    name: n.clone(),
                    why: "x".into(),
                })
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert_eq!(parse_suggestions(&reply, &many).len(), MAX_SUGGESTIONS);
    }

    #[test]
    fn a_reply_with_no_json_is_no_suggestions_not_an_error() {
        assert!(parse_suggestions("I could not find any related notes.", &candidates()).is_empty());
        assert!(parse_suggestions("", &candidates()).is_empty());
    }

    #[test]
    fn an_empty_array_is_a_valid_answer() {
        assert!(parse_suggestions("[]", &candidates()).is_empty());
    }

    #[test]
    fn cleanup_accepts_a_tidied_utterance() {
        let raw = "um so i think the the main thing is that we should ship it on friday you know";
        let cleaned = "So I think the main thing is that we should ship it on Friday.";
        assert!(plausible_cleanup(raw, cleaned));
    }

    #[test]
    fn cleanup_rejects_an_answer_to_the_dictation() {
        // The failure that matters: the model treats the transcript as a
        // prompt, and what you said is replaced by a reply to it.
        let raw = "what do you think we should do about the migration next week";
        let answer = "I think you should start by taking a backup, then run the migration in a \
            staging environment first, checking each table as it goes, and only then promote it \
            to production once the row counts match and the indexes have been rebuilt.";
        assert!(!plausible_cleanup(raw, answer));
    }

    #[test]
    fn cleanup_rejects_a_summary() {
        let raw = "so the meeting went well we talked about the budget and the timeline and \
            everyone agreed that we should push the launch back by two weeks to get the \
            testing done properly and then we discussed hiring for the new role";
        assert!(!plausible_cleanup(raw, "The meeting was productive."));
    }

    #[test]
    fn cleanup_rejects_nothing_at_all() {
        assert!(!plausible_cleanup("some dictated words here", ""));
    }

    #[test]
    fn cleanup_allows_short_utterances_to_shrink_a_lot() {
        // "um, yeah" → "Yeah." is a 60% cut and entirely correct.
        assert!(plausible_cleanup("um yeah", "Yeah."));
        assert!(plausible_cleanup("uh no i mean", "No, I mean —"));
    }
}
