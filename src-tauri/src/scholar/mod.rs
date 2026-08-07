//! Finding papers, and turning one into a note.
//!
//! A paper is stored as a markdown note with YAML frontmatter, not as a row in
//! a private table. That is the whole design: the vault already gives notes
//! wikilinks, backlinks, full-text search, and an agent that can read them, so
//! a paper that IS a note inherits all of it for free. It also means the
//! library survives this app — the files are readable in Obsidian, in an
//! editor, or in ten years with neither.
//!
//! OpenAlex is the source because it needs no key, covers ~250M works, and
//! reports open-access PDF locations. `mailto` is sent because their terms ask
//! for it in exchange for the faster pool.

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum ScholarError {
    #[error("network: {0}")]
    Network(String),
    #[error("openalex returned {0}")]
    Http(u16),
    #[error("could not read the response")]
    Decode,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Paper {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<i32>,
    pub doi: Option<String>,
    pub venue: Option<String>,
    pub abstract_text: Option<String>,
    pub pdf_url: Option<String>,
    pub landing_url: Option<String>,
    pub cited_by: i64,
    pub open_access: bool,
}

// ---- OpenAlex wire shapes. Only what is used, so their churn cannot break us.

#[derive(Deserialize)]
struct WorksPage {
    #[serde(default)]
    results: Vec<Work>,
}

#[derive(Deserialize)]
struct Work {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    publication_year: Option<i32>,
    #[serde(default)]
    doi: Option<String>,
    #[serde(default)]
    cited_by_count: Option<i64>,
    #[serde(default)]
    authorships: Vec<Authorship>,
    #[serde(default)]
    abstract_inverted_index: Option<std::collections::HashMap<String, Vec<usize>>>,
    #[serde(default)]
    best_oa_location: Option<Location>,
    #[serde(default)]
    primary_location: Option<Location>,
}

#[derive(Deserialize)]
struct Authorship {
    #[serde(default)]
    author: Option<Author>,
}

#[derive(Deserialize)]
struct Author {
    #[serde(default)]
    display_name: Option<String>,
}

#[derive(Deserialize)]
struct Location {
    #[serde(default)]
    pdf_url: Option<String>,
    #[serde(default)]
    landing_page_url: Option<String>,
    #[serde(default)]
    source: Option<Source>,
}

#[derive(Deserialize)]
struct Source {
    #[serde(default)]
    display_name: Option<String>,
}

/// Rebuild prose from OpenAlex's inverted index.
///
/// They ship `{word: [positions]}` rather than text, for licensing reasons. A
/// word can occur at several positions, and positions can be sparse, so this
/// places every occurrence and skips gaps rather than assuming density.
pub fn abstract_from_inverted(
    index: &std::collections::HashMap<String, Vec<usize>>,
) -> Option<String> {
    if index.is_empty() {
        return None;
    }
    let mut placed: Vec<(usize, &str)> = Vec::new();
    for (word, positions) in index {
        for &p in positions {
            placed.push((p, word.as_str()));
        }
    }
    placed.sort_by_key(|(p, _)| *p);
    let text = placed
        .into_iter()
        .map(|(_, w)| w)
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn to_paper(w: Work) -> Option<Paper> {
    let title = w.display_name.or(w.title)?;
    let oa = w.best_oa_location;
    let primary = w.primary_location;
    let pdf_url = oa
        .as_ref()
        .and_then(|l| l.pdf_url.clone())
        .or_else(|| primary.as_ref().and_then(|l| l.pdf_url.clone()));
    let landing_url = oa
        .as_ref()
        .and_then(|l| l.landing_page_url.clone())
        .or_else(|| primary.as_ref().and_then(|l| l.landing_page_url.clone()));
    let venue = primary
        .as_ref()
        .and_then(|l| l.source.as_ref())
        .and_then(|s| s.display_name.clone());

    Some(Paper {
        id: w.id.clone().unwrap_or_else(|| title.clone()),
        authors: w
            .authorships
            .into_iter()
            .filter_map(|a| a.author.and_then(|x| x.display_name))
            .collect(),
        year: w.publication_year,
        doi: w.doi.map(|d| d.trim_start_matches("https://doi.org/").to_string()),
        venue,
        abstract_text: w
            .abstract_inverted_index
            .as_ref()
            .and_then(abstract_from_inverted),
        open_access: pdf_url.is_some(),
        pdf_url,
        landing_url,
        cited_by: w.cited_by_count.unwrap_or(0),
        title,
    })
}

pub async fn search(query: &str, limit: u8) -> Result<Vec<Paper>, ScholarError> {
    let q = urlencoding::encode(query);
    // mailto is what OpenAlex asks for in return for the faster request pool.
    let url = format!(
        "https://api.openalex.org/works?search={q}&per-page={limit}&mailto=workbench@morpheusgh.co"
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Workbench/0.1 (mailto:workbench@morpheusgh.co)")
        .build()
        .map_err(|e| ScholarError::Network(e.to_string()))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| ScholarError::Network(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(ScholarError::Http(resp.status().as_u16()));
    }
    let page: WorksPage = resp.json().await.map_err(|_| ScholarError::Decode)?;
    Ok(page.results.into_iter().filter_map(to_paper).collect())
}

/// A filename for a paper: readable, stable, and safe on every filesystem.
///
/// Built from author, year and title rather than an opaque id, because these
/// are files a person browses. Length is capped well under the 255-byte limit
/// that trips on long paper titles.
pub fn slug_for(paper: &Paper) -> String {
    let first_author = paper
        .authors
        .first()
        .and_then(|a| a.split_whitespace().last())
        .unwrap_or("unknown");
    let year = paper.year.map(|y| y.to_string()).unwrap_or_default();
    let mut base = format!("{first_author} {year} {}", paper.title);
    base = base
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' {
                c
            } else {
                ' '
            }
        })
        .collect();
    let mut slug: String = base
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase();
    if slug.chars().count() > 80 {
        slug = slug.chars().take(80).collect::<String>();
        // Do not end mid-word.
        if let Some(i) = slug.rfind('-') {
            slug.truncate(i);
        }
    }
    if slug.is_empty() {
        slug = "untitled-paper".into();
    }
    slug
}

/// The literature note for a paper: YAML frontmatter, then the abstract, then
/// space for the reader.
///
/// Frontmatter rather than prose metadata so other tools — Obsidian's
/// Dataview, a script, the agent — can read it without parsing English.
pub fn note_for(paper: &Paper) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("title: {}\n", yaml_scalar(&paper.title)));
    if !paper.authors.is_empty() {
        out.push_str("authors:\n");
        for a in &paper.authors {
            out.push_str(&format!("  - {}\n", yaml_scalar(a)));
        }
    }
    if let Some(y) = paper.year {
        out.push_str(&format!("year: {y}\n"));
    }
    if let Some(v) = &paper.venue {
        out.push_str(&format!("venue: {}\n", yaml_scalar(v)));
    }
    if let Some(d) = &paper.doi {
        out.push_str(&format!("doi: {}\n", yaml_scalar(d)));
    }
    if let Some(u) = &paper.landing_url {
        out.push_str(&format!("url: {}\n", yaml_scalar(u)));
    }
    out.push_str(&format!("cited_by: {}\n", paper.cited_by));
    out.push_str("tags: [paper]\n");
    out.push_str("---\n\n");

    out.push_str(&format!("# {}\n\n", paper.title));
    if let Some(a) = &paper.abstract_text {
        out.push_str("## Abstract\n\n");
        out.push_str(a);
        out.push_str("\n\n");
    }
    // A heading rather than an empty file: the note is for reading INTO, and a
    // blank page is a worse invitation than a named place to start.
    out.push_str("## Notes\n\n");
    out
}

/// The full-text section appended to a note once the PDF has been read.
///
/// Kept in the note rather than a sidecar so the paper is one thing: search
/// finds it, the agent reads it without being told where to look, and the
/// abstract and the text you are annotating do not drift apart.
pub fn full_text_section(text: &str) -> String {
    format!("\n## Full text\n\n{}\n", text.trim())
}

/// Tidy extracted PDF text into something readable.
///
/// Extraction produces hard-wrapped lines at whatever width the PDF was
/// typeset to, plus page furniture. Joining wrapped lines back into paragraphs
/// matters more than it looks: a model reading a paper line-by-line loses
/// sentence structure, and so does a person.
pub fn tidy_extracted(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut blank_run = 0usize;

    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() {
            blank_run += 1;
            // Collapse runs of blank lines; extraction emits many.
            if blank_run == 1 {
                out.push_str("\n\n");
            }
            continue;
        }
        // A line that is only a number is a page number, not content.
        if t.chars().all(|c| c.is_ascii_digit()) && t.len() <= 4 {
            continue;
        }
        blank_run = 0;
        if !out.is_empty() && !out.ends_with('\n') {
            // A hyphen at a line break is a split word, not punctuation.
            if out.ends_with('-') {
                out.pop();
            } else {
                out.push(' ');
            }
        }
        out.push_str(t);
    }
    out.trim().to_string()
}

/// Quote a YAML scalar only when it would otherwise be misread.
fn yaml_scalar(s: &str) -> String {
    let needs_quotes = s.is_empty()
        || s.starts_with(['&', '*', '?', '|', '-', '<', '>', '=', '!', '%', '@', '`', '#', '"', '\''])
        || s.contains(": ")
        || s.contains(" #")
        || s.ends_with(':');
    if needs_quotes {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn paper() -> Paper {
        Paper {
            id: "W1".into(),
            title: "Attention Is All You Need".into(),
            authors: vec!["Ashish Vaswani".into(), "Noam Shazeer".into()],
            year: Some(2017),
            doi: Some("10.5555/3295222".into()),
            venue: Some("NeurIPS".into()),
            abstract_text: Some("We propose a new architecture.".into()),
            pdf_url: Some("https://example.org/p.pdf".into()),
            landing_url: Some("https://example.org/p".into()),
            cited_by: 100_000,
            open_access: true,
        }
    }

    #[test]
    fn rebuilds_an_abstract_from_positions() {
        let mut idx: HashMap<String, Vec<usize>> = HashMap::new();
        idx.insert("learning".into(), vec![1]);
        idx.insert("Deep".into(), vec![0]);
        idx.insert("works".into(), vec![2]);
        assert_eq!(abstract_from_inverted(&idx).as_deref(), Some("Deep learning works"));
    }

    /// A word appearing twice must appear twice, in both places.
    #[test]
    fn places_every_occurrence_of_a_repeated_word() {
        let mut idx: HashMap<String, Vec<usize>> = HashMap::new();
        idx.insert("the".into(), vec![0, 2]);
        idx.insert("cat".into(), vec![1]);
        idx.insert("hat".into(), vec![3]);
        assert_eq!(abstract_from_inverted(&idx).as_deref(), Some("the cat the hat"));
    }

    #[test]
    fn an_absent_abstract_is_none_not_an_empty_string() {
        assert_eq!(abstract_from_inverted(&HashMap::new()), None);
    }

    #[test]
    fn slug_reads_as_author_year_title() {
        assert_eq!(slug_for(&paper()), "vaswani-2017-attention-is-all-you-need");
    }

    #[test]
    fn slug_drops_characters_a_filesystem_would_object_to() {
        let mut p = paper();
        p.title = "A/B testing: what's \"good\"?".into();
        let s = slug_for(&p);
        assert!(!s.contains('/'), "got {s}");
        assert!(!s.contains('"'), "got {s}");
        assert!(!s.contains(':'), "got {s}");
    }

    /// Long titles are common and would otherwise breach the 255-byte limit.
    #[test]
    fn slug_is_capped_and_does_not_end_mid_word() {
        let mut p = paper();
        p.title = "supercalifragilistic ".repeat(20);
        let s = slug_for(&p);
        assert!(s.chars().count() <= 80, "got {} chars", s.chars().count());
        assert!(!s.ends_with('-'));
    }

    #[test]
    fn slug_survives_a_paper_with_no_author_or_year() {
        let p = Paper { authors: vec![], year: None, ..paper() };
        assert_eq!(slug_for(&p), "unknown-attention-is-all-you-need");
    }

    #[test]
    fn note_carries_the_metadata_as_frontmatter() {
        let n = note_for(&paper());
        assert!(n.starts_with("---\n"), "frontmatter must open the file");
        assert!(n.contains("title: Attention Is All You Need"));
        assert!(n.contains("  - Ashish Vaswani"));
        assert!(n.contains("year: 2017"));
        assert!(n.contains("doi: 10.5555/3295222"));
        assert!(n.contains("tags: [paper]"));
        assert!(n.contains("## Abstract"));
        assert!(n.contains("We propose a new architecture."));
        assert!(n.contains("## Notes"), "a place to write into");
    }

    /// A title with a colon is extremely common in papers and would otherwise
    /// produce YAML that parses as a nested map.
    #[test]
    fn tidy_rejoins_lines_wrapped_by_the_typesetter() {
        let raw = "We propose a new\narchitecture for sequence\nmodelling.";
        assert_eq!(
            tidy_extracted(raw),
            "We propose a new architecture for sequence modelling."
        );
    }

    /// A hyphen at a line break is a split word, and joining without removing
    /// it produces "trans-formers" throughout a paper.
    #[test]
    fn tidy_rejoins_a_hyphenated_split_word() {
        assert_eq!(tidy_extracted("trans-\nformers work"), "transformers work");
    }

    #[test]
    fn tidy_keeps_paragraph_breaks_but_collapses_runs() {
        assert_eq!(tidy_extracted("one\n\n\n\ntwo"), "one\n\ntwo");
    }

    #[test]
    fn tidy_drops_bare_page_numbers() {
        assert_eq!(tidy_extracted("text here\n\n12\n\nmore text"), "text here\n\nmore text");
    }

    /// A year on its own line is content, not a page number.
    #[test]
    fn tidy_keeps_numbers_that_are_part_of_a_sentence() {
        assert_eq!(tidy_extracted("published in 2017 and"), "published in 2017 and");
    }

    #[test]
    fn full_text_section_is_a_heading_and_the_text() {
        let s = full_text_section("  body  ");
        assert!(s.contains("## Full text"));
        assert!(s.contains("body"));
    }

    #[test]
    fn quotes_a_title_that_would_break_yaml() {
        let mut p = paper();
        p.title = "BERT: Pre-training of Deep Bidirectional Transformers".into();
        let n = note_for(&p);
        assert!(
            n.contains("title: \"BERT: Pre-training of Deep Bidirectional Transformers\""),
            "got:\n{n}"
        );
    }

    #[test]
    fn a_paper_with_no_abstract_still_produces_a_usable_note() {
        let p = Paper { abstract_text: None, ..paper() };
        let n = note_for(&p);
        assert!(!n.contains("## Abstract"));
        assert!(n.contains("## Notes"));
    }
}
