import { ArrowDown, ArrowUp, CaseSensitive, List, Regex, WholeWord, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { useLayout } from "../store/layout";
import { applyFind, countMatches, stepNext, stepPrevious, type FindOptions } from "./findState";

/**
 * Find within the open file.
 *
 * The narrow half of ⇧⌘F: that searches the workspace and answers "where does
 * this live", while this answers "where else is it on this page" — a different
 * question, asked far more often, and one that should never cost a panel.
 *
 * It hands off rather than competing. The list button carries whatever is
 * typed here into the workspace search, because widening a search you have
 * already composed is the commonest next move and retyping it is the tax.
 */
export function FindBar({ view, onClose }: { view: EditorView | null; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [opts, setOpts] = useState<FindOptions>({
    caseSensitive: false,
    wholeWord: false,
    regexp: false,
  });
  const [count, setCount] = useState({ total: 0, current: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const openSearch = useLayout((s) => s.openSearch);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Re-highlight as you type, without moving. Jumping on every keystroke
  // scrolls the document away while you are still refining what you meant.
  useEffect(() => {
    if (!view) return;
    applyFind(view, query, opts);
    setCount(countMatches(view, query, opts));
  }, [view, query, opts]);

  const go = (dir: 1 | -1) => {
    if (!view || !query) return;
    if (dir === 1) stepNext(view);
    else stepPrevious(view);
    view.focus();
    setCount(countMatches(view, query, opts));
    // Focus returns to the field: ↵ ↵ ↵ through matches is the whole point,
    // and it would stop working the moment focus stayed in the document.
    inputRef.current?.focus();
  };

  const toggle = (key: keyof FindOptions) => setOpts((o) => ({ ...o, [key]: !o[key] }));

  const status = !query
    ? ""
    : count.total === 0
      ? "No results"
      : `${count.current} of ${count.total}`;

  return (
    <div className="find-bar" role="search" aria-label="Find in file">
      <input
        ref={inputRef}
        className="find-input"
        placeholder="Find"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
            view?.focus();
          } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
            // Widen without retyping: the query goes with you.
            e.preventDefault();
            e.stopPropagation();
            openSearch(query);
            onClose();
          }
        }}
      />

      <div className="find-toggles">
        <button
          className={`find-toggle ${opts.caseSensitive ? "on" : ""}`}
          aria-pressed={opts.caseSensitive}
          title="Match case"
          onClick={() => toggle("caseSensitive")}
        >
          <CaseSensitive size={13} strokeWidth={1.8} />
        </button>
        <button
          className={`find-toggle ${opts.wholeWord ? "on" : ""}`}
          aria-pressed={opts.wholeWord}
          title="Whole word"
          onClick={() => toggle("wholeWord")}
        >
          <WholeWord size={13} strokeWidth={1.8} />
        </button>
        <button
          className={`find-toggle ${opts.regexp ? "on" : ""}`}
          aria-pressed={opts.regexp}
          title="Regular expression"
          onClick={() => toggle("regexp")}
        >
          <Regex size={13} strokeWidth={1.8} />
        </button>
      </div>

      <span
        className="find-count"
        role="status"
        aria-live="polite"
        // Reserved width, so stepping through matches does not shuffle the
        // buttons sideways under the cursor as the number grows a digit.
        style={{ color: count.total === 0 && query ? "var(--ink-faint)" : "var(--ink-muted)" }}
      >
        {status}
      </span>

      <button
        className="btn icon find-step"
        disabled={count.total === 0}
        title="Previous (⇧↵)"
        aria-label="Previous match"
        onClick={() => go(-1)}
      >
        <ArrowUp size={13} strokeWidth={1.8} />
      </button>
      <button
        className="btn icon find-step"
        disabled={count.total === 0}
        title="Next (↵)"
        aria-label="Next match"
        onClick={() => go(1)}
      >
        <ArrowDown size={13} strokeWidth={1.8} />
      </button>
      <button
        className="btn icon find-step"
        title="Search the whole workspace (⇧⌘F)"
        aria-label="Search the whole workspace"
        onClick={() => {
          openSearch(query);
          onClose();
        }}
      >
        <List size={13} strokeWidth={1.8} />
      </button>
      <button
        className="btn icon find-step"
        title="Close (esc)"
        aria-label="Close find"
        onClick={() => {
          onClose();
          view?.focus();
        }}
      >
        <X size={13} strokeWidth={1.8} />
      </button>
    </div>
  );
}
