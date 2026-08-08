import { EditorView } from "@codemirror/view";
import { MessageSquarePlus, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useComposer } from "../store/composer";
import { useLinks } from "../store/links";

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
  host,
}: {
  viewRef: React.RefObject<EditorView | null>;
  relPath: string;
  /** State, not a ref: the effect must re-run once the node actually attaches. */
  host: HTMLDivElement | null;
}) {
  const [pos, setPos] = useState<Pos | null>(null);
  const append = useComposer((s) => s.appendAndFocus);
  // The editor already publishes its live selection here, on every selection
  // change, so the bubble follows it rather than guessing from raw events.
  const selection = useLinks((s) => s.selection);

  useEffect(() => {
    const view = viewRef.current;
    if (!host || !view || !selection || selection.relPath !== relPath) {
      setPos(null);
      return;
    }
    if (selection.to - selection.from < MIN_CHARS) {
      setPos(null);
      return;
    }

    const place = () => {
      const v = viewRef.current;
      if (!v) return setPos(null);
      const doc = v.state.doc;
      const from = Math.min(selection.from, doc.length);
      const to = Math.min(selection.to, doc.length);
      const coords = v.coordsAtPos(from);
      if (!coords) return setPos(null);
      const box = host.getBoundingClientRect();
      setPos({
        // Above the first line of the selection, clamped into the pane so it
        // never floats off the top when you select from line 1.
        top: Math.max(4, coords.top - box.top - 34),
        left: Math.min(Math.max(4, coords.left - box.left), Math.max(4, box.width - 220)),
        fromLine: doc.lineAt(from).number,
        toLine: doc.lineAt(to).number,
      });
    };

    // After layout, so coordsAtPos reflects the rendered selection.
    const raf = requestAnimationFrame(place);
    // A scrolled selection leaves the bubble stranded; drop it rather than
    // chase the scroll on every frame.
    const onScroll = () => setPos(null);
    host.addEventListener("scroll", onScroll, true);
    return () => {
      cancelAnimationFrame(raf);
      host.removeEventListener("scroll", onScroll, true);
    };
  }, [host, viewRef, relPath, selection]);

  if (!pos) return null;

  const ref =
    pos.fromLine === pos.toLine
      ? `@${relPath}:${pos.fromLine}-${pos.fromLine}`
      : `@${relPath}:${pos.fromLine}-${pos.toLine}`;

  const act = (text: string) => {
    // Deliberately does NOT switch to the chat tab. The composer is on screen
    // at all times, so adding a reference costs you nothing — being thrown out
    // of the file you were reading, in order to type about it, was the cost.
    append(text);
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
