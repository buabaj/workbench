import { describe, expect, it } from "vitest";
import {
  appendAnnotation,
  findQuoteSpans,
  findQuoteStart,
  parseAnnotations,
  renderAnnotation,
} from "./annotations";

const NOTE = `---
title: A Paper
---

# A Paper

## Abstract

Some abstract.

## Notes

My thoughts.
`;

describe("appendAnnotation", () => {
  it("creates the section when the note has none", () => {
    const out = appendAnnotation(NOTE, { page: 4, quote: "a passage", comment: "why it matters" });
    expect(out).toContain("## Annotations");
    expect(out).toContain('### p.4 — "a passage"');
    expect(out).toContain("why it matters");
    // The rest of the note survives.
    expect(out).toContain("## Abstract");
    expect(out).toContain("My thoughts.");
  });

  it("appends to an existing section in reading order", () => {
    const one = appendAnnotation(NOTE, { page: 1, quote: "first", comment: "a" });
    const two = appendAnnotation(one, { page: 9, quote: "second", comment: "b" });
    expect(two.indexOf("first")).toBeLessThan(two.indexOf("second"));
    expect(two.match(/## Annotations/g)).toHaveLength(1);
  });

  /** A section that follows must not be absorbed into the annotations. */
  it("keeps a following section intact", () => {
    const withFull = `${NOTE}\n## Annotations\n\n### p.1 — "x"\n\nnote\n\n## Full text\n\nbody here\n`;
    const out = appendAnnotation(withFull, { page: 2, quote: "y", comment: "second" });
    expect(out).toContain("## Full text");
    expect(out.indexOf("second")).toBeLessThan(out.indexOf("## Full text"));
    expect(out).toContain("body here");
  });
});

describe("parseAnnotations", () => {
  it("round-trips what append wrote", () => {
    let n = NOTE;
    n = appendAnnotation(n, { page: 3, quote: "alpha", comment: "first thought" });
    n = appendAnnotation(n, { page: 7, quote: "beta", comment: "second thought" });
    expect(parseAnnotations(n)).toEqual([
      { page: 3, quote: "alpha", comment: "first thought" },
      { page: 7, quote: "beta", comment: "second thought" },
    ]);
  });

  it("is empty for a note with no annotations", () => {
    expect(parseAnnotations(NOTE)).toEqual([]);
  });

  it("does not read the following section as a comment", () => {
    const n = `${NOTE}\n## Annotations\n\n### p.1 — "x"\n\nmy note\n\n## Full text\n\nthe paper\n`;
    expect(parseAnnotations(n)).toEqual([{ page: 1, quote: "x", comment: "my note" }]);
  });

  /** Quotes routinely span lines in a PDF; the heading must stay one line. */
  it("flattens a multi-line quote so the heading survives", () => {
    const block = renderAnnotation({ page: 2, quote: "one\ntwo\n\nthree", comment: "c" });
    expect(block).toContain('### p.2 — "one two three"');
    expect(parseAnnotations(`\n## Annotations\n\n${block}`)[0].quote).toBe("one two three");
  });
});


describe("findQuoteStart", () => {
  // How a PDF actually reports a line: runs split at arbitrary points.
  const items = [
    { str: "We propose " },
    { str: "a new archi" },
    { str: "tecture for " },
    { str: "sequence modelling." },
  ];

  it("finds a quote that starts inside an item", () => {
    expect(findQuoteStart(items, "a new architecture")).toBe(1);
  });

  it("finds one that spans several items", () => {
    expect(findQuoteStart(items, "architecture for sequence")).toBe(1);
  });

  /** The captured quote's whitespace never matches the PDF's runs. */
  it("ignores whitespace differences on both sides", () => {
    expect(findQuoteStart(items, "  a   new\narchitecture ")).toBe(1);
  });

  it("matches case-insensitively", () => {
    expect(findQuoteStart(items, "SEQUENCE MODELLING")).toBe(3);
  });

  it("matches on the opening of a long quote", () => {
    const long = "We propose a new architecture for sequence modelling " + "and more ".repeat(20);
    expect(findQuoteStart(items, long)).toBe(0);
  });

  it("returns -1 when the passage is not on this page", () => {
    expect(findQuoteStart(items, "something else entirely")).toBe(-1);
    expect(findQuoteStart(items, "")).toBe(-1);
    expect(findQuoteStart([], "anything")).toBe(-1);
  });
});

describe("finding the extent of a quoted passage", () => {
  // pdf.js emits a run per style change, so one sentence is many spans. A
  // highlight that used only the first would underline a single word.
  const items = [
    { str: "The compute-optimal " },
    { str: "frontier " },
    { str: "shifts with " },
    { str: "token budget. " },
    { str: "Later text." },
  ];

  it("covers every run the passage touches", () => {
    const span = findQuoteSpans(items, "compute-optimal frontier shifts");
    expect(span).toEqual({ from: 0, to: 2 });
  });

  it("stops at the run the passage ends in", () => {
    const span = findQuoteSpans(items, "The compute-optimal");
    expect(span?.to).toBe(0);
  });

  it("covers the whole passage, not just a matched opening", () => {
    // The old prefix-only match would have stopped at 60 characters.
    const long = "The compute-optimal frontier shifts with token budget.";
    expect(findQuoteSpans(items, long)).toEqual({ from: 0, to: 3 });
  });

  it("marks what is here when the selection ran past the page break", () => {
    const span = findQuoteSpans(items, "token budget. And then a paragraph that lives on the next page entirely");
    expect(span).not.toBeNull();
    expect(span!.from).toBeLessThanOrEqual(3);
  });

  it("ignores whitespace differences, as the extractor reflows", () => {
    // Only whitespace: punctuation is meaningful, and dropping the hyphen
    // would let "compute optimal" match text that never said it.
    expect(findQuoteSpans(items, "compute-optimal\n\n  frontier")).toEqual({ from: 0, to: 1 });
  });

  it("returns null when the passage is not on this page", () => {
    expect(findQuoteSpans(items, "a sentence from another paper")).toBeNull();
    expect(findQuoteSpans(items, "   ")).toBeNull();
  });
});
