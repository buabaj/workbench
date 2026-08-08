import { describe, expect, it } from "vitest";
import { buildTreeStatus } from "./treeStatus";
import type { WorktreeChange } from "../ipc/client";

const change = (over: Partial<WorktreeChange>): WorktreeChange => ({
  relPath: "a.txt",
  oldPath: null,
  status: "modified",
  insertions: 1,
  deletions: 0,
  isBinary: false,
  untracked: false,
  ...over,
});

describe("buildTreeStatus", () => {
  it("reports the state of an exact path", () => {
    const s = buildTreeStatus([change({ relPath: "src/main.rs", status: "modified" })]);
    expect(s.of("src/main.rs")).toBe("modified");
    expect(s.of("src/other.rs")).toBeNull();
  });

  /** New is new, whether or not it happens to be staged yet. */
  it("treats untracked and added alike", () => {
    const s = buildTreeStatus([
      change({ relPath: "new1.rs", untracked: true, status: "added" }),
      change({ relPath: "new2.rs", untracked: false, status: "added" }),
    ]);
    expect(s.of("new1.rs")).toBe("added");
    expect(s.of("new2.rs")).toBe("added");
  });

  /** The point of the exercise: a collapsed folder must know. */
  it("marks every ancestor of a change", () => {
    const s = buildTreeStatus([change({ relPath: "src/deep/nested/file.rs" })]);
    expect(s.containsChanges("src")).toBe(true);
    expect(s.containsChanges("src/deep")).toBe(true);
    expect(s.containsChanges("src/deep/nested")).toBe(true);
  });

  it("does not mark a sibling folder", () => {
    const s = buildTreeStatus([change({ relPath: "src/a.rs" })]);
    expect(s.containsChanges("docs")).toBe(false);
    expect(s.containsChanges("src/nested")).toBe(false);
  });

  it("marks the root when something nested changed", () => {
    expect(buildTreeStatus([change({ relPath: "src/a.rs" })]).containsChanges("")).toBe(true);
  });

  it("does not mark a folder just because its name prefixes a changed path", () => {
    // "src2/x" must not make "src" look dirty.
    const s = buildTreeStatus([change({ relPath: "src2/x.rs" })]);
    expect(s.containsChanges("src")).toBe(false);
    expect(s.containsChanges("src2")).toBe(true);
  });

  it("shows a rename at both ends", () => {
    const s = buildTreeStatus([
      change({ relPath: "new/name.rs", oldPath: "old/name.rs", status: "renamed" }),
    ]);
    expect(s.of("new/name.rs")).toBe("modified");
    expect(s.of("old/name.rs")).toBe("deleted");
    expect(s.containsChanges("old")).toBe(true);
    expect(s.containsChanges("new")).toBe(true);
  });

  it("is empty for a clean tree", () => {
    const s = buildTreeStatus([]);
    expect(s.count).toBe(0);
    expect(s.containsChanges("")).toBe(false);
  });
});
