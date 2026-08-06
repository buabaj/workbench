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
  defaultHighlightStyle,
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

export const languageCompartment = new Compartment();

/** Theme driven entirely by the locked CSS custom properties. */
const workbenchTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--surface)",
      color: "var(--ink)",
      height: "100%",
      fontSize: "13px",
    },
    ".cm-content": {
      caretColor: "var(--accent)",
      fontFamily: "var(--mono)",
      padding: "16px 0",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor": { borderLeftColor: "var(--accent)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--surface)",
      color: "var(--ink-faint)",
      border: "none",
      fontFamily: "var(--mono)",
      fontSize: "11px",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--surface-raised)",
      color: "var(--ink-muted)",
    },
    ".cm-searchMatch": {
      backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent)",
    },
    ".cm-selectionMatch": {
      backgroundColor: "color-mix(in srgb, var(--link) 15%, transparent)",
    },
  },
  { dark: true },
);

/** Research mode: prose in Source Serif 4, comfortable measure. */
const proseTheme = EditorView.theme(
  {
    ".cm-content": {
      fontFamily: "var(--serif)",
      fontSize: "16.5px",
      lineHeight: "1.65",
      maxWidth: "660px",
      margin: "0 auto",
      padding: "40px 24px 120px",
    },
    ".cm-line": { padding: "0" },
    ".cm-gutters": { display: "none" },
  },
  { dark: true },
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
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
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

export function researchExtensions(): Extension {
  return [
    base,
    proseTheme,
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage, codeLanguages: languages }),
  ];
}

export function isResearchFile(relPath: string): boolean {
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
