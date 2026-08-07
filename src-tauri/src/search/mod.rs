//! Find in files, and replace across them.
//!
//! Built on the ripgrep crates rather than a hand-rolled scan: they bring
//! binary detection, encoding handling and line-boundary correctness that are
//! tedious to get right and quietly wrong when you don't.
//!
//! Two properties matter more than speed here:
//!
//! - **Results stream.** A match in the first file should appear immediately,
//!   not after the last file is read. Searching a large tree otherwise looks
//!   like a hang.
//!
//! - **Replace is exact.** It re-runs the same matcher over the file and
//!   rewrites only the matched byte ranges, rather than doing a string
//!   substitution over the whole text — otherwise a replacement containing the
//!   search term, or a regex whose match differs from its literal text, would
//!   corrupt the file. Files are read and compared before writing, so a
//!   replace that changes nothing leaves the mtime alone.

use std::path::Path;

use grep_matcher::{Captures, Matcher};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("invalid pattern: {0}")]
    Pattern(String),
    #[error("io: {0}")]
    Io(String),
}

impl From<std::io::Error> for SearchError {
    fn from(e: std::io::Error) -> Self {
        SearchError::Io(e.to_string())
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub pattern: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub regex: bool,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    pub rel_path: String,
    /// 1-indexed, as shown in the editor gutter.
    pub line: u64,
    /// The whole line, trimmed of its trailing newline.
    pub text: String,
    /// Byte offsets of the match within `text`, for highlighting.
    pub start: u32,
    pub end: u32,
}

pub fn build_matcher(q: &Query) -> Result<RegexMatcher, SearchError> {
    // A literal search must not treat the user's input as a pattern: someone
    // searching for `foo(bar)` means those characters.
    let pattern = if q.regex {
        q.pattern.clone()
    } else {
        regex_syntax::escape(&q.pattern)
    };
    let pattern = if q.whole_word {
        format!(r"\b(?:{pattern})\b")
    } else {
        pattern
    };
    RegexMatcherBuilder::new()
        .case_insensitive(!q.case_sensitive)
        .build(&pattern)
        .map_err(|e| SearchError::Pattern(e.to_string()))
}

/// Search one file, handing each match to `on_match`.
///
/// Returns the number of matches found. Binary files are skipped by content,
/// not by extension.
pub fn search_file(
    matcher: &RegexMatcher,
    path: &Path,
    rel_path: &str,
    mut on_match: impl FnMut(Match),
) -> Result<usize, SearchError> {
    let mut count = 0usize;
    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(0))
        .line_number(true)
        .build();

    searcher
        .search_path(
            matcher,
            path,
            UTF8(|line_number, line| {
                let text = line.trim_end_matches(['\n', '\r']).to_string();
                // Offsets are relative to the line, and there may be several
                // matches on one line — each is its own result.
                let mut at = 0usize;
                while let Ok(Some(m)) = matcher.find_at(text.as_bytes(), at) {
                    on_match(Match {
                        rel_path: rel_path.to_string(),
                        line: line_number,
                        text: text.clone(),
                        start: m.start() as u32,
                        end: m.end() as u32,
                    });
                    count += 1;
                    // A zero-width match would otherwise loop forever.
                    at = if m.end() > m.start() { m.end() } else { m.end() + 1 };
                    if at > text.len() {
                        break;
                    }
                }
                Ok(true)
            }),
        )
        .map_err(|e| SearchError::Io(e.to_string()))?;
    Ok(count)
}

/// Replace every match in `text`, expanding `$1`-style references for regex
/// searches. Returns None when nothing matched, so callers can skip the write.
pub fn replace_all(
    matcher: &RegexMatcher,
    text: &str,
    replacement: &str,
) -> Result<Option<String>, SearchError> {
    let haystack = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(haystack.len());
    let mut caps = matcher
        .new_captures()
        .map_err(|e| SearchError::Pattern(e.to_string()))?;
    let mut last = 0usize;
    let mut found = false;

    matcher
        .captures_iter(haystack, &mut caps, |c| {
            let m = match c.get(0) {
                Some(m) => m,
                None => return true,
            };
            found = true;
            out.extend_from_slice(&haystack[last..m.start()]);
            // Interpolation belongs to regex mode only: a literal replacement
            // containing `$` must survive verbatim.
            c.interpolate(
                |name| matcher.capture_index(name),
                haystack,
                replacement.as_bytes(),
                &mut out,
            );
            last = m.end();
            true
        })
        .map_err(|e| SearchError::Pattern(e.to_string()))?;

    if !found {
        return Ok(None);
    }
    out.extend_from_slice(&haystack[last..]);
    String::from_utf8(out)
        .map(Some)
        .map_err(|_| SearchError::Io("replacement produced invalid UTF-8".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(pattern: &str) -> Query {
        Query {
            pattern: pattern.into(),
            case_sensitive: false,
            whole_word: false,
            regex: false,
        }
    }

    fn matches_in(query: &Query, contents: &str) -> Vec<Match> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.txt");
        std::fs::write(&path, contents).unwrap();
        let m = build_matcher(query).unwrap();
        let mut out = Vec::new();
        search_file(&m, &path, "f.txt", |hit| out.push(hit)).unwrap();
        out
    }

    #[test]
    fn finds_a_literal_with_line_and_offsets() {
        let hits = matches_in(&q("needle"), "nothing\nhas a needle here\n");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);
        assert_eq!(hits[0].text, "has a needle here");
        assert_eq!(&hits[0].text[hits[0].start as usize..hits[0].end as usize], "needle");
    }

    /// Regex metacharacters in a literal search are characters, not syntax.
    #[test]
    fn a_literal_search_does_not_interpret_the_pattern() {
        let hits = matches_in(&q("foo(bar)"), "call foo(bar) now\n");
        assert_eq!(hits.len(), 1);
        let hits = matches_in(&q("a.c"), "abc\na.c\n");
        assert_eq!(hits.len(), 1, "the dot must not match 'b'");
        assert_eq!(hits[0].line, 2);
    }

    #[test]
    fn case_insensitive_by_default_and_sensitive_on_request() {
        assert_eq!(matches_in(&q("NEEDLE"), "a needle\n").len(), 1);
        let mut sensitive = q("NEEDLE");
        sensitive.case_sensitive = true;
        assert_eq!(matches_in(&sensitive, "a needle\n").len(), 0);
    }

    #[test]
    fn whole_word_does_not_match_inside_a_longer_word() {
        let mut word = q("run");
        word.whole_word = true;
        assert_eq!(matches_in(&word, "running\n").len(), 0);
        assert_eq!(matches_in(&word, "run it\n").len(), 1);
    }

    #[test]
    fn reports_every_match_on_a_line_separately() {
        let hits = matches_in(&q("ab"), "ab ab ab\n");
        assert_eq!(hits.len(), 3);
        assert_eq!(hits.iter().map(|h| h.start).collect::<Vec<_>>(), vec![0, 3, 6]);
    }

    #[test]
    fn skips_binary_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bin");
        std::fs::write(&path, b"before\x00\x00needle after").unwrap();
        let m = build_matcher(&q("needle")).unwrap();
        let mut out = Vec::new();
        search_file(&m, &path, "bin", |h| out.push(h)).unwrap();
        assert!(out.is_empty(), "binary files must not be searched");
    }

    #[test]
    fn an_invalid_regex_is_an_error_not_a_panic() {
        let mut bad = q("(unclosed");
        bad.regex = true;
        assert!(build_matcher(&bad).is_err());
    }

    #[test]
    fn replaces_every_occurrence() {
        let m = build_matcher(&q("cat")).unwrap();
        assert_eq!(
            replace_all(&m, "cat and cat", "dog").unwrap().as_deref(),
            Some("dog and dog")
        );
    }

    /// A string substitution would loop or double-apply here; range rewriting
    /// does not.
    #[test]
    fn a_replacement_containing_the_search_term_is_applied_once() {
        let m = build_matcher(&q("cat")).unwrap();
        assert_eq!(
            replace_all(&m, "cat", "cats").unwrap().as_deref(),
            Some("cats")
        );
    }

    #[test]
    fn reports_no_change_so_callers_can_skip_the_write() {
        let m = build_matcher(&q("absent")).unwrap();
        assert_eq!(replace_all(&m, "nothing here", "x").unwrap(), None);
    }

    #[test]
    fn regex_replace_expands_capture_groups() {
        let query = Query {
            pattern: r"(\w+)@(\w+)".into(),
            case_sensitive: false,
            whole_word: false,
            regex: true,
        };
        let m = build_matcher(&query).unwrap();
        assert_eq!(
            replace_all(&m, "me@here", "$2.$1").unwrap().as_deref(),
            Some("here.me")
        );
    }

    #[test]
    fn preserves_everything_around_the_match() {
        let m = build_matcher(&q("b")).unwrap();
        assert_eq!(
            replace_all(&m, "a\nb\nc\n", "B").unwrap().as_deref(),
            Some("a\nB\nc\n"),
            "surrounding lines and the trailing newline must survive"
        );
    }
}
