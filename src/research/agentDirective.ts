/**
 * `@agent[…]` — asking for something in the middle of writing.
 *
 * You are drafting a note, you want a summary or a comparison right there, and
 * switching to the chat to ask for it and then pasting the answer back is
 * three moves for one thought. The directive is written where the answer
 * should go, and is replaced by the answer.
 *
 * Replaced, not appended: leaving the instruction behind would mean re-running
 * it on the next pass and accumulating requests inside your own prose.
 */

export interface Directive {
  /** What was asked for. */
  instruction: string;
  /** Offsets of the whole `@agent[…]`, for replacing it in place. */
  start: number;
  end: number;
}

/**
 * Every directive in a document, in order.
 *
 * Brackets nest one level, so `@agent[compare [[a]] and [[b]]]` works — a
 * wikilink inside a request is the obvious thing to write, and refusing it
 * would be a trap.
 */
export function parseDirectives(text: string): Directive[] {
  const out: Directive[] = [];
  const marker = "@agent[";
  let from = 0;

  for (;;) {
    const at = text.indexOf(marker, from);
    if (at === -1) break;
    // Must start a word, so an email or `foo@agent[` is not a directive.
    const prev = at > 0 ? text[at - 1] : "";
    if (prev && !/\s/.test(prev)) {
      from = at + marker.length;
      continue;
    }

    let depth = 1;
    let i = at + marker.length;
    while (i < text.length && depth > 0) {
      if (text[i] === "[") depth++;
      else if (text[i] === "]") depth--;
      i++;
    }
    if (depth !== 0) break; // unclosed: the rest of the file is not an instruction

    const instruction = text.slice(at + marker.length, i - 1).trim();
    if (instruction) out.push({ instruction, start: at, end: i });
    from = i;
  }
  return out;
}

/** The directive the caret is in or nearest after it — what ⌘↵ should run. */
export function directiveAt(text: string, caret: number): Directive | null {
  const all = parseDirectives(text);
  if (all.length === 0) return null;
  return (
    all.find((d) => caret >= d.start && caret <= d.end) ??
    all.find((d) => d.start >= caret) ??
    all[all.length - 1]
  );
}

/** Swap a directive for its result, leaving the rest of the note untouched. */
export function replaceDirective(text: string, d: Directive, result: string): string {
  return text.slice(0, d.start) + result.trim() + text.slice(d.end);
}
