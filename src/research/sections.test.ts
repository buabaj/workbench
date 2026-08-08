import { describe, expect, it } from "vitest";
import { withListItem, withSection } from "./sections";

/**
 * These write into a document someone is in the middle of writing, which is
 * the operation this project has already got wrong once. The cases that matter
 * are the ones where the note is not a blank page: a heading that already
 * exists, text that follows it, and frontmatter at the top.
 */
describe("withSection", () => {
  it("appends when the heading is absent", () => {
    const out = withSection("Some notes.", "Summary", "It says a thing.");
    expect(out).toBe("Some notes.\n\n## Summary\n\nIt says a thing.\n");
  });

  it("replaces the body when the heading is already there", () => {
    const note = "Intro.\n\n## Summary\n\nOld summary.\n";
    const out = withSection(note, "Summary", "New summary.");
    expect(out).toContain("New summary.");
    expect(out).not.toContain("Old summary.");
    // One section, not two.
    expect(out.match(/## Summary/g)).toHaveLength(1);
  });

  it("leaves the sections after it alone", () => {
    const note = "# Paper\n\n## Summary\n\nOld.\n\n## Notes\n\nMine, which I wrote.\n";
    const out = withSection(note, "Summary", "New.");
    expect(out).toContain("## Notes\n\nMine, which I wrote.\n");
    expect(out.indexOf("## Summary")).toBeLessThan(out.indexOf("## Notes"));
  });

  it("does not mistake a heading at a different level for a different section", () => {
    const note = "### Summary\n\nOld.\n";
    const out = withSection(note, "Summary", "New.");
    expect(out.match(/Summary/g)).toHaveLength(1);
  });

  it("keeps frontmatter intact", () => {
    const note = "---\ntitle: A paper\n---\n\nBody.\n";
    const out = withSection(note, "Summary", "Short.");
    expect(out.startsWith("---\ntitle: A paper\n---\n")).toBe(true);
  });

  it("handles an empty note without a leading blank line", () => {
    expect(withSection("", "Summary", "x")).toBe("## Summary\n\nx\n");
  });
});

describe("withListItem", () => {
  it("starts the section when it is absent", () => {
    const out = withListItem("Body.", "Related", "Scaling Laws");
    expect(out).toBe("Body.\n\n## Related\n\n- [[Scaling Laws]]\n");
  });

  it("adds to an existing list rather than starting a second one", () => {
    const note = "## Related\n\n- [[Attention]]\n";
    const out = withListItem(note, "Related", "Scaling Laws");
    expect(out).toBe("## Related\n\n- [[Attention]]\n- [[Scaling Laws]]\n");
  });

  it("does not add a link that is already there", () => {
    const note = "## Related\n\n- [[Scaling Laws]]\n";
    expect(withListItem(note, "Related", "Scaling Laws")).toBe(note);
  });

  it("recognises an aliased link as already there", () => {
    const note = "## Related\n\n- [[Scaling Laws|that scaling paper]]\n";
    expect(withListItem(note, "Related", "Scaling Laws")).toBe(note);
  });

  it("matches case-insensitively, as the vault resolves links", () => {
    const note = "## Related\n\n- [[scaling laws]]\n";
    expect(withListItem(note, "Related", "Scaling Laws")).toBe(note);
  });

  it("keeps a following section below the new item", () => {
    const note = "## Related\n\n- [[A]]\n\n## Notes\n\nMine.\n";
    const out = withListItem(note, "Related", "B");
    expect(out).toContain("- [[A]]\n- [[B]]\n");
    expect(out).toContain("## Notes\n\nMine.\n");
  });

  it("survives a name with regex characters in it", () => {
    // Paper titles contain brackets and parentheses all the time.
    const note = "## Related\n\n- [[GPT-4 (technical report)]]\n";
    expect(withListItem(note, "Related", "GPT-4 (technical report)")).toBe(note);
  });
});
