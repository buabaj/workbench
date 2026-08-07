import { describe, expect, it } from "vitest";
import { frontmatterBlock, frontmatterField } from "./frontmatter";

/** Shaped like what `note_for` actually writes. */
const NOTE = `---
title: "DeepSeek-R1: incentivizes reasoning"
authors:
  - Daya Guo
  - Dejian Yang
year: 2025
doi: 10.1038/s41586-025-09422-z
pdf: papers/pdf/guo-2025-deepseek-r1.pdf
full_text: true
tags: [paper]
---

# DeepSeek-R1

## Abstract

Body text --- with a rule below.

---
`;

describe("frontmatterBlock", () => {
  it("reads the block at the top of the file", () => {
    const b = frontmatterBlock(NOTE)!;
    expect(b).toContain("year: 2025");
    expect(b).not.toContain("# DeepSeek-R1");
  });

  it("is null when there is no frontmatter", () => {
    expect(frontmatterBlock("# Just a note\n\ntext")).toBeNull();
  });

  /** A `---` further down is a horizontal rule, not metadata. */
  it("requires the block to start the file", () => {
    expect(frontmatterBlock("\n---\ntitle: x\n---\n")).toBeNull();
  });

  it("is null when the block is never closed", () => {
    expect(frontmatterBlock("---\ntitle: x\n\nbody")).toBeNull();
  });
});

describe("frontmatterField", () => {
  it("reads the field this all exists for", () => {
    expect(frontmatterField(NOTE, "pdf")).toBe("papers/pdf/guo-2025-deepseek-r1.pdf");
  });

  it("unquotes a value quoted because it contains a colon", () => {
    expect(frontmatterField(NOTE, "title")).toBe("DeepSeek-R1: incentivizes reasoning");
  });

  it("reads plain scalars", () => {
    expect(frontmatterField(NOTE, "year")).toBe("2025");
    expect(frontmatterField(NOTE, "full_text")).toBe("true");
  });

  /** A list is not a scalar, and must not come back as its first dash. */
  it("returns null for a list field", () => {
    expect(frontmatterField(NOTE, "authors")).toBeNull();
  });

  it("does not confuse an indented line for a top-level field", () => {
    expect(frontmatterField("---\nouter:\n  pdf: nested.pdf\n---\n", "pdf")).toBeNull();
  });

  it("returns null for an absent field or an absent block", () => {
    expect(frontmatterField(NOTE, "nope")).toBeNull();
    expect(frontmatterField("# no frontmatter", "pdf")).toBeNull();
  });

  it("does not match a field whose name merely ends the same way", () => {
    expect(frontmatterField("---\nmypdf: a.pdf\n---\n", "pdf")).toBeNull();
  });
});
