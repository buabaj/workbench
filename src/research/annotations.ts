/**
 * Annotations on a paper, stored in the paper's own note.
 *
 * Not a sidecar file and not a database row. An annotation is a thought about
 * a passage, which is the same kind of thing as the rest of the note — keeping
 * it there means it is searchable, it appears in the vault, it survives this
 * app, and there is no second place for a paper's meaning to live.
 *
 * The format is plain markdown a person would not mind reading:
 *
 *   ## Annotations
 *
 *   ### p.4 — "the quoted passage"
 *
 *   what you thought about it
 */

export interface Annotation {
  page: number;
  quote: string;
  comment: string;
}

const HEADING = "## Annotations";

/** Everything under the Annotations heading, in document order. */
export function parseAnnotations(note: string): Annotation[] {
  const start = note.indexOf(`\n${HEADING}`);
  if (start === -1) return [];
  // Stops at the next `##` heading so a later section is not swallowed.
  const rest = note.slice(start + HEADING.length + 1);
  const end = rest.search(/^##\s(?!#)/m);
  const body = end === -1 ? rest : rest.slice(0, end);

  const out: Annotation[] = [];
  // `### p.<n> — "<quote>"`, then prose until the next entry.
  const re = /^###\s+p\.(\d+)\s+—\s+"([\s\S]*?)"\s*$/gm;
  let m: RegExpExecArray | null;
  const marks: Array<{ page: number; quote: string; from: number }> = [];
  while ((m = re.exec(body)) !== null) {
    marks.push({ page: Number(m[1]), quote: m[2], from: m.index + m[0].length });
  }
  for (let i = 0; i < marks.length; i++) {
    const to = i + 1 < marks.length ? body.lastIndexOf("###", marks[i + 1].from) : body.length;
    out.push({
      page: marks[i].page,
      quote: marks[i].quote,
      comment: body.slice(marks[i].from, to).trim(),
    });
  }
  return out;
}

/** One annotation rendered as the block the parser expects back. */
export function renderAnnotation(a: Annotation): string {
  // Newlines inside a quote would break the single-line heading it lives on.
  const quote = a.quote.replace(/\s+/g, " ").trim();
  return `### p.${a.page} — "${quote}"\n\n${a.comment.trim()}\n`;
}

/**
 * Add an annotation to a note, creating the section if it is not there.
 *
 * Appends rather than inserting anywhere clever: annotations accumulate in the
 * order you made them, which is the order you read in.
 */
export function appendAnnotation(note: string, a: Annotation): string {
  const block = renderAnnotation(a);
  const at = note.indexOf(`\n${HEADING}`);

  if (at === -1) {
    const spacer = note.endsWith("\n\n") ? "" : note.endsWith("\n") ? "\n" : "\n\n";
    return `${note}${spacer}${HEADING}\n\n${block}`;
  }
  // Insert at the end of the existing section, before whatever follows it.
  const afterHeading = at + HEADING.length + 1;
  const rest = note.slice(afterHeading);
  const nextHeading = rest.search(/^##\s(?!#)/m);
  if (nextHeading === -1) {
    const body = note.slice(afterHeading).replace(/\s*$/, "");
    return `${note.slice(0, afterHeading)}${body}\n\n${block}`;
  }
  const body = rest.slice(0, nextHeading).replace(/\s*$/, "");
  return `${note.slice(0, afterHeading)}${body}\n\n${block}\n${rest.slice(nextHeading)}`;
}
