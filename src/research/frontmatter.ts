/**
 * Reading YAML frontmatter, without a YAML parser.
 *
 * Only scalar top-level fields are needed — `pdf:`, `title:`, `year:` — and
 * pulling in a parser to read them would be more surface than the job asks
 * for. The trade is explicit: nested maps and multi-line scalars are not
 * supported and must not appear to be.
 */

/** The frontmatter block's raw body, or null when the note has none. */
export function frontmatterBlock(text: string): string | null {
  // Must be the very first thing in the file: a `---` further down is a
  // horizontal rule, not metadata.
  if (!text.startsWith("---")) return null;
  const afterOpen = text.indexOf("\n");
  if (afterOpen === -1) return null;
  // The opening line must be exactly `---`, or `--- something` would qualify.
  if (text.slice(0, afterOpen).trim() !== "---") return null;

  const rest = text.slice(afterOpen + 1);
  const close = rest.search(/^---\s*$/m);
  if (close === -1) return null;
  return rest.slice(0, close);
}

/**
 * A top-level scalar field's value, unquoted.
 *
 * Returns null for a field that is absent, empty, or a list — a caller that
 * asked for a scalar should not silently receive the word "-".
 */
export function frontmatterField(text: string, key: string): string | null {
  const block = frontmatterBlock(text);
  if (block === null) return null;

  for (const line of block.split("\n")) {
    // Indented lines belong to the field above, not to the top level.
    if (/^\s/.test(line)) continue;
    const at = line.indexOf(":");
    if (at === -1) continue;
    if (line.slice(0, at).trim() !== key) continue;

    let value = line.slice(at + 1).trim();
    if (!value) return null; // `key:` with a list or block beneath it
    // Strip one layer of quoting, which `note_for` adds to anything
    // containing a colon — which is most paper titles.
    const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
    if (quoted) value = quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    return value || null;
  }
  return null;
}
