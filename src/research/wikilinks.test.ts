import { describe, expect, it } from "vitest";
import {
  backlinksTo,
  linkLabel,
  noteName,
  parseWikiLinks,
  resolveLink,
  unresolvedTargets,
} from "./wikilinks";

describe("parseWikiLinks", () => {
  it("finds a plain link", () => {
    const [l] = parseWikiLinks("see [[Agent Lifecycle]] for detail");
    expect(l.target).toBe("Agent Lifecycle");
    expect(l.alias).toBeUndefined();
    expect(l.heading).toBeUndefined();
  });

  it("reads an alias and a heading", () => {
    const [l] = parseWikiLinks("[[Agent Lifecycle#Shutdown|how it winds down]]");
    expect(l).toMatchObject({
      target: "Agent Lifecycle",
      heading: "Shutdown",
      alias: "how it winds down",
    });
  });

  /** Two adjacent links must not merge into one greedy match. */
  it("keeps adjacent links separate", () => {
    const links = parseWikiLinks("[[a]] and [[b]]");
    expect(links.map((l) => l.target)).toEqual(["a", "b"]);
  });

  it("does not let an unclosed bracket swallow the document", () => {
    expect(parseWikiLinks("[[unclosed and then [[real]]")).toHaveLength(1);
    expect(parseWikiLinks("[[unclosed and then [[real]]")[0].target).toBe("real");
  });

  it("ignores an empty link", () => {
    expect(parseWikiLinks("[[]] and [[|x]]")).toEqual([]);
  });

  it("reports offsets covering the whole link", () => {
    const text = "go [[here]] now";
    const [l] = parseWikiLinks(text);
    expect(text.slice(l.start, l.end)).toBe("[[here]]");
  });

  it("finds nothing in plain prose, including a single bracket", () => {
    expect(parseWikiLinks("an array[0] and [not a link]")).toEqual([]);
  });
});

describe("linkLabel", () => {
  it("prefers the alias", () => {
    expect(linkLabel({ target: "a", alias: "b", start: 0, end: 0 })).toBe("b");
  });
  it("shows target and heading together", () => {
    expect(linkLabel({ target: "a", heading: "h", start: 0, end: 0 })).toBe("a › h");
  });
  it("handles a same-note heading link", () => {
    expect(linkLabel({ target: "", heading: "h", start: 0, end: 0 })).toBe("#h");
  });
});

describe("noteName", () => {
  it("strips directories and the extension", () => {
    expect(noteName("notes/deep/Agent Lifecycle.md")).toBe("Agent Lifecycle");
    expect(noteName("Readme.markdown")).toBe("Readme");
  });
});

describe("resolveLink", () => {
  const notes = ["notes/Agent Lifecycle.md", "archive/notes/Agent Lifecycle.md", "Index.md"];

  it("matches by name, case-insensitively", () => {
    expect(resolveLink("agent lifecycle", notes)).toBe("notes/Agent Lifecycle.md");
  });

  /** Ambiguity is resolved predictably rather than arbitrarily. */
  it("prefers the shallower note when two share a name", () => {
    expect(resolveLink("Agent Lifecycle", notes)).toBe("notes/Agent Lifecycle.md");
  });

  it("lets a path disambiguate", () => {
    expect(resolveLink("archive/notes/Agent Lifecycle", notes)).toBe(
      "archive/notes/Agent Lifecycle.md",
    );
  });

  it("tolerates an explicit extension", () => {
    expect(resolveLink("Index.md", notes)).toBe("Index.md");
  });

  it("returns null for a note that does not exist yet", () => {
    expect(resolveLink("Nothing Here", notes)).toBeNull();
    expect(resolveLink("", notes)).toBeNull();
  });
});

describe("backlinksTo", () => {
  const notes = ["Index.md", "notes/Agent.md", "notes/Pty.md"];
  const docs = [
    { relPath: "Index.md", text: "start\nsee [[Agent]] and [[Pty]]\n" },
    { relPath: "notes/Pty.md", text: "the [[Agent]] owns this\n" },
    { relPath: "notes/Agent.md", text: "I mention [[Agent]] myself\n" },
  ];

  it("finds every note linking here, with its line and context", () => {
    const links = backlinksTo("notes/Agent.md", docs, notes);
    expect(links.map((l) => l.from).sort()).toEqual(["Index.md", "notes/Pty.md"]);
    const fromIndex = links.find((l) => l.from === "Index.md")!;
    expect(fromIndex.line).toBe(2);
    expect(fromIndex.context).toBe("see [[Agent]] and [[Pty]]");
  });

  /** A note listing itself as a backlink is noise. */
  it("excludes self-references", () => {
    expect(backlinksTo("notes/Agent.md", docs, notes).some((l) => l.from === "notes/Agent.md")).toBe(
      false,
    );
  });

  it("returns nothing for an unlinked note", () => {
    expect(backlinksTo("notes/Lonely.md", docs, notes)).toEqual([]);
  });
});

describe("unresolvedTargets", () => {
  it("lists the notes a vault is asking to have", () => {
    const docs = [{ relPath: "a.md", text: "[[Exists]] and [[Missing]] and [[Missing]]" }];
    expect(unresolvedTargets(docs, ["Exists.md"])).toEqual(["Missing"]);
  });

  it("is empty when everything resolves", () => {
    expect(unresolvedTargets([{ relPath: "a.md", text: "[[Exists]]" }], ["Exists.md"])).toEqual([]);
  });
});
