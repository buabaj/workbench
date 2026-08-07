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


/**
 * Where an annotation's quote begins, as an index into a page's text items.
 *
 * Matched by TEXT rather than by stored coordinates. A rectangle recorded at
 * one zoom level is wrong at every other, and wrong again if the document is
 * re-rendered at a different scale; the words do not move. It also means an
 * annotation made today still finds its passage after the reader changes.
 *
 * Whitespace is normalised on both sides because a PDF splits a sentence into
 * runs at arbitrary points — often mid-word — so the quote as captured rarely
 * matches any single item.
 */
export function findQuoteStart(items: Array<{ str?: string }>, quote: string): number {
  const needle = quote.replace(/\s+/g, "").toLowerCase();
  if (!needle) return -1;

  let joined = "";
  // Where each item's text begins within `joined`, so a hit maps back.
  const starts: number[] = [];
  for (const item of items) {
    starts.push(joined.length);
    joined += (item.str ?? "").replace(/\s+/g, "").toLowerCase();
  }

  // Try progressively shorter openings. A selection that runs past the bottom
  // of the page — which is exactly when you drag across a page break — has a
  // start on THIS page and a tail that is not here at all, so matching on the
  // whole opening fails while matching on less of it succeeds. Stops well
  // before a fragment short enough to land on the wrong sentence.
  let at = -1;
  for (const len of [60, 40, 24, 12]) {
    if (needle.length < len && len !== 12) continue;
    at = joined.indexOf(needle.slice(0, Math.min(len, needle.length)));
    if (at !== -1) break;
  }
  if (at === -1) return -1;

  // The last item that begins at or before the hit is the one it starts in.
  let idx = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= at) idx = i;
    else break;
  }
  return idx;
}
