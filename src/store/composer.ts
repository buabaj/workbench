import { create } from "zustand";

/**
 * The chat input's text, held outside the component that renders it.
 *
 * It was local state in `App`, which meant nothing else could put anything in
 * it. The editor's selection actions and the voice transcript both need to,
 * and neither is a child of the composer — a store is the honest shape.
 */
interface ComposerStore {
  text: string;
  /** Bumped to ask the textarea to take focus; the value itself is unused. */
  focusTick: number;

  setText(text: string): void;
  /** Append, keeping exactly one blank line between blocks. */
  append(text: string): void;
  /** Append and put the caret in the input, ready to keep typing. */
  appendAndFocus(text: string): void;
  focus(): void;
  clear(): void;
}

function joined(existing: string, addition: string): string {
  if (!existing.trim()) return addition;
  // A reference dropped onto an unfinished sentence should start its own line
  // rather than run into it.
  return `${existing.replace(/\s+$/, "")}\n\n${addition}`;
}

export const useComposer = create<ComposerStore>((set, get) => ({
  text: "",
  focusTick: 0,

  setText: (text) => set({ text }),
  append: (text) => set({ text: joined(get().text, text) }),
  appendAndFocus: (text) =>
    set({ text: joined(get().text, text), focusTick: get().focusTick + 1 }),
  focus: () => set({ focusTick: get().focusTick + 1 }),
  clear: () => set({ text: "" }),
}));
