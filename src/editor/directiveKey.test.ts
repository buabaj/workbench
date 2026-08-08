import { EditorState, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { codeExtensions, markdownExtras } from "./extensions";
import { directiveAt } from "../research/agentDirective";

/**
 * ⌘↵ has been broken twice, both times silently: the keystroke inserted a
 * blank line and nothing else happened, which looks identical whether our
 * handler never ran, ran and found nothing, or ran and threw.
 *
 * So the binding itself is tested. CodeMirror's defaultKeymap binds Mod-Enter
 * to insertBlankLine and is provided first, so this is really a test that our
 * precedence still wins — the thing that regressed.
 */
function press(view: EditorView): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function mount(doc: string, onKey: () => boolean) {
  const handler = EditorView.domEventHandlers({
    keydown: (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        if (onKey()) {
          event.preventDefault();
          return true;
        }
      }
      return false;
    },
  });
  return new EditorView({
    state: EditorState.create({
      doc,
      // The markdown stack too, since that is what a note actually gets.
      extensions: [codeExtensions(), ...markdownExtras, Prec.highest(handler)],
    }),
    parent: document.body,
  });
}

describe("⌘↵ in the editor", () => {
  it("reaches our handler despite defaultKeymap binding Mod-Enter", () => {
    let ran = false;
    const view = mount("hello @agent[greet back]", () => {
      ran = true;
      return true;
    });
    press(view);
    expect(ran).toBe(true);
    view.destroy();
  });

  /** Consuming it must stop insertBlankLine, or the note gains a stray line. */
  it("does not also insert a line when the handler consumes it", () => {
    const doc = "hello @agent[greet back]";
    const view = mount(doc, () => true);
    press(view);
    expect(view.state.doc.toString()).toBe(doc);
    view.destroy();
  });

  /**
   * With nothing to run the event must not be consumed, so the editor's own
   * binding can have it. Asserted on preventDefault rather than on the
   * document, because a synthetic keydown in jsdom does not drive
   * CodeMirror's keymap the way a real one does.
   */
  it("does not consume the event when the handler declines", () => {
    const view = mount("just prose", () => false);
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    view.destroy();
  });
});


/**
 * The whole chain, with the real parser rather than a stub: a note, the
 * markdown extensions a note really gets, and the keystroke. If this passes
 * and the app still does nothing, the fault is not in this code path.
 */
describe("⌘↵ end to end with the real parser", () => {
  const run = (doc: string, caretAt: number) => {
    let found: string | null = null;
    const view = mount(doc, () => {
      const d = directiveAt(view.state.doc.toString(), view.state.selection.main.head);
      if (!d) return false;
      found = d.instruction;
      return true;
    });
    view.dispatch({ selection: { anchor: caretAt } });
    press(view);
    view.destroy();
    return found;
  };

  it("finds a directive on its own line in a note", () => {
    const doc = "# Paper\n\n## Notes\n\n@agent[summarise the method]\n";
    expect(run(doc, doc.indexOf("summarise"))).toBe("summarise the method");
  });

  it("finds one written mid-sentence", () => {
    const doc = "hello @agent[greet back]";
    expect(run(doc, doc.length)).toBe("greet back");
  });

  it("finds one in a note that already has frontmatter and a full-text section", () => {
    const doc = [
      "---",
      "title: A Paper",
      "pdf: papers/pdf/x.pdf",
      "tags: [paper]",
      "---",
      "",
      "## Notes",
      "",
      "@agent[what is the reward model]",
      "",
      "## Full text",
      "",
      "lots of extracted text here",
    ].join("\n");
    expect(run(doc, doc.indexOf("what is"))).toBe("what is the reward model");
  });

  it("declines when the note has none", () => {
    expect(run("just my own writing", 5)).toBeNull();
  });
});
