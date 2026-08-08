/**
 * Adding a section to a note without disturbing what is already there.
 *
 * Both capabilities that write into a note — a summary, a suggested link — put
 * their result under a named heading, and both have to answer the same
 * question: is that heading already there? Appending a second `## Summary`
 * every time is how a note fills with duplicates, and rewriting the whole
 * document to avoid it is how the surrounding text gets mangled.
 *
 * So the rule is narrow and boring: find the heading, act inside it, and touch
 * nothing else. If it is absent, add it at the end.
 */

/** Where a `## Heading` section starts and ends, by character offset. */
function findSection(text: string, heading: string): { start: number; end: number } | null {
  // Any level, so a note that uses `#` or `###` for its sections is still
  // recognised rather than given a second one at a different depth.
  const re = new RegExp(`^#{1,6}\\s+${heading}\\s*$`, "im");
  const m = re.exec(text);
  if (!m) return null;

  const bodyStart = m.index + m[0].length;
  // The section ends at the next heading of any level, or at the end.
  const next = /^#{1,6}\s+\S/m.exec(text.slice(bodyStart));
  return {
    start: m.index,
    end: next ? bodyStart + next.index : text.length,
  };
}

/**
 * Replace a section's body, or add the section at the end.
 *
 * Replacing rather than appending is right for a summary: a second summary of
 * the same note supersedes the first, and keeping both just makes you read two.
 */
export function withSection(text: string, heading: string, body: string): string {
  const found = findSection(text, heading);
  const section = `## ${heading}\n\n${body.trim()}\n`;
  if (!found) {
    const base = text.replace(/\s*$/, "");
    return base ? `${base}\n\n${section}` : section;
  }
  const before = text.slice(0, found.start);
  const after = text.slice(found.end);
  // Keep whatever followed exactly as it was, including the blank line that
  // separated it from this section.
  return `${before}${section}${after.startsWith("\n") ? "" : "\n"}${after}`;
}

/**
 * Add `- [[name]]` to a bulleted section, once.
 *
 * Unlike a summary this accumulates — links are a growing list, not a single
 * answer — so an existing link is left alone rather than added twice.
 */
export function withListItem(text: string, heading: string, name: string): string {
  const item = `- [[${name}]]`;
  const found = findSection(text, heading);
  if (!found) {
    const base = text.replace(/\s*$/, "");
    const section = `## ${heading}\n\n${item}\n`;
    return base ? `${base}\n\n${section}` : section;
  }

  const body = text.slice(found.start, found.end);
  // Already there in some form — `[[Name]]` or `[[Name|alias]]`.
  const already = new RegExp(`\\[\\[\\s*${escapeRe(name)}\\s*(\\||\\]\\])`, "i").test(body);
  if (already) return text;

  const trimmed = body.replace(/\s*$/, "");
  return `${text.slice(0, found.start)}${trimmed}\n${item}\n${text.slice(found.end)}`;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
