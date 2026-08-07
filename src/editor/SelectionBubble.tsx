import { EditorView } from "@codemirror/view";
import { MessageSquarePlus, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useComposer } from "../store/composer";
import { useLayout } from "../store/layout";

/**
 * Actions on a selection, floating beside it.
 *
 * Appears only for a real selection — a caret is not a selection, and a bubble
 * that showed up on every click would be in the way constantly.
 *
 * Both actions put a `@path:from-to` reference in the composer rather than the
 * selected text itself. The reference expands to an absolute path and line
 * range on send (see `chat/mentions`), so the agent reads the passage from the
 * file as it currently is; pasting the text would instead send a copy that
 * goes stale the moment either of you edits it, and would flood the input for
 * a long selection.
 */

interface Pos {
  top: number;
  left: number;
  fromLine: number;
  toLine: number;
}

/** Selections shorter than this are almost always a stray drag. */
const MIN_CHARS = 1;

export function SelectionBubble({
  viewRef,
  relPath,
  hostRef,
}: {
  viewRef: React.RefObject<EditorView | null>;
  relPath: string;
  hostRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [pos, setPos] = useState<Pos | null>(null);
  const append = useComposer((s) => s.appendAndFocus);
  const focusChat = useLayout((s) => s.focusChat);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const update = () => {
      const view = viewRef.current;
      if (!view) return setPos(null);
      const sel = view.state.selection.main;
      if (sel.empty || sel.to - sel.from < MIN_CHARS) return setPos(null);

      const coords = view.coordsAtPos(sel.from);
      if (!coords) return setPos(null);
      const box = host.getBoundingClientRect();
      setPos({
        // Above the first line of the selection, clamped into the pane so it
        // never floats off the top when you select from line 1.
        top: Math.max(4, coords.top - box.top - 34),
        left: Math.min(Math.max(4, coords.left - box.left), Math.max(4, box.width - 210)),
        fromLine: view.state.doc.lineAt(sel.from).number,
        toLine: view.state.doc.lineAt(sel.to).number,
      });
    };

    // Pointer and key events rather than a CM update listener: this only needs
    // to run when the user finishes a gesture, not on every transaction.
    const onUp = () => window.setTimeout(update, 0);
    host.addEventListener("mouseup", onUp);
    host.addEventListener("keyup", onUp);
    const onScroll = () => setPos(null); // stale position; re-select to bring it back
    host.addEventListener("scroll", onScroll, true);
    return () => {
      host.removeEventListener("mouseup", onUp);
      host.removeEventListener("keyup", onUp);
      host.removeEventListener("scroll", onScroll, true);
    };
  }, [hostRef, viewRef]);

  if (!pos) return null;

  const ref =
    pos.fromLine === pos.toLine
      ? `@${relPath}:${pos.fromLine}-${pos.fromLine}`
      : `@${relPath}:${pos.fromLine}-${pos.toLine}`;

  const act = (text: string) => {
    append(text);
    focusChat();
    setPos(null);
  };

  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      style={{
        position: "absolute",
        top: pos.top,
        left: pos.left,
        zIndex: 20,
        display: "flex",
        gap: 2,
        padding: 3,
        background: "var(--canvas)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-control)",
        boxShadow: "var(--lift-strong)",
      }}
      // Keep the editor's selection while clicking, or it clears on mousedown
      // and the bubble disappears before the click lands.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        className="btn"
        style={{ fontSize: "var(--text-xs)", padding: "3px 8px", gap: 5 }}
        title="Add this selection to the chat as context"
        onClick={() => act(ref)}
      >
        <MessageSquarePlus size={12} strokeWidth={1.8} />
        Add to chat
      </button>
      <button
        className="btn"
        style={{ fontSize: "var(--text-xs)", padding: "3px 8px", gap: 5 }}
        title="Ask for a change to this selection"
        // Trailing space, caret after it: the composer is left mid-sentence so
        // you can say what you want without repositioning anything.
        onClick={() => act(`Change ${ref} to `)}
      >
        <Wand2 size={12} strokeWidth={1.8} />
        Request change
      </button>
    </div>
  );
}
