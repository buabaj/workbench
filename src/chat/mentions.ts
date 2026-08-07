/**
 * `@`-references to workspace files, in the composer.
 *
 * Typing `@des` offers `design/DESIGN.md`; picking it puts `@design/DESIGN.md`
 * in the message. The mention stays visible in the transcript — it is how the
 * user said it — and `referenceFooter` turns it into absolute paths for the
 * agent, so "look at @DESIGN.md" does not depend on the agent guessing which
 * of several similarly-named files was meant.
 *
 * All of this is pure string work, deliberately: it is the part that is easy
 * to get subtly wrong (caret handling, paths with dots, an email address that
 * is not a mention) and the part that is cheap to test.
 */

export interface MentionQuery {
  /** Text between the `@` and the caret. */
  query: string;
  /** Index of the `@`. */
  start: number;
  /** Caret index — the end of the token. */
  end: number;
}

/**
 * The `@`-token the caret sits in, if any.
 *
 * Requires the `@` to start a word, so `user@example.com` is not a mention.
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  if (caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;

  // A mention starts a word: beginning of input, or after whitespace.
  const prev = at > 0 ? before[at - 1] : "";
  if (prev && !/\s/.test(prev)) return null;

  const query = before.slice(at + 1);
  // Whitespace ends the token; the caret has moved past the mention.
  if (/\s/.test(query)) return null;
  return { query, start: at, end: caret };
}

/** Replace the `@`-token at the caret with a chosen path, and say where the caret lands. */
export function applyMention(
  text: string,
  q: MentionQuery,
  path: string,
): { text: string; caret: number } {
  const insert = `@${path} `;
  const next = text.slice(0, q.start) + insert + text.slice(q.end);
  return { text: next, caret: q.start + insert.length };
}

/**
 * Every `@path` in a message, in order, without duplicates.
 *
 * Trailing punctuation is trimmed so "check @src/main.rs, then…" resolves.
 */
export function extractMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Preceded by start-of-string or whitespace, so emails are excluded.
  const re = /(^|\s)@([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = m[2].replace(/[.,;:!?)\]}]+$/, "");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * The block appended to a message so the agent knows exactly what was meant.
 *
 * Absolute paths, because a relative one is ambiguous the moment the agent
 * changes directory, and because being explicit here is cheaper than a tool
 * call spent searching for the file.
 */
export function referenceFooter(text: string, workspaceRoot: string): string {
  const mentions = extractMentions(text);
  if (mentions.length === 0) return "";
  const root = workspaceRoot.replace(/\/+$/, "");
  const lines = mentions.map((p) => `- ${root}/${p.replace(/^\/+/, "")}`);
  return [
    mentions.length === 1
      ? "The user referenced this file. Read it before answering:"
      : "The user referenced these files. Read them before answering:",
    ...lines,
  ].join("\n");
}
