/**
 * Module-level (non-reactive) home for authoritative editor state. React
 * mounts/unmounts stash and restore EditorStates here, which makes StrictMode's
 * double-mount a no-op and gives free tab-switch persistence (undo history,
 * folds, selection).
 */
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export interface EditorSession {
  state: EditorState;
  scrollTop: number;
  /** Hash of the last content loaded from or saved to disk. */
  diskHash: string;
}

const sessions = new Map<string, EditorSession>();

/**
 * The MOUNTED view for a path, when there is one.
 *
 * Separate from the stashed state because a background task must be able to
 * find whichever view is current at the moment it finishes, rather than the
 * one it captured when it started. Holding a captured view across an await
 * meant a tab switch left the result dispatching into a destroyed editor —
 * the note kept the placeholder forever and the work was lost.
 */
const liveViews = new Map<string, EditorView>();

export const editorRegistry = {
  get: (key: string) => sessions.get(key),
  set: (key: string, session: EditorSession) => sessions.set(key, session),
  updateDiskHash(key: string, hash: string) {
    const s = sessions.get(key);
    if (s) s.diskHash = hash;
  },
  delete: (key: string) => {
    liveViews.delete(key);
    return sessions.delete(key);
  },
  clear: () => {
    liveViews.clear();
    sessions.clear();
  },

  /** Called by the editor as it mounts and unmounts. */
  bindView: (key: string, view: EditorView) => liveViews.set(key, view),
  unbindView: (key: string, view: EditorView) => {
    // Only if it is still ours: a remount can register the new view before
    // the old one's cleanup runs, and unbinding blindly would drop the live
    // one and leave later edits with nowhere to land.
    if (liveViews.get(key) === view) liveViews.delete(key);
  },
  liveView: (key: string) => liveViews.get(key),

  /**
   * Forget stashed state for files that are not on screen.
   *
   * A mounted editor reloads itself when the file changes underneath it, but a
   * background tab holds an EditorState nobody is watching. After something
   * rewrites many files at once — switching branches — those tabs would show
   * the previous branch's contents indefinitely. Dropping the stash makes them
   * re-read from disk the next time they mount.
   *
   * Only where there is no live view: the mounted one is handled by the
   * watcher, and deleting its state would throw away the undo history.
   */
  dropUnmounted(keys: string[]) {
    for (const key of keys) {
      if (!liveViews.has(key)) sessions.delete(key);
    }
  },
};
