/**
 * `[[wikilinks]]` — the connective tissue of a note vault.
 *
 * Deliberately Obsidian's syntax rather than a new one: it is what people
 * already type, and a vault written here should stay readable in any other
 * markdown tool. That also fixes the semantics for us — a link names a note,
 * not a path, and resolution is by name with the extension implied.
 *
 * All pure string work, and tested as such. Link resolution is where a notes
 * app is quietly wrong for months: a link that silently points nowhere looks
 * identical to one that works until you click it.
 */

export interface WikiLink {
  /** The note being referenced, as written, without alias or heading. */
  target: string;
  /** `[[note#heading]]` — the section, if one was named. */
  heading?: string;
  /** `[[note|shown text]]` — what to display instead of the target. */
  alias?: string;
  /** Offsets of the whole `[[...]]` in the source, for rendering. */
  start: number;
  end: number;
}

/** Every `[[link]]` in a document, in source order, including repeats. */
export function parseWikiLinks(text: string): WikiLink[] {
  const out: WikiLink[] = [];
  // Non-greedy, and no `[` or `]` inside, so `[[a]] [[b]]` is two links and an
  // unclosed `[[` never swallows the rest of the file.
  const re = /\[\[([^\[\]]+?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const body = m[1];
    // Order matters: `[[note#heading|alias]]` is the canonical form, so the
    // alias is split off first and the heading taken from what remains.
    const pipe = body.indexOf("|");
    const alias = pipe === -1 ? undefined : body.slice(pipe + 1).trim();
    const beforeAlias = pipe === -1 ? body : body.slice(0, pipe);
    const hash = beforeAlias.indexOf("#");
    const heading = hash === -1 ? undefined : beforeAlias.slice(hash + 1).trim();
    const target = (hash === -1 ? beforeAlias : beforeAlias.slice(0, hash)).trim();
    if (!target && !heading) continue; // `[[]]` or `[[|x]]` names nothing
    out.push({
      target,
      heading: heading || undefined,
      alias: alias || undefined,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

/** The text a link should display. */
export function linkLabel(link: WikiLink): string {
  if (link.alias) return link.alias;
  if (!link.target && link.heading) return `#${link.heading}`;
  return link.heading ? `${link.target} › ${link.heading}` : link.target;
}

/** A note's name as a link would write it: no directories, no extension. */
export function noteName(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return base.replace(/\.(md|markdown)$/i, "");
}

/**
 * Resolve a link target to a note path.
 *
 * Matching is by name and case-insensitive, because that is how people type.
 * A target containing a slash is treated as a path, so two notes with the same
 * name in different folders can still be told apart — the escape hatch for the
 * ambiguity that name-matching creates.
 */
export function resolveLink(target: string, notePaths: string[]): string | null {
  if (!target) return null;
  const wanted = target.toLowerCase().replace(/\.(md|markdown)$/i, "");

  if (target.includes("/")) {
    const byPath = notePaths.find(
      (p) => p.toLowerCase().replace(/\.(md|markdown)$/i, "") === wanted,
    );
    if (byPath) return byPath;
  }
  // Exact name match first; a shorter path wins so a top-level note beats one
  // buried in an archive folder.
  const matches = notePaths.filter((p) => noteName(p).toLowerCase() === wanted);
  if (matches.length > 0) {
    return [...matches].sort((a, b) => a.length - b.length)[0];
  }
  return null;
}

export interface Backlink {
  /** The note containing the link. */
  from: string;
  /** The line it appears on, 1-indexed. */
  line: number;
  /** The surrounding line, for context in the panel. */
  context: string;
}

/**
 * Which notes link to `target`, with the line each mention sits on.
 *
 * A backlink without its sentence is just a filename; the context line is what
 * makes the panel worth reading.
 */
export function backlinksTo(
  targetPath: string,
  docs: Array<{ relPath: string; text: string }>,
  notePaths: string[],
): Backlink[] {
  const out: Backlink[] = [];
  for (const doc of docs) {
    if (doc.relPath === targetPath) continue; // a note does not link to itself
    const links = parseWikiLinks(doc.text);
    if (links.length === 0) continue;
    const lineStarts = lineOffsets(doc.text);
    for (const link of links) {
      if (resolveLink(link.target, notePaths) !== targetPath) continue;
      const line = lineNumberAt(lineStarts, link.start);
      out.push({
        from: doc.relPath,
        line,
        context: doc.text.split("\n")[line - 1]?.trim() ?? "",
      });
    }
  }
  return out;
}

/** Targets that resolve to nothing — the notes a vault is asking to have. */
export function unresolvedTargets(
  docs: Array<{ relPath: string; text: string }>,
  notePaths: string[],
): string[] {
  const seen = new Set<string>();
  for (const doc of docs) {
    for (const link of parseWikiLinks(doc.text)) {
      if (!link.target) continue;
      if (resolveLink(link.target, notePaths)) continue;
      seen.add(link.target);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function lineOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineNumberAt(lineStarts: number[], offset: number): number {
  // Binary search: a large vault re-scans this for every link.
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
