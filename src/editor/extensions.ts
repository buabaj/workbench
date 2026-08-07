import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export const languageCompartment = new Compartment();

/**
 * Syntax palette taken from Anthropic's own app-shell CSS: rust keywords and
 * burnt-amber strings rather than the usual blue/purple. It sits inside the
 * warm ivory surface instead of fighting it.
 */
const workbenchHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null], color: "var(--syn-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-function)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--ink-secondary)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--syn-punct)" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--ink)" },
  { tag: t.invalid, color: "var(--error)" },
  // Markdown
  { tag: t.heading, color: "var(--ink)", fontWeight: "600" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "var(--sky)", textDecoration: "underline" },
  { tag: t.monospace, color: "var(--syn-string)" },
  { tag: t.quote, color: "var(--ink-muted)", fontStyle: "italic" },
]);

const workbenchTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--canvas)",
      color: "var(--ink)",
      height: "100%",
      fontSize: "13.5px",
    },
    ".cm-content": {
      caretColor: "var(--clay)",
      fontFamily: "var(--mono)",
      padding: "var(--s-4) 0",
      lineHeight: "1.6",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--clay)", borderLeftWidth: "2px" },
    // Its own token, not the row-tint wash: a selection has to read as one.
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
      backgroundColor: "var(--selection)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--canvas)",
      color: "var(--ink-faint)",
      border: "none",
      fontFamily: "var(--mono)",
      fontSize: "11.5px",
      paddingRight: "var(--s-2)",
    },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink-muted)" },
    ".cm-searchMatch": {
      backgroundColor: "var(--clay-wash)",
      borderRadius: "3px",
      outline: "1px solid var(--clay)",
    },
    ".cm-selectionMatch": { backgroundColor: "#6a9bcc1f", borderRadius: "3px" },
    ".cm-panels": {
      backgroundColor: "var(--surface)",
      color: "var(--ink)",
      borderTop: "1px solid var(--border)",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--canvas)",
      border: "1px solid var(--border)",
      borderRadius: "var(--r-control)",
      boxShadow: "var(--lift)",
      overflow: "hidden",
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "var(--clay-wash)",
      color: "var(--ink)",
    },
  },
  { dark: false },
);

/**
 * Reading mode, kept for the research surface. NOT used for .md files in the
 * editor: a Markdown file being edited is code, and styling it as prose made
 * it unreadable as a file. Rendered output lives in MarkdownPreview instead.
 */
const proseTheme = EditorView.theme(
  {
    ".cm-content": {
      fontFamily: "var(--serif)",
      fontVariationSettings: "'SOFT' 30, 'WONK' 1",
      fontSize: "var(--prose)",
      lineHeight: "var(--lh-prose)",
      maxWidth: "var(--w-prose)",
      margin: "0 auto",
      padding: "var(--s-10) var(--s-6) var(--s-16)",
      letterSpacing: "var(--track-snug)",
    },
    ".cm-line": { padding: "0" },
    ".cm-gutters": { display: "none" },
  },
  { dark: false },
);

const base: Extension = [
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightSelectionMatches(),
  syntaxHighlighting(workbenchHighlight, { fallback: true }),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...historyKeymap,
    ...searchKeymap,
    ...completionKeymap,
    indentWithTab,
  ]),
  workbenchTheme,
];

export function codeExtensions(): Extension {
  return [base, lineNumbers(), highlightActiveLineGutter(), languageCompartment.of([])];
}

export function proseExtensions(): Extension {
  return [
    base,
    proseTheme,
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage, codeLanguages: languages }),
  ];
}

export function isMarkdown(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/** Lazy per-language support for code files; reconfigures the compartment. */
export async function applyLanguage(view: EditorView, relPath: string): Promise<void> {
  const desc = languages.find((d) =>
    d.extensions.some((ext) => relPath.toLowerCase().endsWith(`.${ext}`)),
  );
  if (!desc) return;
  const support = await desc.load();
  view.dispatch({ effects: languageCompartment.reconfigure(support) });
}
