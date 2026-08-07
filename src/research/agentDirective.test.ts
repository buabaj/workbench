import { describe, expect, it } from "vitest";
import { directiveAt, parseDirectives, replaceDirective } from "./agentDirective";

describe("parseDirectives", () => {
  it("finds a directive and what it asks for", () => {
    const [d] = parseDirectives("Some prose.\n\n@agent[summarise the method]\n");
    expect(d.instruction).toBe("summarise the method");
  });

  /** A wikilink inside a request is the obvious thing to write. */
  it("allows nested brackets", () => {
    const [d] = parseDirectives("@agent[compare [[Alpha]] with [[Beta]]]");
    expect(d.instruction).toBe("compare [[Alpha]] with [[Beta]]");
  });

  it("finds several in order", () => {
    expect(parseDirectives("@agent[one] text @agent[two]").map((d) => d.instruction)).toEqual([
      "one",
      "two",
    ]);
  });

  it("ignores an unclosed directive rather than eating the file", () => {
    expect(parseDirectives("@agent[never closed and more text")).toEqual([]);
  });

  it("ignores an empty instruction", () => {
    expect(parseDirectives("@agent[]")).toEqual([]);
  });

  it("is not triggered mid-word", () => {
    expect(parseDirectives("mail me@agent[x]")).toEqual([]);
  });

  it("reports offsets that cover the whole directive", () => {
    const text = "a @agent[do it] b";
    const [d] = parseDirectives(text);
    expect(text.slice(d.start, d.end)).toBe("@agent[do it]");
  });
});

describe("directiveAt", () => {
  const text = "@agent[first] middle @agent[second]";

  it("prefers the one the caret is inside", () => {
    expect(directiveAt(text, 3)?.instruction).toBe("first");
    expect(directiveAt(text, 30)?.instruction).toBe("second");
  });

  it("otherwise takes the next one after the caret", () => {
    expect(directiveAt(text, 15)?.instruction).toBe("second");
  });

  it("falls back to the last when the caret is past them all", () => {
    expect(directiveAt(text, text.length)?.instruction).toBe("second");
  });

  it("is null when there are none", () => {
    expect(directiveAt("plain prose", 0)).toBeNull();
  });
});

describe("replaceDirective", () => {
  it("swaps the directive for the result and leaves the rest alone", () => {
    const text = "Before.\n\n@agent[write it]\n\nAfter.";
    const d = parseDirectives(text)[0];
    expect(replaceDirective(text, d, "  The written thing.  ")).toBe(
      "Before.\n\nThe written thing.\n\nAfter.",
    );
  });
});
