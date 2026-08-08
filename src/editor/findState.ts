import { SearchQuery, findNext, findPrevious, setSearchQuery } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";

/**
 * Driving CodeMirror's search from our own bar.
 *
 * The extension is included for its state and commands, never for its panel:
 * `openSearchPanel` would draw CodeMirror's own UI, which knows nothing about
 * this app's type or spacing. So the bar is ours and the matching is theirs —
 * which is the right split, because incremental search over a large document
 * is the part that is genuinely hard and already solved.
 */

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
}

export const NO_MATCHES = { total: 0, current: 0 };

function build(query: string, opts: FindOptions): SearchQuery {
  return new SearchQuery({
    search: query,
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
    regexp: opts.regexp,
  });
}

/**
 * Tell the editor what is being looked for.
 *
 * Separate from moving: retyping should re-highlight without jumping, or the
 * document scrolls away under every keystroke and you cannot see what you are
 * refining.
 */
export function applyFind(view: EditorView, query: string, opts: FindOptions): void {
  view.dispatch({ effects: setSearchQuery.of(build(query, opts)) });
}

/**
 * How many matches, and which one holds the cursor.
 *
 * Counted by walking the document. Fine for a file — this runs per keystroke on
 * one buffer, not across a tree — and it is the only way to say "3 of 17",
 * which is the difference between a search box and a search.
 */
export function countMatches(
  view: EditorView,
  query: string,
  opts: FindOptions,
): { total: number; current: number } {
  if (!query) return NO_MATCHES;
  let built: SearchQuery;
  try {
    built = build(query, opts);
    // An incomplete regex — "(" while still typing — is not an error worth
    // showing; it simply has no matches yet.
    if (!built.valid) return NO_MATCHES;
  } catch {
    return NO_MATCHES;
  }

  const head = view.state.selection.main.from;
  let total = 0;
  let current = 0;
  try {
    const cursor = built.getCursor(view.state);
    for (let it = cursor.next(); !it.done; it = cursor.next()) {
      total++;
      // The match the cursor sits in or before — what "current" means when
      // you have just typed rather than stepped.
      if (current === 0 && it.value.from >= head) current = total;
    }
  } catch {
    return NO_MATCHES;
  }
  // Past the last match, the next ↵ wraps to the first.
  if (total > 0 && current === 0) current = total;
  return { total, current };
}

/** Step to the next match, wrapping at the end. */
export function stepNext(view: EditorView): void {
  findNext(view);
}

/** Step to the previous match, wrapping at the start. */
export function stepPrevious(view: EditorView): void {
  findPrevious(view);
}
