import type { CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { useWorkspace } from "../store/workspace";
import { noteName } from "../research/wikilinks";

/**
 * `[[` autocomplete over the vault.
 *
 * Notes come from the store rather than a fresh scan on every keystroke: the
 * vault is already read for backlinks, and re-reading it per character would
 * make typing the slowest thing in the app.
 *
 * Offers notes that do NOT exist too — a name you have linked elsewhere but
 * not yet written. In a vault those are real destinations; refusing to
 * complete them would push you back to typing the name exactly.
 */
/**
 * Registered through markdown's language data rather than a second
 * `autocompletion()`: the base extensions already configure one, and two
 * configs contend over `override`.
 */
export function wikiSource(notePaths: () => string[]): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    // Everything since the last `[[` on this line, with no `]` between —
    // so a completed link stops offering suggestions.
    const before = ctx.matchBefore(/\[\[[^\]\n]*/);
    if (!before) return null;
    if (before.from === before.to && !ctx.explicit) return null;

    const typed = before.text.slice(2).toLowerCase();
    const paths = notePaths();
    const seen = new Set<string>();
    const options = [];

    for (const path of paths) {
      const name = noteName(path);
      if (seen.has(name)) continue;
      if (typed && !name.toLowerCase().includes(typed)) continue;
      seen.add(name);
      options.push({
        label: name,
        detail: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined,
        type: "text",
        // Close the brackets, so accepting a suggestion leaves a finished
        // link rather than something to tidy up.
        apply: `${name}]]`,
      });
    }

    return {
      from: before.from + 2,
      options: options.slice(0, 30),
      // Let CodeMirror narrow the list as more is typed rather than
      // re-querying, since the source cannot change mid-word.
      validFor: /^[^\]\n]*$/,
    };
  };
}

/** The vault's note paths, read live from the workspace store. */
export function vaultNotePaths(): string[] {
  const byPath = useWorkspace.getState().childrenByPath;
  const out: string[] = [];
  for (const nodes of Object.values(byPath)) {
    for (const n of nodes) {
      if (!n.isDir && /\.(md|markdown)$/i.test(n.relPath)) out.push(n.relPath);
    }
  }
  return out;
}
