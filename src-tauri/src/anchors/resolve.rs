use super::{AnchorFingerprint, AnchorStatus, ResolvedAnchor};

/// Find all byte offsets of `needle` in `haystack`.
fn find_all(haystack: &str, needle: &str) -> Vec<usize> {
    if needle.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut start = 0;
    while let Some(pos) = haystack[start..].find(needle) {
        let abs = start + pos;
        out.push(abs);
        start = abs + 1;
        if start >= haystack.len() {
            break;
        }
    }
    out
}

/// Trigram Dice coefficient, 0.0–1.0.
///
/// Deliberately NOT character-LCS: on prose, two unrelated English sentences
/// share enough letters and spaces to score ~0.5 by LCS, which would make
/// "whole file rewritten" look like a match. Trigrams capture local ordering,
/// so unrelated text scores near zero while a lightly edited span stays high.
fn similarity(a: &str, b: &str) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    fn trigrams(s: &str) -> std::collections::HashMap<[char; 3], usize> {
        let chars: Vec<char> = s.chars().collect();
        let mut map: std::collections::HashMap<[char; 3], usize> = Default::default();
        for w in chars.windows(3) {
            *map.entry([w[0], w[1], w[2]]).or_default() += 1;
        }
        map
    }
    let (ta, tb) = (trigrams(a), trigrams(b));
    if ta.is_empty() || tb.is_empty() {
        // Too short for trigrams: fall back to exact equality.
        return if a == b { 1.0 } else { 0.0 };
    }
    let shared: usize = ta
        .iter()
        .map(|(k, count)| tb.get(k).copied().unwrap_or(0).min(*count))
        .sum();
    let total: usize = ta.values().sum::<usize>() + tb.values().sum::<usize>();
    (2.0 * shared as f32) / total as f32
}

/// Fraction of the shorter string that the two share as a leading run.
fn common_prefix_ratio(a: &str, b: &str) -> f32 {
    let n = a
        .chars()
        .zip(b.chars())
        .take_while(|(x, y)| x == y)
        .count();
    let denom = a.chars().count().min(b.chars().count()).max(1);
    (n as f32 / denom as f32).min(1.0)
}

/// Candidate offsets for the fuzzy stage: places where the head or tail of the
/// original span still appears (handles "edited in the middle"), plus a coarse
/// window around the position hint.
fn fuzzy_candidates(content: &str, exact: &str, hint: usize) -> Vec<usize> {
    let mut out = Vec::new();
    // Several head/tail lengths: a short head still matches when the span was
    // edited early ("is durable" → "is quite durable"), a long one is more
    // selective when it survives.
    for len in [12usize, 24, 40] {
        let head_len = super::ceil_boundary(exact, len.min(exact.len()));
        if head_len > 3 {
            out.extend(find_all(content, &exact[..head_len]));
        }
        let tail_start = super::floor_boundary(exact, exact.len().saturating_sub(len));
        if exact.len() - tail_start > 3 {
            for pos in find_all(content, &exact[tail_start..]) {
                out.push(pos.saturating_sub(tail_start));
            }
        }
    }
    let radius = (exact.len() * 4).max(1500);
    let lo = hint.saturating_sub(radius);
    let hi = (hint + radius).min(content.len());
    let step = (exact.len() / 6).max(8);
    let mut i = lo;
    while i < hi {
        out.push(i);
        i += step;
    }
    out.sort_unstable();
    out.dedup();
    out
}

fn nearest(candidates: &[usize], hint: usize) -> usize {
    *candidates
        .iter()
        .min_by_key(|c| c.abs_diff(hint))
        .expect("non-empty")
}

pub fn resolve(fp: &AnchorFingerprint, content: &str, current_hash: &str) -> ResolvedAnchor {
    let original_text = fp.exact_text.clone();
    let make = |status, from: usize, to: usize, confidence| ResolvedAnchor {
        status,
        from,
        to,
        confidence,
        original_text: original_text.clone(),
    };

    // 1. File unchanged → the hint is exact.
    if current_hash == fp.file_hash_at_create && fp.hint_to <= content.len() {
        return make(AnchorStatus::Ok, fp.hint_from, fp.hint_to, 1.0);
    }

    if fp.exact_text.is_empty() {
        return make(AnchorStatus::Broken, 0, 0, 0.0);
    }

    // 2. Unique match with surrounding context.
    let with_context = format!("{}{}{}", fp.prefix_text, fp.exact_text, fp.suffix_text);
    let ctx_hits = find_all(content, &with_context);
    if ctx_hits.len() == 1 {
        let from = ctx_hits[0] + fp.prefix_text.len();
        return make(AnchorStatus::Ok, from, from + fp.exact_text.len(), 0.95);
    }

    // 3./4. Match the exact span alone.
    let hits = find_all(content, &fp.exact_text);
    match hits.len() {
        1 => {
            let from = hits[0];
            return make(AnchorStatus::Ok, from, from + fp.exact_text.len(), 0.9);
        }
        0 => {}
        _ => {
            // Ambiguous: several identical spans. Take the nearest to the hint
            // but report STALE — a confident wrong answer is worse than a
            // flagged uncertain one.
            let from = nearest(&hits, fp.hint_from);
            return make(AnchorStatus::Stale, from, from + fp.exact_text.len(), 0.6);
        }
    }

    // 5. Fuzzy: score candidate offsets and keep the best.
    let target_len = fp.exact_text.len();
    if target_len == 0 || content.is_empty() {
        return make(AnchorStatus::Broken, 0, 0, 0.0);
    }

    let mut best = (0.0f32, 0usize);
    for cand in fuzzy_candidates(content, &fp.exact_text, fp.hint_from) {
        let start = super::floor_boundary(content, cand);
        let end = super::ceil_boundary(content, (start + target_len).min(content.len()));
        if end <= start {
            continue;
        }
        let window = &content[start..end];
        // Trigram similarity is alignment-blind: a window straddling the target
        // can outscore the correctly-aligned one. Weighting in how much of the
        // opening text agrees makes the aligned candidate win, which is what
        // makes the resolved range usable rather than merely nearby.
        let score = 0.85 * similarity(&fp.exact_text, window)
            + 0.15 * common_prefix_ratio(&fp.exact_text, window);
        if score > best.0 {
            best = (score, start);
        }
    }

    // 0.6 on trigram Dice means genuinely similar text, not incidental letter
    // overlap. Below that we say broken rather than point somewhere wrong.
    const FUZZY_FLOOR: f32 = 0.6;
    if best.0 >= FUZZY_FLOOR {
        let from = best.1;
        let to = super::ceil_boundary(content, (from + target_len).min(content.len()));
        return make(AnchorStatus::Stale, from, to, best.0.min(0.85));
    }

    make(AnchorStatus::Broken, 0, 0, best.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anchors::fingerprint;

    const DOC: &str = "# Anchors\n\nLine numbers are fragile.\nContent hashing is durable.\nThe ladder degrades gracefully.\n";

    fn fp_for(doc: &str, needle: &str, hash: &str) -> AnchorFingerprint {
        let from = doc.find(needle).expect("needle present");
        fingerprint(doc, from, from + needle.len(), hash)
    }

    #[test]
    fn unchanged_file_resolves_exactly() {
        let fp = fp_for(DOC, "Content hashing is durable.", "h1");
        let r = resolve(&fp, DOC, "h1");
        assert_eq!(r.status, AnchorStatus::Ok);
        assert_eq!(r.confidence, 1.0);
        assert_eq!(&DOC[r.from..r.to], "Content hashing is durable.");
    }

    #[test]
    fn insertion_above_target_still_resolves_ok() {
        let fp = fp_for(DOC, "Content hashing is durable.", "h1");
        let edited = DOC.replace("# Anchors\n", "# Anchors\n\nA new intro paragraph.\nAnd more.\n");
        let r = resolve(&fp, &edited, "h2");
        assert_eq!(r.status, AnchorStatus::Ok);
        assert!(r.confidence >= 0.9);
        assert_eq!(&edited[r.from..r.to], "Content hashing is durable.");
    }

    #[test]
    fn surrounding_context_disambiguates_a_duplicate() {
        // The span itself appears twice, but only one copy has the original
        // neighbours — context resolves it confidently and correctly.
        let fp = fp_for(DOC, "Content hashing is durable.", "h1");
        let dup = format!("Content hashing is durable.\n{DOC}");
        let r = resolve(&fp, &dup, "h2");
        assert_eq!(r.status, AnchorStatus::Ok);
        assert_eq!(&dup[r.from..r.to], "Content hashing is durable.");
        assert!(r.from > 0, "matched the copy with the original context");
    }

    #[test]
    fn genuinely_ambiguous_text_resolves_stale_not_confidently_wrong() {
        // A repeated boilerplate block longer than the context window on both
        // sides: nothing can disambiguate, so this must be reported rather
        // than guessed at.
        let pad_a = "boilerplate header line that repeats verbatim in both blocks\n".repeat(2);
        let pad_b = "boilerplate footer line that repeats verbatim in both blocks\n".repeat(2);
        let block = format!("{pad_a}Content hashing is durable.\n{pad_b}");
        let doc = format!("{block}\n---\n{block}");

        let from = doc.find("Content hashing is durable.").unwrap();
        let fp = fingerprint(&doc, from, from + "Content hashing is durable.".len(), "h1");
        let r = resolve(&fp, &doc, "h2");

        assert_eq!(r.status, AnchorStatus::Stale, "ambiguity must be reported");
        assert!(r.confidence < 0.9);
        assert_eq!(&doc[r.from..r.to], "Content hashing is durable.");
    }

    #[test]
    fn lightly_edited_target_resolves_stale_with_position() {
        let fp = fp_for(DOC, "Content hashing is durable.", "h1");
        let edited = DOC.replace(
            "Content hashing is durable.",
            "Content hashing is quite durable.",
        );
        let r = resolve(&fp, &edited, "h2");
        assert_ne!(r.status, AnchorStatus::Broken);
        assert!(r.confidence >= 0.5);
        assert!(
            edited[r.from..].starts_with("Content hashing"),
            "landed at {} ({:?}, conf {}): {:?}",
            r.from,
            r.status,
            r.confidence,
            &edited[r.from..(r.from + 30).min(edited.len())]
        );
    }

    #[test]
    fn deleted_target_is_broken_and_keeps_original_text() {
        let fp = fp_for(DOC, "Content hashing is durable.", "h1");
        let edited = DOC.replace("Content hashing is durable.\n", "");
        let r = resolve(&fp, &edited, "h2");
        assert_eq!(r.status, AnchorStatus::Broken);
        // The UI can still show what the link pointed at.
        assert_eq!(r.original_text, "Content hashing is durable.");
    }

    #[test]
    fn whole_file_rewrite_is_broken_not_random() {
        let fp = fp_for(DOC, "Content hashing is durable.", "h1");
        let r = resolve(&fp, "completely different content, nothing alike here", "h2");
        assert_eq!(r.status, AnchorStatus::Broken);
    }

    #[test]
    fn multibyte_content_never_panics() {
        let doc = "café — naïve — 日本語のテキスト — emoji 🦀 here\n";
        let needle = "naïve";
        let from = doc.find(needle).unwrap();
        let fp = fingerprint(doc, from, from + needle.len(), "h1");
        let r = resolve(&fp, doc, "h1");
        assert_eq!(&doc[r.from..r.to], needle);
        // And after an edit that shifts everything.
        let edited = format!("prefix 🎉 added\n{doc}");
        let r2 = resolve(&fp, &edited, "h2");
        assert_eq!(&edited[r2.from..r2.to], needle);
    }

    #[test]
    fn code_range_survives_refactor_above() {
        let code = "use std::fs;\n\nfn helper() {}\n\nfn target(a: u32) -> u32 {\n    a * 2\n}\n";
        let needle = "fn target(a: u32) -> u32 {\n    a * 2\n}";
        let from = code.find(needle).unwrap();
        let fp = fingerprint(code, from, from + needle.len(), "h1");

        let edited = code.replace(
            "fn helper() {}",
            "fn helper() {}\n\nfn another_helper(x: &str) -> usize {\n    x.len()\n}",
        );
        let r = resolve(&fp, &edited, "h2");
        assert_eq!(r.status, AnchorStatus::Ok);
        assert_eq!(&edited[r.from..r.to], needle);
    }
}
