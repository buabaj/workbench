import { create } from "zustand";
import { addAll, removeAt, type Attachment } from "../chat/attachments";

/**
 * The chat input's text, held outside the component that renders it.
 *
 * It was local state in `App`, which meant nothing else could put anything in
 * it. The editor's selection actions and the voice transcript both need to,
 * and neither is a child of the composer — a store is the honest shape.
 *
 * Attachments live here for the same reason: they arrive from a picker, from a
 * drop anywhere on the window, and one day from the file tree. None of those is
 * a child of the composer either.
 */
interface ComposerStore {
  text: string;
  /** Attached but not yet sent. Cleared by sending, like the text is. */
  attachments: Attachment[];
  /** Files that could not be attached, said out loud until dismissed. */
  rejected: string[];
  /** Bumped to ask the textarea to take focus; the value itself is unused. */
  focusTick: number;

  setText(text: string): void;
  /** Append, keeping exactly one blank line between blocks. */
  append(text: string): void;
  /** Append and put the caret in the input, ready to keep typing. */
  appendAndFocus(text: string): void;
  focus(): void;
  clear(): void;

  attach(
    files: Array<{ path: string; size: number }>,
    rejected?: Array<{ path: string; reason: string }>,
  ): void;
  detach(path: string): void;
  dismissRejected(): void;
}

function joined(existing: string, addition: string): string {
  if (!existing.trim()) return addition;
  // A reference dropped onto an unfinished sentence should start its own line
  // rather than run into it.
  return `${existing.replace(/\s+$/, "")}\n\n${addition}`;
}

export const useComposer = create<ComposerStore>((set, get) => ({
  text: "",
  attachments: [],
  rejected: [],
  focusTick: 0,

  setText: (text) => set({ text }),
  append: (text) => set({ text: joined(get().text, text) }),
  appendAndFocus: (text) =>
    set({ text: joined(get().text, text), focusTick: get().focusTick + 1 }),
  focus: () => set({ focusTick: get().focusTick + 1 }),
  // Sending clears both: the message went, and so did everything on it.
  clear: () => set({ text: "", attachments: [], rejected: [] }),

  attach: (files, alreadyRejected = []) => {
    const { attachments, rejected } = addAll(get().attachments, files);
    set({
      attachments,
      // Kept until dismissed — a file that vanishes on drop reads as a broken
      // drop target. Rejections from the backend (a folder, a missing file)
      // are shown alongside the ones found here (too big, too many).
      rejected: [...alreadyRejected, ...rejected].map(
        (r) => `${r.path.split("/").pop()}: ${r.reason}`,
      ),
      focusTick: get().focusTick + 1,
    });
  },
  detach: (path) => set({ attachments: removeAt(get().attachments, path) }),
  dismissRejected: () => set({ rejected: [] }),
}));
