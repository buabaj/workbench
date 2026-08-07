import { describe, expect, it } from "vitest";
import { countChanges, toSideBySide } from "./sideBySide";

const PATCH = `diff --git a/f.txt b/f.txt
index 1234567..89abcde 100644
--- a/f.txt
+++ b/f.txt
@@ -1,5 +1,5 @@
 one
-two
+TWO
 three
-four
-five
+FOUR
 six
`;

describe("toSideBySide", () => {
  it("drops the transport headers", () => {
    const rows = toSideBySide(PATCH);
    const texts = rows.map((r) => r.left?.text ?? r.right?.text ?? "");
    expect(texts.some((t) => t.startsWith("diff --git"))).toBe(false);
    expect(texts.some((t) => t.startsWith("index "))).toBe(false);
  });

  it("puts context on both sides with each version's line number", () => {
    const rows = toSideBySide(PATCH).filter((r) => r.kind === "context");
    expect(rows[0]).toEqual({
      kind: "context",
      left: { num: 1, text: "one" },
      right: { num: 1, text: "one" },
    });
  });

  /** The point of the exercise: a changed line faces the line it replaced. */
  it("pairs a removal with its replacement on one row", () => {
    const row = toSideBySide(PATCH).find((r) => r.left?.text === "two")!;
    expect(row.kind).toBe("change");
    expect(row.right?.text).toBe("TWO");
    expect(row.left?.num).toBe(2);
    expect(row.right?.num).toBe(2);
  });

  /** Runs are rarely the same length; the surplus must not be dropped. */
  it("keeps the surplus when two lines become one", () => {
    const rows = toSideBySide(PATCH);
    const four = rows.find((r) => r.left?.text === "four")!;
    const five = rows.find((r) => r.left?.text === "five")!;
    expect(four.kind).toBe("change");
    expect(four.right?.text).toBe("FOUR");
    expect(five.kind).toBe("remove");
    expect(five.right).toBeNull();
  });

  it("numbers lines correctly after an uneven run", () => {
    const six = toSideBySide(PATCH).find((r) => r.left?.text === "six")!;
    // Old file: one two three four five six. New: one TWO three FOUR six.
    expect(six.left?.num).toBe(6);
    expect(six.right?.num).toBe(5);
  });

  it("keeps hunk headers as their own row", () => {
    const hunk = toSideBySide(PATCH).find((r) => r.kind === "hunk")!;
    expect(hunk.left?.text).toContain("@@");
    expect(hunk.right).toBeNull();
  });

  it("handles a pure addition", () => {
    const rows = toSideBySide("@@ -1,1 +1,2 @@\n one\n+two\n");
    const add = rows.find((r) => r.kind === "add")!;
    expect(add.left).toBeNull();
    expect(add.right).toEqual({ num: 2, text: "two" });
  });

  it("handles a pure deletion", () => {
    const rows = toSideBySide("@@ -1,2 +1,1 @@\n one\n-two\n");
    const del = rows.find((r) => r.kind === "remove")!;
    expect(del.right).toBeNull();
    expect(del.left).toEqual({ num: 2, text: "two" });
  });

  it("resumes numbering from each hunk header", () => {
    const rows = toSideBySide("@@ -10,1 +20,1 @@\n ten\n");
    expect(rows.find((r) => r.kind === "context")!.left?.num).toBe(10);
    expect(rows.find((r) => r.kind === "context")!.right?.num).toBe(20);
  });

  it("is empty for an empty patch", () => {
    expect(toSideBySide("")).toEqual([]);
  });
});

describe("countChanges", () => {
  it("counts each side of the change", () => {
    expect(countChanges(toSideBySide(PATCH))).toEqual({ added: 2, removed: 3 });
  });
});
