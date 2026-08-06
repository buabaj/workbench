/**
 * Module-level (non-reactive) home for authoritative editor state. React
 * mounts/unmounts stash and restore EditorStates here, which makes StrictMode's
 * double-mount a no-op and gives free tab-switch persistence (undo history,
 * folds, selection).
 */
import type { EditorState } from "@codemirror/state";

export interface EditorSession {
  state: EditorState;
  scrollTop: number;
  /** Hash of the last content loaded from or saved to disk. */
  diskHash: string;
}

const sessions = new Map<string, EditorSession>();

export const editorRegistry = {
  get: (key: string) => sessions.get(key),
  set: (key: string, session: EditorSession) => sessions.set(key, session),
  updateDiskHash(key: string, hash: string) {
    const s = sessions.get(key);
    if (s) s.diskHash = hash;
  },
  delete: (key: string) => sessions.delete(key),
  clear: () => sessions.clear(),
};
