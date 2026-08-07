import { describe, expect, it } from "vitest";
import { applyMention, extractMentions, mentionQueryAt, referenceFooter } from "./mentions";

describe("mentionQueryAt", () => {
  it("finds the token the caret is inside", () => {
    const text = "look at @des";
    expect(mentionQueryAt(text, text.length)).toEqual({ query: "des", start: 8, end: 12 });
  });

  it("offers everything right after a bare @", () => {
    expect(mentionQueryAt("@", 1)).toEqual({ query: "", start: 0, end: 1 });
  });

  it("keeps matching once a path separator is typed", () => {
    const text = "@design/DES";
    expect(mentionQueryAt(text, text.length)?.query).toBe("design/DES");
  });

  it("is not fooled by an email address", () => {
    const text = "mail admin@morpheusgh.co";
    expect(mentionQueryAt(text, text.length)).toBeNull();
  });

  it("closes once whitespace follows the mention", () => {
    const text = "@design/DESIGN.md now explain it";
    expect(mentionQueryAt(text, text.length)).toBeNull();
  });

  it("uses the caret, not the end of the text", () => {
    const text = "@rea and more";
    // Caret just after "@rea".
    expect(mentionQueryAt(text, 4)?.query).toBe("rea");
  });

  it("returns null with no @ at all", () => {
    expect(mentionQueryAt("plain words", 5)).toBeNull();
  });
});

describe("applyMention", () => {
  it("replaces the token and leaves the caret after a trailing space", () => {
    const text = "look at @des";
    const q = mentionQueryAt(text, text.length)!;
    expect(applyMention(text, q, "design/DESIGN.md")).toEqual({
      text: "look at @design/DESIGN.md ",
      caret: 26,
    });
  });

  it("preserves text after the caret", () => {
    const text = "@des and then stop";
    const q = mentionQueryAt(text, 4)!;
    expect(applyMention(text, q, "design/DESIGN.md").text).toBe(
      "@design/DESIGN.md  and then stop",
    );
  });
});

describe("extractMentions", () => {
  it("finds several, in order, without duplicates", () => {
    expect(extractMentions("compare @a/one.rs with @b/two.rs and @a/one.rs")).toEqual([
      { path: "a/one.rs" },
      { path: "b/two.rs" },
    ]);
  });

  it("trims trailing punctuation but keeps the extension", () => {
    expect(extractMentions("read @design/DESIGN.md, then stop")).toEqual([
      { path: "design/DESIGN.md" },
    ]);
    expect(extractMentions("(see @src/main.rs)")).toEqual([{ path: "src/main.rs" }]);
  });

  /** The shape the editor's selection actions insert. */
  it("reads a line range off the reference", () => {
    expect(extractMentions("look at @src/main.rs:12-20")).toEqual([
      { path: "src/main.rs", lines: { from: 12, to: 20 } },
    ]);
  });

  it("keeps a range and a plain reference to the same file apart", () => {
    expect(extractMentions("@a.rs and @a.rs:1-2")).toEqual([
      { path: "a.rs" },
      { path: "a.rs", lines: { from: 1, to: 2 } },
    ]);
  });

  it("still trims punctuation after a range", () => {
    expect(extractMentions("see @a.rs:3-4.")).toEqual([
      { path: "a.rs", lines: { from: 3, to: 4 } },
    ]);
  });

  it("ignores an email address", () => {
    expect(extractMentions("write to admin@morpheusgh.co")).toEqual([]);
  });

  it("returns nothing for plain text", () => {
    expect(extractMentions("no mentions here")).toEqual([]);
  });
});

describe("referenceFooter", () => {
  it("resolves mentions to absolute paths", () => {
    expect(referenceFooter("read @design/DESIGN.md", "/Users/j/projects/workbench")).toBe(
      "The user referenced this file. Read it before answering:\n" +
        "- /Users/j/projects/workbench/design/DESIGN.md",
    );
  });

  it("pluralises and lists each file", () => {
    const out = referenceFooter("@a.rs and @b.rs", "/w");
    expect(out).toContain("these files");
    expect(out).toContain("- /w/a.rs");
    expect(out).toContain("- /w/b.rs");
  });

  it("does not produce a double slash", () => {
    expect(referenceFooter("@a.rs", "/w/")).toContain("/w/a.rs");
    expect(referenceFooter("@/a.rs", "/w")).toContain("/w/a.rs");
  });

  it("names the line range when one was selected", () => {
    expect(referenceFooter("@src/main.rs:12-20", "/w")).toContain(
      "- /w/src/main.rs (lines 12-20)",
    );
  });

  it("is empty when nothing was referenced", () => {
    expect(referenceFooter("just a question", "/w")).toBe("");
  });
});
