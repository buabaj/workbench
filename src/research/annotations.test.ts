import { describe, expect, it } from "vitest";
import { appendAnnotation, parseAnnotations, renderAnnotation } from "./annotations";

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
