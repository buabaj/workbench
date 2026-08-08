import type { WorktreeChange } from "../ipc/client";

/**
 * Git state, arranged for a file tree.
 *
 * A tree needs two things the change list does not give directly: the state of
 * one path, and whether a *collapsed folder* hides anything changed. The second
 * is what makes the indicator worth having — otherwise you have to open every
 * folder to find out whether there is anything in it.
 */

export type TreeState = "added" | "modified" | "deleted" | null;

export interface TreeStatus {
  /** State of an exact path, or null when it is unchanged. */
  of(relPath: string): TreeState;
  /** Whether anything under this folder has changed. */
  containsChanges(relPath: string): boolean;
  /** How many changed paths there are in total. */
  readonly count: number;
}

/**
 * Untracked and added are one colour, deliberately.
 *
 * Git distinguishes them because one is staged and one is not; a reader
 * scanning a tree does not care, and cares a great deal that the file is new.
 */
function toState(change: WorktreeChange): TreeState {
  if (change.untracked || change.status === "added") return "added";
  if (change.status === "deleted") return "deleted";
  return "modified";
}

export function buildTreeStatus(changes: WorktreeChange[]): TreeStatus {
  const exact = new Map<string, TreeState>();
  // Every ancestor of every change, so a collapsed folder can answer without
  // scanning. Built once per refresh rather than per row: a tree re-renders
  // constantly and a prefix scan on each row would be quadratic on a big repo.
  const dirty = new Set<string>();

  for (const change of changes) {
    const state = toState(change);
    exact.set(change.relPath, state);
    // A rename shows on both names — where it went, and where it came from.
    if (change.oldPath) exact.set(change.oldPath, "deleted");

    for (const path of [change.relPath, change.oldPath ?? ""]) {
      if (!path) continue;
      let cut = path.lastIndexOf("/");
      while (cut > 0) {
        dirty.add(path.slice(0, cut));
        cut = path.lastIndexOf("/", cut - 1);
      }
      // The workspace root, so a collapsed root can be marked too.
      if (path.includes("/")) dirty.add("");
    }
  }

  return {
    of: (relPath) => exact.get(relPath) ?? null,
    containsChanges: (relPath) => dirty.has(relPath),
    count: exact.size,
  };
}

/** Empty status, for a workspace that is not a repository. */
export const NO_CHANGES: TreeStatus = {
  of: () => null,
  containsChanges: () => false,
  count: 0,
};
