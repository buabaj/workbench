/**
 * Marking which words in a note came from a model.
 *
 * Generated text lands in a note as ordinary prose, indistinguishable from a
 * sentence you wrote after reading the source. Months later that is
 * unrecoverable — there is no record to reconstruct from — and the failure is
 * silent: a model's assertion inherits your confidence in your own notes and
 * gets cited as if you had checked it.
 *
 * So generated spans carry markers:
 *
 *   <!-- agent gpt-5.1-codex 2026-08-08 -->
 *   the generated text
 *   <!-- /agent -->
 *
 * HTML comments, deliberately. They are invisible wherever markdown is
 * rendered, so the vault still opens in Obsidian or any editor and reads
 * normally — the file does not become Workbench-specific to carry this. They
 * are also greppable, which is what makes an audit possible at all.
 *
 * The distinction the file records is "verified by me" against "asserted by a
 * model", so accepting a span is an explicit act, never a default.
 */

export interface AgentSpan {
  /** Which model wrote it. */
  model: string;
  /** ISO date it was written. */
  date: string;
  /** The generated text, without the markers. */
  text: string;
  /** Offsets of the whole block including both markers. */
  start: number;
  end: number;
  /** Offsets of just the text between them, for decorating. */
  textStart: number;
  textEnd: number;
}

const OPEN = /<!--\s*agent\s+([^\s]+)\s+(\d{4}-\d{2}-\d{2})\s*-->/g;
const CLOSE = "<!-- /agent -->";

/** Wrap generated text so its origin travels with it. */
export function markGenerated(text: string, model: string, date: string): string {
  const body = text.trim();
  // A model name with a space would make the opening marker unparseable on
  // the way back, and provider ids legitimately contain slashes and dots.
  const safeModel = model.trim().replace(/\s+/g, "-") || "unknown";
  return `<!-- agent ${safeModel} ${date} -->\n${body}\n${CLOSE}`;
}

/** Every marked span in a note, in order. */
export function findAgentSpans(note: string): AgentSpan[] {
  const out: AgentSpan[] = [];
  OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = OPEN.exec(note)) !== null) {
    const textStart = m.index + m[0].length;
    const closeAt = note.indexOf(CLOSE, textStart);
    // An unclosed marker marks nothing rather than swallowing the rest of the
    // file — an edit that deletes a closing comment must not silently reclassify
    // everything after it as generated.
    if (closeAt === -1) continue;

    out.push({
      model: m[1],
      date: m[2],
      text: note.slice(textStart, closeAt).trim(),
      start: m.index,
      end: closeAt + CLOSE.length,
      // Trimmed inward past the newline each marker sits on, so a decoration
      // covers the prose and not the blank line above it.
      textStart: textStart + (note[textStart] === "\n" ? 1 : 0),
      textEnd: note[closeAt - 1] === "\n" ? closeAt - 1 : closeAt,
    });
    OPEN.lastIndex = closeAt + CLOSE.length;
  }
  return out;
}

/**
 * Strip one span's markers, keeping its text — you have read it and stand
 * behind it, so it becomes yours.
 */
export function acceptSpan(note: string, span: AgentSpan): string {
  return note.slice(0, span.start) + span.text + note.slice(span.end);
}

/** Strip a span and its text — you read it and it was wrong. */
export function rejectSpan(note: string, span: AgentSpan): string {
  const before = note.slice(0, span.start).replace(/\n+$/, "\n");
  const after = note.slice(span.end).replace(/^\n+/, "\n");
  return (before + after).replace(/\n{3,}/g, "\n\n");
}

/** Accept every span, for when a note has been read through. */
export function acceptAll(note: string): string {
  let out = note;
  // Last first, so earlier offsets stay valid as the string shortens.
  for (const span of findAgentSpans(out).reverse()) {
    out = acceptSpan(out, span);
  }
  return out;
}

/** How much of a note is still unverified model output. */
export function unverifiedSummary(note: string): { spans: number; chars: number } {
  const spans = findAgentSpans(note);
  return {
    spans: spans.length,
    chars: spans.reduce((n, s) => n + s.text.length, 0),
  };
}
