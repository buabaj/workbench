import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { findAgentSpans } from "../research/provenance";

/**
 * Show which prose a model wrote, while you are writing beside it.
 *
 * The markers are HTML comments so the file stays portable, which also makes
 * them invisible in every other markdown tool — and invisible is exactly what
 * this text must not be here. A left rule and a small label put the
 * distinction back in front of you at the moment it matters: when you are
 * deciding whether to build on a sentence or check it first.
 *
 * The markers themselves are dimmed rather than hidden. Hiding them would let
 * you delete one by accident and silently reclassify everything after it as
 * your own.
 */

const generatedLine = Decoration.line({ class: "cm-agent-line" });
const markerLine = Decoration.line({ class: "cm-agent-marker" });

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const spans = findAgentSpans(doc.toString());

  for (const span of spans) {
    const openLine = doc.lineAt(span.start);
    const closeLine = doc.lineAt(Math.min(span.end, doc.length) - 1);

    // Line decorations must be added in document order, or RangeSetBuilder
    // throws — so each span is emitted top to bottom, marker first.
    for (let n = openLine.number; n <= closeLine.number; n++) {
      const line = doc.line(n);
      const isMarker = n === openLine.number || n === closeLine.number;
      builder.add(line.from, line.from, isMarker ? markerLine : generatedLine);
    }
  }
  return builder.finish();
}

export function provenanceHighlight(): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = build(view);
        }
        update(u: ViewUpdate) {
          // Only on a real change or a viewport move: rebuilding on every
          // cursor tick would rescan the document for each keystroke.
          if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
        }
      },
      { decorations: (v) => v.decorations },
    ),
    EditorView.baseTheme({
      ".cm-agent-line": {
        backgroundColor: "color-mix(in srgb, var(--clay) 7%, transparent)",
        borderLeft: "2px solid var(--clay)",
        paddingLeft: "6px",
      },
      ".cm-agent-marker": {
        backgroundColor: "color-mix(in srgb, var(--clay) 4%, transparent)",
        borderLeft: "2px solid var(--clay)",
        paddingLeft: "6px",
        opacity: "0.5",
        fontSize: "0.85em",
      },
    }),
  ];
}
